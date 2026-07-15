import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const SCHEMA_VERSION = 1;
export const OUTPUT_RELATIVE_PATH = 'discovery/v1/snapshot.json';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const FAILURE_RETRY_SECS = 60 * 60;
const CLOCK_SKEW_SECS = 5 * 60;
const LASTFM_USER_AGENT = 'mewsik-discovery-snapshot/1 (+https://github.com/RemingtonWilcox/mewsik)';

const YOUTUBE = Object.freeze({
  id: 'youtube_most_popular_music',
  family: 'youtube',
  label: 'YouTube popular music videos (US)',
  cadenceSecs: 60 * 60,
  limit: 50,
});

const LASTFM = Object.freeze({
  id: 'lastfm_top_tracks',
  family: 'lastfm',
  label: 'Last.fm top tracks',
  cadenceSecs: 4 * 60 * 60,
  limit: 100,
});

const SOURCE_DEFINITIONS = Object.freeze([YOUTUBE, LASTFM]);

class ProviderFailure extends Error {}

function cleanText(value, maxLength = 512) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function safeCount(value) {
  const text = typeof value === 'number' ? String(value) : cleanText(value, 32);
  if (!text || !/^\d+$/u.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function safeTimestamp(value, now) {
  return Number.isSafeInteger(value) && value >= 0 && value <= now + CLOCK_SKEW_SECS
    ? value
    : null;
}

function safeRank(value, limit) {
  return Number.isSafeInteger(value) && value >= 1 && value <= limit ? value : null;
}

function safeIsoDate(value) {
  const text = cleanText(value, 10);
  if (!text || !/^\d{4}-\d{2}-\d{2}$/u.test(text)) return null;
  const timestamp = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== text
    ? null
    : text;
}

function safeHttpsUrl(value, allowedHost) {
  const text = cleanText(value, 2_048);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || !allowedHost(url.hostname.toLowerCase())) return null;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return null;
  }
}

function youtubeArtwork(thumbnails) {
  if (!thumbnails || typeof thumbnails !== 'object' || Array.isArray(thumbnails)) return null;
  for (const name of ['maxres', 'standard', 'high', 'medium', 'default']) {
    const candidate = safeHttpsUrl(thumbnails[name]?.url, (host) =>
      host === 'ytimg.com' || host.endsWith('.ytimg.com'),
    );
    if (candidate) return candidate;
  }
  return null;
}

function safeLastFmUrl(value) {
  return safeHttpsUrl(value, (host) => host === 'last.fm' || host.endsWith('.last.fm'));
}

function safeMbid(value) {
  const text = cleanText(value, 36);
  return text && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(text)
    ? text.toLowerCase()
    : null;
}

function stableTextId(artist, title) {
  const normalize = (value) => value.trim().replace(/\s+/gu, ' ').toLowerCase();
  const digest = createHash('sha256')
    .update(`${normalize(artist)}::${normalize(title)}`)
    .digest('hex')
    .slice(0, 32);
  return `lastfm-text-${digest}`;
}

function normalizedTags(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const tags = [];
  for (const value of values) {
    const tag = cleanText(value, 96);
    const key = tag?.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length === 12) break;
  }
  return tags.sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' }));
}

function youtubeItems(payload, now) {
  if (!Array.isArray(payload?.items)) throw new ProviderFailure('invalid provider response');
  const items = payload.items.slice(0, YOUTUBE.limit).flatMap((video) => {
    const id = cleanText(video?.id, 128);
    const title = cleanText(video?.snippet?.title, 512);
    const channel = cleanText(video?.snippet?.channelTitle, 512);
    if (!id || !title || !channel) return [];
    const viewCount = safeCount(video?.statistics?.viewCount);
    const likeCount = safeCount(video?.statistics?.likeCount);
    return [{
      source: YOUTUBE.id,
      source_family: YOUTUBE.family,
      source_item_id: id,
      item_kind: 'track',
      title,
      artist: channel,
      album: null,
      artwork_url: youtubeArtwork(video?.snippet?.thumbnails),
      release_date: safeIsoDate(cleanText(video?.snippet?.publishedAt, 10)),
      // Preserve the API response order in the array without manufacturing a
      // numeric chart rank or a cross-provider headline metric.
      rank: null,
      audience_count: null,
      metrics: {
        listener_count: null,
        play_count: null,
        view_count: viewCount,
        like_count: likeCount,
      },
      tags: normalizedTags(video?.snippet?.tags),
      market: 'US',
      observed_at: now,
      editorial_url: null,
      external_ids: { youtube_video_id: id },
    }];
  });
  if (items.length === 0) throw new ProviderFailure('empty provider response');
  return items;
}

function lastFmItems(payload, now) {
  if (payload?.error || !Array.isArray(payload?.tracks?.track)) {
    throw new ProviderFailure('invalid provider response');
  }
  const items = payload.tracks.track.slice(0, LASTFM.limit).flatMap((track, index) => {
    const title = cleanText(track?.name, 512);
    const artist = cleanText(track?.artist?.name, 512);
    if (!title || !artist) return [];
    const recordingMbid = safeMbid(track?.mbid);
    const artistMbid = safeMbid(track?.artist?.mbid);
    const trackUrl = safeLastFmUrl(track?.url);
    const artistUrl = safeLastFmUrl(track?.artist?.url);
    const linkback = trackUrl ?? artistUrl;
    if (!linkback) return [];
    const listenerCount = safeCount(track?.listeners);
    const playCount = safeCount(track?.playcount);
    const externalIds = {};
    if (recordingMbid) externalIds.musicbrainz_recording_id = recordingMbid;
    if (artistMbid) externalIds.musicbrainz_artist_id = artistMbid;
    if (trackUrl) externalIds.lastfm_track_url = trackUrl;
    return [{
      source: LASTFM.id,
      source_family: LASTFM.family,
      source_item_id: recordingMbid ?? stableTextId(artist, title),
      item_kind: 'track',
      title,
      artist,
      album: null,
      // Last.fm's standard API terms do not license API artwork for this service.
      artwork_url: null,
      release_date: null,
      rank: index + 1,
      audience_count: listenerCount,
      metrics: {
        listener_count: listenerCount,
        play_count: playCount,
        view_count: null,
        like_count: null,
      },
      tags: [],
      market: null,
      observed_at: now,
      editorial_url: linkback,
      external_ids: externalIds,
    }];
  });
  if (items.length === 0) throw new ProviderFailure('empty provider response');
  return items;
}

async function fetchJson(fetchImpl, url, additionalHeaders = undefined) {
  let response;
  try {
    const headers = new Headers(additionalHeaders);
    headers.set('accept', 'application/json');
    response = await fetchImpl(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ProviderFailure('provider request failed');
  }
  if (!response?.ok) throw new ProviderFailure('provider request failed');
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new ProviderFailure('provider response too large');
  }
  let bytes;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new ProviderFailure('provider response failed');
  }
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new ProviderFailure('provider response too large');
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ProviderFailure('invalid provider response');
  }
}

async function fetchYouTube(fetchImpl, apiKey, now) {
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'snippet,statistics');
  url.searchParams.set('chart', 'mostPopular');
  url.searchParams.set('regionCode', 'US');
  url.searchParams.set('videoCategoryId', '10');
  url.searchParams.set('maxResults', String(YOUTUBE.limit));
  const payload = await fetchJson(fetchImpl, url, { 'x-goog-api-key': apiKey });
  return {
    source: YOUTUBE.id,
    label: YOUTUBE.label,
    fetched_at: now,
    cadence_secs: YOUTUBE.cadenceSecs,
    items: youtubeItems(payload, now),
  };
}

async function fetchLastFm(fetchImpl, apiKey, now) {
  const url = new URL('https://ws.audioscrobbler.com/2.0/');
  url.searchParams.set('method', 'chart.getTopTracks');
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', String(LASTFM.limit));
  url.searchParams.set('page', '1');
  const payload = await fetchJson(fetchImpl, url, { 'user-agent': LASTFM_USER_AGENT });
  return {
    source: LASTFM.id,
    label: LASTFM.label,
    fetched_at: now,
    cadence_secs: LASTFM.cadenceSecs,
    items: lastFmItems(payload, now),
  };
}

function sanitizePreviousItem(definition, candidate, now) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const sourceItemId = cleanText(candidate.source_item_id, 512);
  const title = cleanText(candidate.title, 512);
  if (
    candidate.source !== definition.id ||
    candidate.source_family !== definition.family ||
    candidate.item_kind !== 'track' ||
    !sourceItemId ||
    !title
  ) return null;
  const artist = cleanText(candidate.artist, 512);
  if (!artist) return null;
  const observedAt = safeTimestamp(candidate.observed_at, now);
  if (observedAt === null) return null;
  const listenerCount = safeCount(candidate.metrics?.listener_count);
  const playCount = safeCount(candidate.metrics?.play_count);
  const viewCount = safeCount(candidate.metrics?.view_count);
  const likeCount = safeCount(candidate.metrics?.like_count);
  const externalIds = {};
  const editorialUrl = definition.id === LASTFM.id
    ? safeLastFmUrl(candidate.editorial_url)
    : null;
  let lastFmTrackUrl = null;
  if (definition.id === YOUTUBE.id) {
    const videoId = cleanText(candidate.external_ids?.youtube_video_id, 128);
    if (!videoId || videoId !== sourceItemId) return null;
    externalIds.youtube_video_id = videoId;
  } else {
    const recordingMbid = safeMbid(candidate.external_ids?.musicbrainz_recording_id);
    const artistMbid = safeMbid(candidate.external_ids?.musicbrainz_artist_id);
    lastFmTrackUrl = safeLastFmUrl(candidate.external_ids?.lastfm_track_url);
    const hasCanonicalSourceId = recordingMbid
      ? sourceItemId === recordingMbid
      : /^lastfm-text-[0-9a-f]{32}$/u.test(sourceItemId);
    if (!hasCanonicalSourceId) return null;
    if (recordingMbid) externalIds.musicbrainz_recording_id = recordingMbid;
    if (artistMbid) externalIds.musicbrainz_artist_id = artistMbid;
    if (lastFmTrackUrl) externalIds.lastfm_track_url = lastFmTrackUrl;
  }
  const lastFmLinkback = definition.id === LASTFM.id ? editorialUrl ?? lastFmTrackUrl : null;
  if (definition.id === LASTFM.id && !lastFmLinkback) return null;
  return {
    source: definition.id,
    source_family: definition.family,
    source_item_id: sourceItemId,
    item_kind: 'track',
    title,
    artist,
    album: null,
    artwork_url: definition.id === YOUTUBE.id
      ? safeHttpsUrl(candidate.artwork_url, (host) => host === 'ytimg.com' || host.endsWith('.ytimg.com'))
      : null,
    release_date: definition.id === YOUTUBE.id ? safeIsoDate(candidate.release_date) : null,
    rank: definition.id === YOUTUBE.id ? null : safeRank(candidate.rank, definition.limit),
    audience_count: definition.id === YOUTUBE.id ? null : listenerCount,
    metrics: definition.id === YOUTUBE.id
      ? { listener_count: null, play_count: null, view_count: viewCount, like_count: likeCount }
      : { listener_count: listenerCount, play_count: playCount, view_count: null, like_count: null },
    tags: definition.id === YOUTUBE.id ? normalizedTags(candidate.tags) : [],
    market: definition.id === YOUTUBE.id && candidate.market === 'US' ? 'US' : null,
    observed_at: observedAt,
    editorial_url: lastFmLinkback,
    external_ids: externalIds,
  };
}

function previousSource(snapshot, definition, now) {
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    snapshot.schema_version !== SCHEMA_VERSION ||
    !Array.isArray(snapshot.sources)
  ) return null;
  const source = snapshot.sources.find((candidate) => candidate?.id === definition.id);
  const batch = source?.batch;
  if (
    !batch ||
    typeof batch !== 'object' ||
    batch.source !== definition.id ||
    batch.cadence_secs !== definition.cadenceSecs ||
    !Array.isArray(batch.items) ||
    batch.items.length === 0 ||
    batch.items.length > definition.limit
  ) return null;
  const fetchedAt = safeTimestamp(batch.fetched_at, now);
  if (fetchedAt === null) return null;
  if (now - fetchedAt > definition.cadenceSecs * 3) return null;
  const items = batch.items
    .map((item) => sanitizePreviousItem(definition, item, now))
    .filter(Boolean);
  if (items.length === 0) return null;
  return {
    lastAttemptAt: safeTimestamp(source.last_attempt_at, now) ?? fetchedAt,
    batch: {
      source: definition.id,
      label: definition.label,
      fetched_at: fetchedAt,
      cadence_secs: definition.cadenceSecs,
      items,
    },
  };
}

function hasCredential(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

async function resolveSource({ definition, enabled, apiKey, previous, fetchImpl, now }) {
  if (!enabled) {
    return {
      id: definition.id,
      state: 'unavailable',
      last_attempt_at: now,
      detail: 'This shared source is disabled until its provider approval and presentation requirements are complete.',
      batch: null,
    };
  }
  const prior = previousSource(previous, definition, now);
  const dueAt = prior ? prior.batch.fetched_at + definition.cadenceSecs : 0;
  if (prior && now < dueAt) {
    return {
      id: definition.id,
      state: 'cached',
      last_attempt_at: prior.lastAttemptAt,
      detail: `Recent saved data is still inside its ${definition.cadenceSecs / 3_600}-hour refresh window.`,
      batch: prior.batch,
    };
  }

  if (!hasCredential(apiKey)) {
    return prior
      ? {
          id: definition.id,
          state: 'stale',
          last_attempt_at: now,
          detail: 'This shared source is not enabled yet; listeners do not need to configure anything. The last usable batch is retained temporarily.',
          batch: prior.batch,
        }
      : {
          id: definition.id,
          state: 'unavailable',
          last_attempt_at: now,
          detail: 'This shared source is not enabled yet; listeners do not need to configure anything.',
          batch: null,
        };
  }

  try {
    const batch = definition.id === YOUTUBE.id
      ? await fetchYouTube(fetchImpl, apiKey.trim(), now)
      : await fetchLastFm(fetchImpl, apiKey.trim(), now);
    return {
      id: definition.id,
      state: 'live',
      last_attempt_at: now,
      detail: definition.id === YOUTUBE.id
        ? 'Refreshed from the YouTube Data API for the US music-video chart.'
        : 'Refreshed from Last.fm global charts; provider artwork is intentionally omitted.',
      batch,
    };
  } catch {
    return prior
      ? {
          id: definition.id,
          state: 'stale',
          last_attempt_at: now,
          detail: 'The provider refresh failed; serving the last known batch outside its normal refresh window.',
          batch: prior.batch,
        }
      : {
          id: definition.id,
          state: 'unavailable',
          last_attempt_at: now,
          detail: 'The provider refresh failed and no previous batch is available.',
          batch: null,
        };
  }
}

function calculateNextRefreshAt(sources, now) {
  const candidates = sources.map((source) => {
    if (source.state === 'live' || source.state === 'cached') {
      return source.batch.fetched_at + source.batch.cadence_secs;
    }
    return now + FAILURE_RETRY_SECS;
  });
  return Math.max(now + 60, Math.min(...candidates));
}

function makeSnapshotId(generatedAt, sources) {
  const digest = createHash('sha256')
    .update(JSON.stringify({ schema_version: SCHEMA_VERSION, generated_at: generatedAt, sources }))
    .digest('hex')
    .slice(0, 16);
  return `s1-${generatedAt}-${digest}`;
}

function assertCredentialsAreAbsent(value, credentials) {
  const serialized = JSON.stringify(value);
  for (const credential of credentials) {
    const secret = typeof credential === 'string' ? credential.trim() : '';
    if (secret && serialized.includes(secret)) {
      throw new Error('Generated snapshot failed the credential safety check');
    }
  }
}

export async function buildSnapshot({
  now = Math.floor(Date.now() / 1_000),
  previous = null,
  youtubeEnabled = false,
  lastfmEnabled = false,
  youtubeApiKey = '',
  lastfmApiKey = '',
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('now must be a Unix timestamp');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const credentials = new Map([
    [YOUTUBE.id, youtubeApiKey],
    [LASTFM.id, lastfmApiKey],
  ]);
  const enabledSources = new Map([
    [YOUTUBE.id, youtubeEnabled === true],
    [LASTFM.id, lastfmEnabled === true],
  ]);
  const sources = await Promise.all(SOURCE_DEFINITIONS.map((definition) =>
    resolveSource({
      definition,
      enabled: enabledSources.get(definition.id),
      apiKey: credentials.get(definition.id),
      previous,
      fetchImpl,
      now,
    })));
  const snapshot = {
    schema_version: SCHEMA_VERSION,
    snapshot_id: makeSnapshotId(now, sources),
    generated_at: now,
    next_refresh_at: calculateNextRefreshAt(sources, now),
    sources,
  };
  assertCredentialsAreAbsent(snapshot, [youtubeApiKey, lastfmApiKey]);
  return snapshot;
}

export async function loadPreviousSnapshot({ filePath, url, fetchImpl = globalThis.fetch } = {}) {
  if (filePath) {
    try {
      return JSON.parse(await readFile(resolve(filePath), 'utf8'));
    } catch {
      // A local cache is optional. Fall through to the deployed snapshot.
    }
  }
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    return await fetchJson(fetchImpl, parsed);
  } catch {
    return null;
  }
}

export async function writeSnapshot({ outputDirectory, ...options }) {
  if (!outputDirectory) throw new TypeError('outputDirectory is required');
  const snapshot = await buildSnapshot(options);
  const outputPath = resolve(outputDirectory, OUTPUT_RELATIVE_PATH);
  const temporaryPath = `${outputPath}.tmp`;
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(resolve(outputDirectory), { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o644,
    });
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  await writeFile(resolve(outputDirectory, '.nojekyll'), '', { encoding: 'utf8', mode: 0o644 });
  return { outputPath, snapshot };
}
