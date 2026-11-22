import { Innertube, Log } from 'youtubei.js';
import { extractSearchPage, type RawSearchPage, type SearchResult } from './youtube-search.js';
import { extractTrending } from './youtube-trending.js';

/** The "Videos" search filter, as youtubei.js and yt-dlp send it. */
const VIDEO_SEARCH_PARAMS = 'EgIQAQ%3D%3D';

const YOUTUBE_STREAM_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-us,en;q=0.5',
  'Sec-Fetch-Mode': 'navigate',
};

// YouTube's Apple Vision Pro app, as yt-dlp describes it.
const VISIONOS_CLIENT = {
  clientName: 'VISIONOS',
  clientVersion: '1.02',
  deviceMake: 'Apple',
  deviceModel: 'RealityDevice17,1',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  osName: 'visionOS',
  osVersion: '26.5.23O471',
};

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
  private searchPageCache = new Map<string, { pages: RawSearchPage[]; cachedAt: number }>();
  private trendingCache: { items: SearchResult[]; cachedAt: number } | null = null;

  /** `fetchImpl` replaces the global fetch (the in-app providers use the app's own). */
  constructor(private readonly fetchImpl?: typeof fetch) {}

  private async getClient(): Promise<Innertube> {
    if (!this.yt) {
      // youtubei.js warns on every view-model it can't type-check (dozens per
      // page in YouTube's newer layouts); real failures still throw.
      Log.setLevel(Log.Level.ERROR);
      this.yt = await Innertube.create({
        lang: 'en',
        location: 'US',
        retrieve_player: true,
        ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
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
      this.failCount = 0;
      this.healthy = true;
      if (!results) {
        return { items: [], has_more: false };
      }
      return { items: results.items, has_more: !!results.continuation };
    } catch (err) {
      this.failCount++;
      if (this.failCount >= 3) this.healthy = false;
      throw err;
    }
  }

  /** YouTube Music's Trending songs, fetched at most every half hour. */
  async trending(): Promise<{ items: SearchResult[] }> {
    if (this.trendingCache && Date.now() - this.trendingCache.cachedAt < 30 * 60 * 1000) {
      return { items: this.trendingCache.items };
    }
    const yt = await this.getClient();
    const response = await yt.actions.execute('/browse', { browseId: 'FEmusic_explore', client: 'YTMUSIC' });
    const items = extractTrending(response.data);
    if (!items.length) {
      const keys = Object.keys((response.data ?? {}) as object).join(', ');
      console.error(`YouTube Music Explore had no Trending songs (response keys: ${keys})`);
    } else {
      this.trendingCache = { items, cachedAt: Date.now() };
    }
    return { items };
  }

  private async getVideoSearchPage(query: string, page: number): Promise<RawSearchPage | null> {
    const cacheKey = normalizeSearchKey(query);
    let cachedPages = this.getCachedSearchPages(cacheKey);
    if (!cachedPages) {
      cachedPages = [await this.fetchSearchPage({ query, params: VIDEO_SEARCH_PARAMS }, query)];
      this.setCachedSearchPages(cacheKey, cachedPages);
    }

    while (cachedPages.length <= page) {
      const continuation = cachedPages[cachedPages.length - 1]?.continuation;
      if (!continuation) {
        return null;
      }
      cachedPages.push(await this.fetchSearchPage({ continuation }, query));
      this.setCachedSearchPages(cacheKey, cachedPages);
    }

    return cachedPages[page] ?? null;
  }

  /** One raw /search request, read by youtube-search.ts rather than youtubei.js's parser. */
  private async fetchSearchPage(body: Record<string, string>, query: string): Promise<RawSearchPage> {
    const yt = await this.getClient();
    const response = await yt.actions.execute('/search', body);
    const page = extractSearchPage(response.data);
    if (!page.items.length && !body.continuation) {
      // Usually a real "no results"; if YouTube changed its layout again,
      // these keys say where the results moved to.
      const keys = Object.keys((response.data ?? {}) as object).join(', ');
      console.error(`YouTube search for "${query}" read no videos (response keys: ${keys})`);
    }
    return page;
  }

  private getCachedSearchPages(queryKey: string): RawSearchPage[] | null {
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

  private setCachedSearchPages(queryKey: string, pages: RawSearchPage[]): void {
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

  /**
   * Asks for the stream as YouTube's Apple Vision Pro app. Since late October
   * 2026 YouTube cuts the other app clients' streams off after 1 MB unless a
   * proof-of-origin token is sent; this client still gets whole streams
   * without one (it is yt-dlp's default token-free client too).
   */
  private visitor: { data: string; fetchedAt: number } | null = null;

  /**
   * The visitor ID youtube.com hands a new visitor. Read from the page like
   * yt-dlp does: the web build of youtubei.js makes one up locally, and
   * YouTube serves only the first megabyte of streams asked for with that.
   */
  private async visitorData(yt: Innertube): Promise<string | undefined> {
    if (this.visitor && Date.now() - this.visitor.fetchedAt < 60 * 60 * 1000) {
      return this.visitor.data;
    }
    try {
      const doFetch = this.fetchImpl ?? fetch;
      const page = await (
        await doFetch('https://www.youtube.com/', {
          headers: { 'User-Agent': VISIONOS_CLIENT.userAgent, 'Accept-Language': 'en-US,en;q=0.9' },
        })
      ).text();
      const data = page.match(/"VISITOR_DATA":"([^"]+)"/)?.[1];
      if (data) {
        this.visitor = { data, fetchedAt: Date.now() };
        return data;
      }
    } catch (err) {
      console.error(`could not read YouTube visitor data: ${err}`);
    }
    return (yt.session.context.client as { visitorData?: string }).visitorData;
  }

  private async resolveVisionOs(yt: Innertube, sourceId: string): Promise<StreamInfo> {
    const visitorData = await this.visitorData(yt);
    const client = { ...VISIONOS_CLIENT, hl: 'en', gl: 'US', ...(visitorData ? { visitorData } : {}) };
    const doFetch = this.fetchImpl ?? fetch;
    const response = await doFetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': VISIONOS_CLIENT.userAgent,
        'X-YouTube-Client-Name': '101',
        'X-YouTube-Client-Version': VISIONOS_CLIENT.clientVersion,
        Origin: 'https://www.youtube.com',
        ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {}),
      },
      body: JSON.stringify({ context: { client }, videoId: sourceId, contentCheckOk: true, racyCheckOk: true }),
    });
    if (!response.ok) {
      throw new Error(`YouTube player request failed: HTTP ${response.status}`);
    }
    const player = (await response.json()) as any;
    const status = player?.playabilityStatus;
    if (status?.status !== 'OK') {
      throw new Error(status?.reason || `YouTube says ${status?.status ?? 'unplayable'}`);
    }
    const formats = ((player.streamingData?.adaptiveFormats ?? []) as any[]).filter(
      (f) => typeof f.url === 'string' && String(f.mimeType).startsWith('audio/mp4'),
    );
    // AAC-LC (itag 140) decodes everywhere; otherwise the highest bitrate.
    formats.sort((a, b) => Number(b.itag === 140) - Number(a.itag === 140) || (b.bitrate ?? 0) - (a.bitrate ?? 0));
    const format = formats[0];
    if (!format) {
      throw new Error('YouTube returned no playable audio for this video');
    }
    const durationMs = Number(format.approxDurationMs) || null;
    return {
      url: format.url,
      headers: { 'User-Agent': VISIONOS_CLIENT.userAgent },
      expires_at: inferExpiry(format.url) ?? Date.now() + 6 * 60 * 60 * 1000,
      mime_type: 'audio/mp4',
      codec: extractCodec(format.mimeType) ?? null,
      bitrate: format.averageBitrate ?? format.bitrate ?? null,
      duration_ms: durationMs,
      is_seekable: false,
      needs_refresh: true,
    };
  }

  async resolveStream(sourceId: string): Promise<StreamInfo> {
    try {
      const yt = await this.getClient();

      try {
        const stream = await this.resolveVisionOs(yt, sourceId);
        this.failCount = 0;
        this.healthy = true;
        return stream;
      } catch (err) {
        console.error(`visionOS stream lookup failed, trying other clients: ${err}`);
      }

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

function normalizeSearchKey(query: string): string {
  return query.trim().toLowerCase();
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
