import { Innertube } from 'youtubei.js';

const YOUTUBE_STREAM_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-us,en;q=0.5',
  'Sec-Fetch-Mode': 'navigate',
};

interface SearchResult {
  source: string;
  source_id: string;
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
  cover_art_url: string | null;
  source_url: string | null;
  play_count: number | null;
}

interface StreamInfo {
  url: string;
  headers: Record<string, string>;
  expires_at: number | null;
  mime_type: string;
  codec: string | null;
  bitrate: number | null;
  duration_ms: number | null;
  is_seekable: boolean;
  needs_refresh: boolean;
}

interface TrackMetadata {
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
  cover_art_url: string | null;
  year: number | null;
  genre: string | null;
}

export class YouTubeProvider {
  private static readonly SEARCH_CACHE_LIMIT = 8;
  private static readonly SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;

  private yt: Innertube | null = null;
  private healthy = true;
  private failCount = 0;
  private searchPageCache = new Map<string, { pages: any[]; cachedAt: number }>();

  private async getClient(): Promise<Innertube> {
    if (!this.yt) {
      this.yt = await Innertube.create({
        lang: 'en',
        location: 'US',
        retrieve_player: true,
      });
    }
    return this.yt;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async search(query: string, page: number): Promise<{ items: SearchResult[]; has_more: boolean }> {
    try {
      const results = await this.getVideoSearchPage(query, page);
      if (!results) {
        return { items: [], has_more: false };
      }

      const items = dedupeSearchResults(
        (results.videos as any[]).map((video) => {
          const videoId = video.video_id || video.id;
          if (!videoId) return null;

          return {
            source: 'youtube',
            source_id: videoId,
            title: video.title?.toString?.() || 'Unknown',
            artist: video.author?.name || video.byline_text?.toString?.() || 'Unknown',
            album: null,
            duration_ms:
              typeof video.duration?.seconds === 'number'
                ? video.duration.seconds * 1000
                : parseDuration(video.length_text?.toString?.() || video.duration?.text),
            cover_art_url: video.best_thumbnail?.url || video.thumbnails?.[0]?.url || null,
            source_url: `https://www.youtube.com/watch?v=${videoId}`,
            play_count: parseCountText(video.view_count?.toString?.() || video.short_view_count?.toString?.()),
          } satisfies SearchResult;
        })
      );

      this.failCount = 0;
      this.healthy = true;

      return { items, has_more: results.has_continuation };
    } catch (err) {
      this.failCount++;
      if (this.failCount >= 3) this.healthy = false;
      throw err;
    }
  }

  private async getVideoSearchPage(query: string, page: number): Promise<any | null> {
    const yt = await this.getClient();
    const cacheKey = normalizeSearchKey(query);
    let cachedPages = this.getCachedSearchPages(cacheKey);
    if (!cachedPages) {
      cachedPages = [await yt.search(query, { type: 'video' })];
      this.setCachedSearchPages(cacheKey, cachedPages);
    }

    while (cachedPages.length <= page) {
      const current = cachedPages[cachedPages.length - 1];
      if (!current?.has_continuation) {
        return null;
      }
      cachedPages.push(await current.getContinuation());
      this.setCachedSearchPages(cacheKey, cachedPages);
    }

    return cachedPages[page] ?? null;
  }

  private getCachedSearchPages(queryKey: string): any[] | null {
    const entry = this.searchPageCache.get(queryKey);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > YouTubeProvider.SEARCH_CACHE_TTL_MS) {
      this.searchPageCache.delete(queryKey);
      return null;
    }

    this.searchPageCache.delete(queryKey);
    this.searchPageCache.set(queryKey, {
      pages: entry.pages,
      cachedAt: Date.now(),
    });
    return entry.pages;
  }

  private setCachedSearchPages(queryKey: string, pages: any[]): void {
    if (this.searchPageCache.has(queryKey)) {
      this.searchPageCache.delete(queryKey);
    }

    this.searchPageCache.set(queryKey, {
      pages,
      cachedAt: Date.now(),
    });

    while (this.searchPageCache.size > YouTubeProvider.SEARCH_CACHE_LIMIT) {
      const oldestKey = this.searchPageCache.keys().next().value;
      if (!oldestKey) break;
      this.searchPageCache.delete(oldestKey);
    }
  }

  async resolveStream(sourceId: string): Promise<StreamInfo> {
    try {
      const yt = await this.getClient();

      const format = await yt.getStreamingData(sourceId, {
        client: 'ANDROID_VR',
        type: 'audio',
        quality: 'best',
        format: 'mp4',
      }).catch(() =>
        yt.getStreamingData(sourceId, {
          client: 'IOS',
          type: 'audio',
          quality: 'best',
          format: 'mp4',
        })
      );

      // getStreamingData already calls format.decipher() internally and sets format.url.
      // Do not call decipher again — the URL is already resolved.
      const url = format.url;
      const mimeType = inferMimeType(format.mime_type);

      if (!url) {
        throw new Error('youtubei.js returned an empty stream URL');
      }
      if (mimeType !== 'audio/mp4') {
        throw new Error(`youtubei.js returned unsupported YouTube audio format: ${mimeType}`);
      }

      const expiresAt = inferExpiry(url) ?? Date.now() + 6 * 60 * 60 * 1000;
      const codec = extractCodec(format.mime_type) ?? null;
      const durationMs = format.approx_duration_ms > 0 ? format.approx_duration_ms : null;

      this.failCount = 0;
      this.healthy = true;

      return {
        url,
        headers: YOUTUBE_STREAM_HEADERS,
        expires_at: expiresAt,
        mime_type: mimeType,
        codec,
        bitrate: format.average_bitrate ?? format.bitrate ?? null,
        duration_ms: durationMs,
        is_seekable: false,
        needs_refresh: true,
      };
    } catch (err) {
      this.failCount++;
      if (this.failCount >= 3) this.healthy = false;
      throw err;
    }
  }

  async getMetadata(sourceId: string): Promise<TrackMetadata> {
    const yt = await this.getClient();
    const info = await yt.getBasicInfo(sourceId);
    const basic = info.basic_info;

    return {
      title: basic.title || 'Unknown',
      artist: basic.author || 'Unknown',
      album: null,
      duration_ms: basic.duration ? basic.duration * 1000 : null,
      cover_art_url: basic.thumbnail?.[0]?.url || null,
      year: null,
      genre: null,
    };
  }
}

function parseDuration(text: string | undefined): number | null {
  if (!text) return null;
  const parts = text.split(':').map(Number);
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  return null;
}

function normalizeSearchKey(query: string): string {
  return query.trim().toLowerCase();
}

function dedupeSearchResults(results: Array<SearchResult | null>): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];

  for (const result of results) {
    if (!result) continue;
    if (seen.has(result.source_id)) continue;
    seen.add(result.source_id);
    deduped.push(result);
  }

  return deduped;
}

function parseCountText(text: string | undefined): number | null {
  if (!text) return null;
  const match = text
    .replace(/,/g, '')
    .match(/(\d+(?:\.\d+)?)\s*([KMBT])?\s*(?:plays|play|views|view)?/i);

  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;

  const multiplier = match[2]?.toUpperCase();
  switch (multiplier) {
    case 'K':
      return Math.round(value * 1_000);
    case 'M':
      return Math.round(value * 1_000_000);
    case 'B':
      return Math.round(value * 1_000_000_000);
    case 'T':
      return Math.round(value * 1_000_000_000_000);
    default:
      return Math.round(value);
  }
}

/**
 * Extracts the expiry timestamp (in ms) from a YouTube stream URL's `expire` query param.
 * Returns null if the param is absent or unparseable.
 */
function inferExpiry(url: string): number | null {
  try {
    const parsed = new URL(url);
    const expireParam = parsed.searchParams.get('expire');
    if (!expireParam) return null;
    const seconds = Number(expireParam);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Normalises a raw mime_type string like `audio/webm; codecs="opus"` to a bare MIME type.
 */
function inferMimeType(rawMime: string): string {
  const base = rawMime.split(';')[0].trim().toLowerCase();
  if (base === 'audio/webm') return 'audio/webm';
  if (base === 'audio/mp4') return 'audio/mp4';
  if (base === 'audio/mpeg') return 'audio/mpeg';
  return base || 'audio/mpeg';
}

/**
 * Extracts the codec string from a mime_type like `audio/webm; codecs="opus"`.
 * Returns null if no codec is specified.
 */
function extractCodec(rawMime: string): string | null {
  const match = rawMime.match(/codecs="?([^"]+)"?/i);
  return match ? match[1].trim() : null;
}
