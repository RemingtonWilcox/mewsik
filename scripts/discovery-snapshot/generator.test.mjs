import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildSnapshot,
  loadPreviousSnapshot,
  OUTPUT_RELATIVE_PATH,
  writeSnapshot,
} from './generator.mjs';

const NOW = 1_783_958_400;
const YOUTUBE_KEY = 'youtube-top-secret-value';
const LASTFM_KEY = 'lastfm-top-secret-value';

const youtubePayload = {
  items: [{
    id: 'video-123',
    snippet: {
      title: 'A Great Song',
      channelTitle: 'Example Artist',
      publishedAt: '2026-07-12T12:34:56Z',
      tags: ['Pop', 'pop', 'Music'],
      thumbnails: {
        high: { url: 'https://i.ytimg.com/vi/video-123/hqdefault.jpg' },
      },
    },
    statistics: { viewCount: '1234567', likeCount: '76543' },
  }],
};

const lastFmPayload = {
  tracks: {
    track: [{
      name: 'Another Great Song',
      mbid: '11111111-2222-3333-4444-555555555555',
      url: 'https://www.last.fm/music/Example/_/Another+Great+Song',
      listeners: '456789',
      playcount: '987654',
      artist: {
        name: 'Another Artist',
        mbid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      },
      image: [{ '#text': 'https://lastfm.freetls.fastly.net/secret-art.jpg', size: 'large' }],
    }],
  },
};

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
}

function successfulFetch(request) {
  const url = new URL(request);
  if (url.hostname === 'www.googleapis.com') {
    assert.equal(url.searchParams.get('chart'), 'mostPopular');
    assert.equal(url.searchParams.get('videoCategoryId'), '10');
    assert.equal(url.searchParams.get('regionCode'), 'US');
    assert.equal(url.searchParams.get('key'), YOUTUBE_KEY);
    return Promise.resolve(jsonResponse(youtubePayload));
  }
  assert.equal(url.hostname, 'ws.audioscrobbler.com');
  assert.equal(url.searchParams.get('method'), 'chart.getTopTracks');
  assert.equal(url.searchParams.get('api_key'), LASTFM_KEY);
  return Promise.resolve(jsonResponse(lastFmPayload));
}

test('builds the credential-free v1 envelope and omits Last.fm artwork', async () => {
  const snapshot = await buildSnapshot({
    now: NOW,
    youtubeApiKey: YOUTUBE_KEY,
    lastfmApiKey: LASTFM_KEY,
    fetchImpl: successfulFetch,
  });

  assert.equal(snapshot.schema_version, 1);
  assert.match(snapshot.snapshot_id, new RegExp(`^s1-${NOW}-[0-9a-f]{16}$`, 'u'));
  assert.equal(snapshot.generated_at, NOW);
  assert.equal(snapshot.next_refresh_at, NOW + 3_600);
  assert.deepEqual(snapshot.sources.map(({ id, state }) => [id, state]), [
    ['youtube_most_popular_music', 'live'],
    ['lastfm_top_tracks', 'live'],
  ]);

  const youtube = snapshot.sources[0].batch.items[0];
  assert.equal(youtube.market, 'US');
  assert.equal(youtube.metrics.view_count, 1_234_567);
  assert.equal(youtube.release_date, '2026-07-12');
  assert.deepEqual(youtube.tags, ['Music', 'Pop']);

  const lastfm = snapshot.sources[1].batch.items[0];
  assert.equal(lastfm.artwork_url, null);
  assert.equal(lastfm.metrics.listener_count, 456_789);
  assert.equal(lastfm.metrics.play_count, 987_654);
  assert.equal(lastfm.external_ids.musicbrainz_recording_id, '11111111-2222-3333-4444-555555555555');

  const published = JSON.stringify(snapshot);
  assert.doesNotMatch(published, /top-secret-value/u);
  assert.doesNotMatch(published, /lastfm\.freetls/u);
});

test('keeps in-cadence batches cached without calling either provider', async () => {
  const previous = await buildSnapshot({
    now: NOW - 1_800,
    youtubeApiKey: YOUTUBE_KEY,
    lastfmApiKey: LASTFM_KEY,
    fetchImpl: successfulFetch,
  });
  let requests = 0;
  const snapshot = await buildSnapshot({
    now: NOW,
    previous,
    youtubeApiKey: YOUTUBE_KEY,
    lastfmApiKey: LASTFM_KEY,
    fetchImpl: async () => {
      requests += 1;
      throw new Error('should not fetch inside cadence');
    },
  });

  assert.equal(requests, 0);
  assert.deepEqual(snapshot.sources.map(({ state }) => state), ['cached', 'cached']);
  assert.equal(snapshot.sources[0].batch.fetched_at, NOW - 1_800);
  assert.equal(snapshot.next_refresh_at, NOW + 1_800);
});

test('retains bounded last-known-good data when a due provider refresh fails', async () => {
  const previous = await buildSnapshot({
    now: NOW - 7_200,
    youtubeApiKey: YOUTUBE_KEY,
    lastfmApiKey: LASTFM_KEY,
    fetchImpl: successfulFetch,
  });
  const snapshot = await buildSnapshot({
    now: NOW,
    previous,
    youtubeApiKey: YOUTUBE_KEY,
    lastfmApiKey: LASTFM_KEY,
    fetchImpl: async () => {
      throw new Error(`request leaked ${YOUTUBE_KEY} ${LASTFM_KEY}`);
    },
  });

  assert.deepEqual(snapshot.sources.map(({ state }) => state), ['stale', 'cached']);
  assert.equal(snapshot.sources[0].batch.items[0].source_item_id, 'video-123');
  assert.equal(snapshot.sources[1].batch.items[0].artwork_url, null);
  assert.equal(snapshot.next_refresh_at, NOW + 3_600);
  assert.doesNotMatch(JSON.stringify(snapshot), /top-secret-value|request leaked/u);
});

test('drops provider observations older than three source cadences', async () => {
  const previous = await buildSnapshot({
    now: NOW - 50_000,
    youtubeApiKey: YOUTUBE_KEY,
    lastfmApiKey: LASTFM_KEY,
    fetchImpl: successfulFetch,
  });
  const snapshot = await buildSnapshot({ now: NOW, previous });
  assert.deepEqual(snapshot.sources.map(({ state, batch }) => [state, batch]), [
    ['unavailable', null],
    ['unavailable', null],
  ]);
});

test('reports unavailable honestly when no credential or previous batch exists', async () => {
  let requests = 0;
  const snapshot = await buildSnapshot({
    now: NOW,
    fetchImpl: async () => {
      requests += 1;
      throw new Error('not expected');
    },
  });

  assert.equal(requests, 0);
  assert.deepEqual(snapshot.sources.map(({ state, batch }) => [state, batch]), [
    ['unavailable', null],
    ['unavailable', null],
  ]);
});

test('refuses to serialize a credential even if a provider echoes it', async () => {
  const echoingFetch = async (request) => {
    const url = new URL(request);
    if (url.hostname === 'www.googleapis.com') {
      return jsonResponse({
        items: [{
          ...youtubePayload.items[0],
          snippet: { ...youtubePayload.items[0].snippet, title: YOUTUBE_KEY },
        }],
      });
    }
    return jsonResponse(lastFmPayload);
  };
  await assert.rejects(
    buildSnapshot({
      now: NOW,
      youtubeApiKey: YOUTUBE_KEY,
      lastfmApiKey: LASTFM_KEY,
      fetchImpl: echoingFetch,
    }),
    /credential safety check/u,
  );
});

test('sanitizes previous batches instead of republishing extra fields', async () => {
  const previous = await buildSnapshot({
    now: NOW - 1_800,
    youtubeApiKey: YOUTUBE_KEY,
    lastfmApiKey: LASTFM_KEY,
    fetchImpl: successfulFetch,
  });
  previous.sources[0].batch.secret = YOUTUBE_KEY;
  previous.sources[0].batch.items[0].secret = LASTFM_KEY;
  previous.sources[0].batch.items[0].external_ids.api_key = YOUTUBE_KEY;
  previous.sources[1].batch.items[0].artwork_url = 'https://lastfm.freetls.fastly.net/not-licensed.jpg';
  previous.sources[1].batch.items[0].metrics.view_count = 999;

  const snapshot = await buildSnapshot({ now: NOW, previous });
  const published = JSON.stringify(snapshot);
  assert.doesNotMatch(published, /top-secret-value|not-licensed/u);
  assert.equal(snapshot.sources[1].batch.items[0].artwork_url, null);
  assert.equal(snapshot.sources[1].batch.items[0].metrics.view_count, null);
});

test('drops a retained Last.fm item whose source id conflicts with its recording id', async () => {
  const previous = await buildSnapshot({
    now: NOW - 1_800,
    youtubeApiKey: YOUTUBE_KEY,
    lastfmApiKey: LASTFM_KEY,
    fetchImpl: successfulFetch,
  });
  previous.sources[1].batch.items[0].source_item_id = 'lastfm-text-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  const snapshot = await buildSnapshot({ now: NOW, previous });
  assert.equal(snapshot.sources[1].state, 'unavailable');
  assert.equal(snapshot.sources[1].batch, null);
});

test('writes the Pages endpoint atomically beneath discovery/v1', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mewsik-discovery-'));
  try {
    const { outputPath, snapshot } = await writeSnapshot({
      outputDirectory: directory,
      now: NOW,
    });
    assert.equal(outputPath, join(directory, ...OUTPUT_RELATIVE_PATH.split('/')));
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), snapshot);
    assert.equal(await readFile(join(directory, '.nojekyll'), 'utf8'), '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('only loads prior snapshots from local JSON or HTTPS', async () => {
  assert.equal(await loadPreviousSnapshot({ url: 'http://example.test/snapshot.json' }), null);
  const prior = { schema_version: 1, sources: [] };
  assert.deepEqual(await loadPreviousSnapshot({
    url: 'https://example.test/snapshot.json',
    fetchImpl: async () => jsonResponse(prior),
  }), prior);
});
