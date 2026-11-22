// "Trending" from YouTube Music's Explore page, read from the raw InnerTube
// response like search is (see youtube-search.ts). YouTube retired its own
// Trending page in 2025; YouTube Music's Explore still carries a Trending
// shelf of about 20 songs with titles, artists and view counts.
import { tidyVideoTitle } from './titles.js';
import { bestThumbnail, parseCountText, text, type SearchResult } from './youtube-search.js';

const VIDEO_ID = /^[\w-]{11}$/;

export function extractTrending(data: unknown): SearchResult[] {
  const shelves: { title: string; items: any[] }[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, any>)) {
      if (!value || typeof value !== 'object') continue;
      if (key === 'musicCarouselShelfRenderer' || key === 'musicShelfRenderer') {
        const header = value.header?.musicCarouselShelfBasicHeaderRenderer ?? value.header;
        shelves.push({ title: text(header?.title) ?? text(value.title) ?? '', items: asArray(value.contents) });
      } else if (key !== 'frameworkUpdates' && key !== 'responseContext') {
        walk(value);
      }
    }
  };
  walk(data);

  // The shelf named Trending; failing that, the first shelf of songs.
  const songs = (items: any[]) => items.map((item) => mapListItem(item?.musicResponsiveListItemRenderer)).filter(isResult);
  const named = shelves.find((shelf) => /trending/i.test(shelf.title));
  const list = named ? songs(named.items) : (shelves.map((s) => songs(s.items)).find((l) => l.length) ?? []);
  const seen = new Set<string>();
  return list.filter((r) => !seen.has(r.source_id) && !!seen.add(r.source_id));
}

function mapListItem(item: any): SearchResult | null {
  if (!item) return null;
  const columns = asArray(item.flexColumns).map((c) => c?.musicResponsiveListItemFlexColumnRenderer?.text);
  const titleRuns = asArray(columns[0]?.runs);
  const videoId = [
    item.playlistItemData?.videoId,
    item.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId,
    titleRuns[0]?.navigationEndpoint?.watchEndpoint?.videoId,
  ].find((id) => typeof id === 'string' && VIDEO_ID.test(id));
  const title = text(columns[0]);
  if (!videoId || !title) return null;

  // "Artist • 5.9M views": artists before the first separator, views after.
  const parts = (text(columns[1]) ?? '').split(' • ').map((p) => p.trim()).filter(Boolean);
  const views = parts.find((p) => /views?|plays?$/i.test(p));
  const channel = parts.filter((p) => p !== views).join(', ') || 'Unknown';
  // Music videos keep their YouTube names ("Lil Baby - Aint Goin (Official
  // Music Video)", "Anuel AA | SONG"); tidy them like search results.
  const piped = title.match(/^(.+?)\s+\|\s+(.+)$/);
  const named = piped && squash(piped[1]) === squash(channel) ? `${piped[1]} - ${piped[2]}` : title;
  return {
    source: 'youtube',
    source_id: videoId,
    ...tidyVideoTitle(named, channel),
    album: null,
    duration_ms: null,
    cover_art_url: bestThumbnail(item.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails),
    source_url: `https://www.youtube.com/watch?v=${videoId}`,
    play_count: parseCountText(views),
  };
}

function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isResult(value: SearchResult | null): value is SearchResult {
  return value !== null;
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}
