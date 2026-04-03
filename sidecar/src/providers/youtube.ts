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
  private yt: Innertube | null = null;
  private healthy = true;
  private failCount = 0;

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
      const yt = await this.getClient();
      const results = await yt.music.search(query, { type: 'song' });
      const items: SearchResult[] = [];

      const contents = results.contents;
      if (contents) {
        for (const shelf of contents) {
          if ('contents' in shelf) {
            for (const item of (shelf as any).contents || []) {
              if (item.type === 'MusicResponsiveListItem') {
                const videoId = item.id || item.overlay?.content?.video_id;
                if (!videoId) continue;

                const title = item.title?.toString() || item.flex_columns?.[0]?.title?.toString() || 'Unknown';
                const artist = item.artists?.[0]?.name || item.flex_columns?.[1]?.title?.toString() || 'Unknown';
                const album = item.album?.name || null;
                const durationText = item.duration?.text || item.duration?.seconds;
                const durationMs = typeof durationText === 'number' ? durationText * 1000 : parseDuration(durationText);
                const thumbnail = item.thumbnails?.[0]?.url || item.thumbnail?.contents?.[0]?.url || null;

                items.push({
                  source: 'youtube',
                  source_id: videoId,
                  title,
                  artist,
                  album,
                  duration_ms: durationMs,
                  cover_art_url: thumbnail,
                  source_url: `https://music.youtube.com/watch?v=${videoId}`,
                  play_count: parseCountText(item.views ?? item.view_count ?? item.subtitle?.toString()),
                });
              }
            }
          }
        }
      }

      this.failCount = 0;
      this.healthy = true;

      return { items, has_more: items.length >= 20 };
    } catch (err) {
      this.failCount++;
      if (this.failCount >= 3) this.healthy = false;
      throw err;
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
