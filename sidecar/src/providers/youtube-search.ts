// Reads YouTube search results straight from the raw InnerTube response, the
// way yt-dlp does, instead of through youtubei.js's typed parser. YouTube A/B
// tests result layouts per visitor (on 2026-11-18 some visitors switched from
// `videoRenderer` to `lockupViewModel` and search came back empty), and a
// strict parser drops anything it doesn't know. Here every field is optional,
// every known layout is read, and an unknown layout that still carries a
// `videoId` and a `title` is read too.
import { tidyVideoTitle } from './titles.js';

export interface SearchResult {
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

export interface RawSearchPage {
  items: SearchResult[];
  continuation: string | null;
}

/** Classic renderers: search, mobile web, sidebar and shelf variants. */
const VIDEO_RENDERERS = ['videoRenderer', 'compactVideoRenderer', 'gridVideoRenderer', 'videoWithContextRenderer'];
/** Containers whose videos are suggestions, not results ("People also watched"). */
const SHELF_KEY = /shelf|carousel|horizontalCardList|horizontalList/i;
/** Ads, Shorts and other things never worth descending into. */
const SKIP_KEY =
  /^(adSlotRenderer|promotedSparklesWebRenderer|searchPyvRenderer|promotedVideoRenderer|reelShelfRenderer|reelItemRenderer|shortsLockupViewModel|menu|menuRenderer|header|onTap|navigationEndpoint|commandRuns|accessibility|thumbnailOverlays|overlays|frameworkUpdates|responseContext|topbar|refinements)$/;
const VIDEO_ID = /^[\w-]{11}$/;
const TIME_TEXT = /^\d{1,3}(?:,\d{3})*:\d{2}(?::\d{2})?$/;

export function extractSearchPage(data: unknown): RawSearchPage {
  const results: SearchResult[] = [];
  const suggestions: SearchResult[] = [];
  const unknown: SearchResult[] = [];
  let continuation: string | null = null;

  const walk = (node: unknown, inShelf: boolean): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, inShelf);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, any>;

    for (const [key, value] of Object.entries(obj)) {
      if (!value || typeof value !== 'object' || SKIP_KEY.test(key)) continue;
      const target = inShelf ? suggestions : results;

      if (VIDEO_RENDERERS.includes(key)) {
        pushResult(target, mapVideoRenderer(value));
      } else if (key === 'lockupViewModel') {
        pushResult(target, mapLockupViewModel(value));
      } else if (key === 'continuationItemRenderer') {
        continuation ??= str(value.continuationEndpoint?.continuationCommand?.token) ?? findContinuation(value);
      } else {
        if (key !== 'continuationCommand' && looksLikeVideo(value)) {
          pushResult(unknown, value.videoId ? mapVideoRenderer(value) : mapLockupViewModel(value));
          continue;
        }
        walk(value, inShelf || SHELF_KEY.test(key));
      }
    }
  };
  walk(data, false);

  continuation ??= findContinuation(data);
  // Unknown layouts only count when no known one matched the main results, so
  // a stray object with a video ID (an endpoint, a menu) never pads them.
  const items = [...(results.length ? results : unknown), ...suggestions];
  return { items: dedupe(items), continuation };
}

/** An unknown renderer that still has a video ID and a title, in either layout's naming. */
function looksLikeVideo(value: any): boolean {
  if (typeof value?.videoId === 'string') return VIDEO_ID.test(value.videoId) && value.title != null;
  return (
    typeof value?.contentId === 'string' &&
    VIDEO_ID.test(value.contentId) &&
    value.metadata?.lockupMetadataViewModel != null
  );
}

function pushResult(target: SearchResult[], result: SearchResult | null): void {
  if (result) target.push(result);
}

function mapVideoRenderer(video: any): SearchResult | null {
  const videoId = str(video.videoId);
  if (!videoId || !VIDEO_ID.test(videoId)) return null;

  const durationText =
    text(video.lengthText) ??
    asArray(video.thumbnailOverlays)
      .map((overlay: any) => text(overlay?.thumbnailOverlayTimeStatusRenderer?.text))
      .find((t: string | null) => t && TIME_TEXT.test(t)) ??
    null;

  return result(videoId, {
    title: text(video.title) ?? text(video.headline),
    channel: text(video.ownerText) ?? text(video.longBylineText) ?? text(video.shortBylineText),
    durationMs: parseDuration(durationText),
    thumbnail: bestThumbnail(video.thumbnail?.thumbnails),
    views: text(video.viewCountText) ?? text(video.shortViewCountText),
  });
}

/**
 * The view-model layout. Byline row parts are [channel (avatar stack), views
 * ("1.2M"), age ("2y ago")]; the duration is a badge on the thumbnail.
 */
function mapLockupViewModel(lockup: any): SearchResult | null {
  const videoId = str(lockup.contentId);
  if (!videoId || !VIDEO_ID.test(videoId)) return null;
  const meta = lockup.metadata?.lockupMetadataViewModel;
  if (!meta) return null; // ads use feedAdMetadataViewModel
  const type = str(lockup.contentType) ?? '';
  if (type && !/VIDEO|MOVIE/.test(type)) return null; // channels, playlists, mixes

  const parts: any[] = asArray(meta.metadata?.contentMetadataViewModel?.metadataRows).flatMap((row: any) =>
    asArray(row?.metadataParts),
  );
  const texts = parts.map((part) => text(part?.text)).filter((t): t is string => !!t);
  const channel =
    parts.map((part) => text(part?.avatarStack?.avatarStackViewModel?.text)).find(Boolean) ??
    parts
      .filter((part) => part?.text?.commandRuns?.[0]?.onTap?.innertubeCommand?.browseEndpoint)
      .map((part) => text(part.text))
      .find(Boolean) ??
    str(meta.image?.decoratedAvatarViewModel?.a11yLabel)?.replace(/^Go to channel\s*/i, '') ??
    texts.find((t) => !isCountText(t) && !/\bago$/i.test(t) && t.length < 80) ??
    null;

  const image = lockup.contentImage?.thumbnailViewModel ?? lockup.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel;
  return result(videoId, {
    title: text(meta.title),
    channel,
    durationMs: parseDuration(findString(image?.overlays, (s) => TIME_TEXT.test(s))),
    thumbnail: bestThumbnail(image?.image?.sources),
    views: texts.find(isCountText) ?? null,
  });
}

function result(
  videoId: string,
  fields: { title: string | null; channel: string | null; durationMs: number | null; thumbnail: string | null; views: string | null },
): SearchResult {
  return {
    source: 'youtube',
    source_id: videoId,
    ...tidyVideoTitle(fields.title || 'Unknown', fields.channel || 'Unknown'),
    album: null,
    duration_ms: fields.durationMs,
    cover_art_url: fields.thumbnail,
    source_url: `https://www.youtube.com/watch?v=${videoId}`,
    play_count: parseCountText(fields.views ?? undefined),
  };
}

/** Text from any of YouTube's text shapes: string, simpleText, runs, content. */
export function text(value: any): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object') return null;
  const out =
    str(value.simpleText) ??
    str(value.content) ??
    (Array.isArray(value.runs) ? value.runs.map((run: any) => run?.text ?? '').join('') : null);
  return out?.trim() || null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

export function bestThumbnail(thumbnails: unknown): string | null {
  const list = asArray(thumbnails).filter((t) => typeof t?.url === 'string');
  if (!list.length) return null;
  const best = list.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a));
  return best.url.startsWith('//') ? `https:${best.url}` : best.url;
}

/** First string anywhere under `node` that passes `test`. */
function findString(node: unknown, test: (s: string) => boolean): string | null {
  if (typeof node === 'string') return test(node.trim()) ? node.trim() : null;
  if (!node || typeof node !== 'object') return null;
  for (const value of Object.values(node)) {
    const found = findString(value, test);
    if (found) return found;
  }
  return null;
}

function findContinuation(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, any>;
  const token = str(obj.continuationCommand?.token);
  if (token) return token;
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'frameworkUpdates' || key === 'responseContext') continue;
    const found = findContinuation(value);
    if (found) return found;
  }
  return null;
}

function dedupe(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((r) => !seen.has(r.source_id) && !!seen.add(r.source_id));
}

function isCountText(value: string): boolean {
  return /^[\d.,]+\s*[KMBT]?(\s*(views?|plays?|watching))?$/i.test(value.trim());
}

export function parseDuration(value: string | null | undefined): number | null {
  if (!value || !TIME_TEXT.test(value.trim())) return null;
  const parts = value.trim().replace(/,/g, '').split(':').map(Number);
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds > 0 ? seconds * 1000 : null;
}

export function parseCountText(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([KMBT])?\s*(?:plays|play|views|view)?/i);
  if (!match) return null;

  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  const multiplier = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2]?.toUpperCase() ?? ''] ?? 1;
  return Math.round(number * multiplier);
}
