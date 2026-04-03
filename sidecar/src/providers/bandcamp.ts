// Bandcamp provider - Phase 4 implementation

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

export class BandcampProvider {
  private client: any | null = null;
  private healthy = true;
  private failCount = 0;

  private async getClient(): Promise<any> {
    if (!this.client) {
      const mod = await import('bandcamp-fetch');
      this.client = mod.default || mod;
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

  async search(query: string, page: number): Promise<{ items: SearchResult[]; has_more: boolean }> {
    try {
      const bc = await this.getClient();
      const results = await bc.search.tracks({ query, page: Math.max(1, page + 1) });

      const items: SearchResult[] = (results.items || []).slice(0, 40).map((item: any) => ({
        source: 'bandcamp',
        source_id: item.url || '',
        title: item.name || 'Unknown',
        artist: item.artist || 'Unknown',
        album: null,
        duration_ms: null,
        cover_art_url: item.imageUrl || null,
        source_url: item.url || null,
        play_count: null,
      }));

      this.markHealthy();
      return { items, has_more: (results.items || []).length >= 40 };
    } catch (err) {
      this.markFailure();
      throw err;
    }
  }

  async resolveStream(sourceId: string): Promise<StreamInfo> {
    try {
      const bc = await this.getClient();
      const track = await bc.track.getInfo({ trackUrl: sourceId });
      const initialUrl = track?.streamUrlHQ || track?.streamUrl;
      if (!initialUrl) {
        throw new Error('Bandcamp track does not expose a stream URL');
      }

      const refreshedUrl = (await bc.stream.refresh(initialUrl).catch(() => null)) || initialUrl;
      this.markHealthy();

      return {
        url: refreshedUrl,
        headers: {},
        expires_at: Date.now() + 10 * 60 * 1000,
        mime_type: 'audio/mpeg',
        codec: 'mp3',
        bitrate: track?.streamUrlHQ ? 320000 : 128000,
        duration_ms: track?.duration ? Math.round(track.duration * 1000) : null,
        is_seekable: true,
        needs_refresh: true,
      };
    } catch (err) {
      this.markFailure();
      throw err;
    }
  }

  async getMetadata(sourceId: string): Promise<TrackMetadata> {
    try {
      const bc = await this.getClient();
      const track = await bc.track.getInfo({ trackUrl: sourceId });

      this.markHealthy();

      return {
        title: track?.name || 'Unknown',
        artist: track?.artist?.name || 'Unknown',
        album: track?.album?.name || null,
        duration_ms: track?.duration ? Math.round(track.duration * 1000) : null,
        cover_art_url: track?.imageUrl || null,
        year: track?.releaseDate ? new Date(track.releaseDate).getFullYear() : null,
        genre: null,
      };
    } catch (err) {
      this.markFailure();
      throw err;
    }
  }
}
