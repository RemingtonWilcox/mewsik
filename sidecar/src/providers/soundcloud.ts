// SoundCloud provider — uses soundcloud-fetch
import type { IncomingMessage, ServerResponse } from 'node:http';
import SoundCloud, { type Track, type MediaTranscoding, type StreamingData } from 'soundcloud-fetch';

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

export class SoundCloudProvider {
  private client: SoundCloud | null = null;
  private healthy = true;
  private failCount = 0;
  private proxyBaseUrl: string | null = null;

  private getClient(): SoundCloud {
    if (!this.client) {
      this.client = new SoundCloud();
    }
    return this.client;
  }

  private markHealthy() {
    this.failCount = 0;
    this.healthy = true;
  }

  private markFailure() {
    this.failCount++;
    if (this.failCount >= 3) {
      this.healthy = false;
    }
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  setProxyBaseUrl(proxyBaseUrl: string) {
    this.proxyBaseUrl = proxyBaseUrl;
  }

  private unplayableReason(track: Track): string | null {
    if (track.isBlocked || track.playbackInfo?.policy === 'BLOCK') {
      return 'This SoundCloud track is blocked or requires access that SoundCloud does not expose to the app';
    }

    if (track.isSnipped) {
      return 'SoundCloud only exposes a short preview for this track';
    }
    if (track.playbackInfo?.policy === 'SNIP') {
      return 'SoundCloud only exposes a short preview for this track';
    }

    const transcodings = track.mediaInfo.transcodings;
    if (
      transcodings.length > 0 &&
      transcodings.every((t) => t.isSnipped === true)
    ) {
      return 'SoundCloud only exposes a short preview for this track';
    }

    const full = track.durations.full;
    const playback = track.durations.playback;
    if (
      typeof full === 'number' &&
      typeof playback === 'number' &&
      full > playback + 1_000
    ) {
      return 'SoundCloud only exposes a short preview for this track';
    }

    if (transcodings.length === 0) {
      return 'This SoundCloud track does not expose a playable stream';
    }

    return null;
  }

  private selectBestTranscoding(
    transcodings: MediaTranscoding[],
    preferredProtocol?: 'progressive' | 'hls',
  ): MediaTranscoding | null {
    const filtered = transcodings.filter((t) => !t.isSnipped);
    const scored = filtered.map((t) => {
      const protocol = t.protocol || '';
      const mime = (t.mimeType || '').split(';')[0].trim().toLowerCase();
      let score = parseBitrate(t.preset ?? undefined) ?? 0;

      if (preferredProtocol) {
        score += protocol === preferredProtocol ? 1_000_000 : 0;
      }
      if (protocol === 'progressive') {
        score += 200_000;
      }
      if (mime === 'audio/mpeg') {
        score += 400_000;
      } else if (mime === 'audio/mp4') {
        score += 200_000;
      } else if (mime === 'audio/ogg') {
        score += 80_000;
      } else if (mime.includes('mpegurl')) {
        score += 20_000;
      }

      return { t, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.t ?? null;
  }

  private inferCodec(t: MediaTranscoding): string | null {
    const mime = t.mimeType || '';
    const preset = t.preset || '';

    if (mime.includes('mp4a') || preset.includes('aac')) return 'aac';
    if (mime.includes('opus') || preset.includes('opus')) return 'opus';
    if (mime.includes('mpeg') || preset.includes('mp3')) return 'mp3';
    return null;
  }

  private normalizeMimeType(t: MediaTranscoding): string {
    const mime = t.mimeType || 'audio/mpeg';
    return mime.split(';')[0].trim() || 'audio/mpeg';
  }

  private trackArtwork(track: Track): string | null {
    return track.artwork?.t500x500 ?? track.artwork?.default ?? null;
  }

  async search(
    query: string,
    page: number,
  ): Promise<{ items: SearchResult[]; has_more: boolean }> {
    try {
      const sc = this.getClient();
      const limit = 40;

      let collection = await sc.search(query, { type: 'track', limit: limit * (page + 1) });

      // Advance through pages using continuation when page > 0
      for (let i = 0; i < page; i++) {
        if (!collection.continuation) break;
        collection = await sc.getContinuation(collection.continuation);
      }

      const tracks = collection.items
        .filter((track) => this.unplayableReason(track) === null)
        .sort((a, b) => {
          const scoreA =
            (a.playbackInfo.playbackCount ?? 0) +
            (a.socialInfo.likesCount ?? 0) * 25;
          const scoreB =
            (b.playbackInfo.playbackCount ?? 0) +
            (b.socialInfo.likesCount ?? 0) * 25;
          return scoreB - scoreA;
        });

      const items: SearchResult[] = tracks.slice(0, limit).map((track) => ({
        source: 'soundcloud',
        source_id: String(track.id),
        title: track.texts.title || 'Unknown',
        artist: track.user?.names.username || 'Unknown',
        album: null,
        duration_ms: track.durations.full ?? track.durations.playback ?? null,
        cover_art_url: this.trackArtwork(track),
        source_url: track.permalink.full ?? null,
        play_count: track.playbackInfo.playbackCount ?? null,
      }));

      this.markHealthy();
      return {
        items,
        has_more: Boolean(collection.continuation) || tracks.length >= limit,
      };
    } catch (err) {
      this.markFailure();
      throw err;
    }
  }

  async resolveStream(sourceId: string): Promise<StreamInfo> {
    try {
      const sc = this.getClient();
      const track = await sc.getTrack(Number(sourceId));

      if (!track) {
        throw new Error('Track not found on SoundCloud');
      }

      const unplayableReason = this.unplayableReason(track);
      if (unplayableReason) {
        throw new Error(unplayableReason);
      }

      const transcodings = track.mediaInfo.transcodings;
      const trackAuthorization = track.mediaInfo.trackAuthorization ?? undefined;
      const durationMs =
        track.durations.full ?? track.durations.playback ?? null;

      // Prefer progressive
      const progressive = this.selectBestTranscoding(
        transcodings.filter((t) => t.protocol === 'progressive'),
        'progressive',
      );

      if (progressive?.url) {
        const streamingData: StreamingData | null = await sc.getStreamingData({
          transcodingUrl: progressive.url,
          trackAuthorization,
        });

        if (!streamingData?.url) {
          throw new Error('SoundCloud did not return a playable stream URL');
        }

        this.markHealthy();
        return {
          url: streamingData.url,
          headers: {},
          expires_at: Date.now() + 30 * 60 * 1_000,
          mime_type: this.normalizeMimeType(progressive),
          codec: this.inferCodec(progressive),
          bitrate: parseBitrate(progressive.preset ?? undefined) ?? 128_000,
          duration_ms: durationMs,
          is_seekable: true,
          needs_refresh: true,
        };
      }

      // Fall back to HLS proxy
      const hls = this.selectBestTranscoding(
        transcodings.filter((t) => t.protocol === 'hls'),
        'hls',
      );

      if (!hls || !this.proxyBaseUrl) {
        throw new Error(
          'This SoundCloud track does not expose a supported stream',
        );
      }

      const hlsMimeType = this.normalizeMimeType(hls);
      const hlsCodec = this.inferCodec(hls);
      const hlsSeekable = hlsMimeType === 'audio/mpeg';

      this.markHealthy();
      return {
        url: `${this.proxyBaseUrl}/stream/soundcloud/${encodeURIComponent(sourceId)}`,
        headers: {},
        expires_at: Date.now() + 30_000,
        mime_type: hlsMimeType,
        codec: hlsCodec,
        bitrate: parseBitrate(hls.preset ?? undefined) ?? 160_000,
        duration_ms: durationMs,
        is_seekable: hlsSeekable,
        needs_refresh: true,
      };
    } catch (err) {
      this.markFailure();
      throw err;
    }
  }

  async streamToResponse(
    sourceId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const sc = this.getClient();
    const track = await sc.getTrack(Number(sourceId));

    if (!track) {
      res.statusCode = 404;
      res.end('Track not found');
      return;
    }

    const unplayableReason = this.unplayableReason(track);
    if (unplayableReason) {
      res.statusCode = 409;
      res.end(unplayableReason);
      return;
    }

    const transcodings = track.mediaInfo.transcodings;
    const trackAuthorization = track.mediaInfo.trackAuthorization ?? undefined;

    // Prefer HLS for the proxy (streaming pipeline)
    const hls = this.selectBestTranscoding(
      transcodings.filter((t) => t.protocol === 'hls'),
      'hls',
    );
    const media =
      hls ??
      this.selectBestTranscoding(transcodings);

    if (!media?.url) {
      res.statusCode = 404;
      res.end('Playable media not found');
      return;
    }

    const streamingData = await sc.getStreamingData({
      transcodingUrl: media.url,
      trackAuthorization,
    });

    if (!streamingData?.url) {
      res.statusCode = 502;
      res.end('Could not resolve SoundCloud stream URL');
      return;
    }

    // For progressive streams, pipe the content directly
    if (media.protocol === 'progressive') {
      await pipeRemoteUrl(streamingData.url, req, res, this.normalizeMimeType(media));
      return;
    }

    // For HLS, fetch the m3u8 manifest and proxy segments
    await proxyHlsStream(streamingData.url, req, res, this.normalizeMimeType(media));
  }

  async getMetadata(sourceId: string): Promise<TrackMetadata> {
    try {
      const sc = this.getClient();
      const track = await sc.getTrack(Number(sourceId));

      if (!track) {
        throw new Error('Track not found on SoundCloud');
      }

      this.markHealthy();

      const releasedDate = track.dates.released;
      const createdDate = track.dates.created;
      let year: number | null = null;
      if (releasedDate) {
        year = new Date(releasedDate).getFullYear();
      } else if (createdDate) {
        year = new Date(createdDate).getFullYear();
      }

      return {
        title: track.texts.title || 'Unknown',
        artist: track.user?.names.username || 'Unknown',
        album: null,
        duration_ms:
          track.durations.full ?? track.durations.playback ?? null,
        cover_art_url: this.trackArtwork(track),
        year,
        genre: track.genre ?? null,
      };
    } catch (err) {
      this.markFailure();
      throw err;
    }
  }
}

function parseBitrate(preset: string | undefined): number | null {
  if (!preset) return null;
  const match = preset.match(/(\d{2,3})k/i);
  return match ? Number(match[1]) * 1000 : null;
}

async function pipeRemoteUrl(
  url: string,
  req: IncomingMessage,
  res: ServerResponse,
  contentType: string,
): Promise<void> {
  const upstream = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: '*/*',
    },
  });

  if (!upstream.ok || !upstream.body) {
    res.statusCode = upstream.status || 502;
    res.end(`Upstream fetch failed: ${upstream.statusText}`);
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Accept-Ranges', 'none');

  const reader = upstream.body.getReader();

  req.on('close', () => {
    reader.cancel().catch(() => {});
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        // Back-pressure: wait for drain
        await new Promise<void>((resolve) => res.once('drain', resolve));
      }
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end(err instanceof Error ? err.message : 'Stream error');
    } else {
      res.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

async function proxyHlsStream(
  m3u8Url: string,
  req: IncomingMessage,
  res: ServerResponse,
  contentType: string,
): Promise<void> {
  // Fetch the HLS playlist
  const playlistResp = await fetch(m3u8Url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: '*/*',
    },
  });

  if (!playlistResp.ok) {
    res.statusCode = playlistResp.status || 502;
    res.end(`HLS playlist fetch failed: ${playlistResp.statusText}`);
    return;
  }

  const playlist = await playlistResp.text();
  const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);

  const initSegmentUrls: string[] = [];
  const segmentUrls: string[] = [];
  for (const line of playlist.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Could be absolute or relative
    segmentUrls.push(trimmed.startsWith('http') ? trimmed : baseUrl + trimmed);
  }

  for (const line of playlist.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('#EXT-X-MAP:')) continue;
    const uriMatch = trimmed.match(/URI="([^"]+)"/i);
    if (!uriMatch?.[1]) continue;
    const uri = uriMatch[1];
    initSegmentUrls.push(uri.startsWith('http') ? uri : baseUrl + uri);
  }

  const urlsToFetch = [...initSegmentUrls, ...segmentUrls];

  if (urlsToFetch.length === 0) {
    res.statusCode = 502;
    res.end('HLS playlist contained no playable media');
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Accept-Ranges', 'none');

  let aborted = false;
  req.on('close', () => {
    aborted = true;
  });

  for (const segUrl of urlsToFetch) {
    if (aborted) break;

    const segResp = await fetch(segUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: '*/*',
      },
    });

    if (!segResp.ok || !segResp.body) {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end(`HLS segment fetch failed: ${segResp.statusText}`);
      } else {
        res.destroy(new Error(`HLS segment fetch failed: ${segResp.statusText}`));
      }
      return;
    }

    const reader = segResp.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) {
          await new Promise<void>((resolve) => res.once('drain', resolve));
        }
      }
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end(err instanceof Error ? err.message : 'Segment stream error');
      } else {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }
  }

  if (!aborted) {
    res.end();
  }
}
