import { parseArgs } from 'node:util';
import { loadPreviousSnapshot, writeSnapshot } from './generator.mjs';

const { values } = parseArgs({
  options: {
    output: { type: 'string', default: process.env.MEWSIK_DISCOVERY_OUTPUT_DIR || '_site' },
    previous: { type: 'string', default: process.env.MEWSIK_DISCOVERY_PREVIOUS_SNAPSHOT },
    'previous-url': { type: 'string', default: process.env.MEWSIK_DISCOVERY_PREVIOUS_URL },
  },
  strict: true,
});

const previous = await loadPreviousSnapshot({
  filePath: values.previous,
  url: values['previous-url'],
});

const { outputPath, snapshot } = await writeSnapshot({
  outputDirectory: values.output,
  previous,
  youtubeApiKey: process.env.MEWSIK_YOUTUBE_API_KEY,
  lastfmApiKey: process.env.MEWSIK_LASTFM_API_KEY,
});

// Log only public state. Provider credentials and request URLs are never serialized or printed.
const summary = snapshot.sources.map(({ id, state }) => `${id}=${state}`).join(', ');
process.stdout.write(`Wrote ${outputPath} (${summary})\n`);
