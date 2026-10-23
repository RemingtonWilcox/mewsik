// Write the ensemble listener's synthesised test music to WAV files, with
// each file's ground truth (chords, drum hits, fills, swing, articulation,
// drop-outs) beside it as JSON. The same generator feeds the browser specs
// (src/lib/visualizer/lab/ensemble-signals.ts), so a WAV played through the
// lab's file picker, or the native analyzer's dump test, is the music the
// specs score.
//
//   node scripts/ensemble-wavs.mjs [outDir]     (default output/ensemble/wavs)
//
// Then, for the native path:
//   ENSEMBLE_WAV_DIR=<outDir> cargo test --manifest-path src-tauri/Cargo.toml \
//     dump_native_features -- --ignored
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformWithEsbuild } from 'vite';

const outDir = resolve(process.argv[2] ?? 'output/ensemble/wavs');
mkdirSync(outDir, { recursive: true });
// The generator is dependency-free TypeScript: strip the types and load it.
const source = resolve('src/lib/visualizer/lab/ensemble-signals.ts');
const { code } = await transformWithEsbuild(readFileSync(source, 'utf8'), source, { format: 'esm' });
const compiled = join(outDir, '.ensemble-signals.mjs');
writeFileSync(compiled, code);
const { ENSEMBLE_SIGNAL_IDS, ensembleSignal, encodeWav } = await import(pathToFileURL(compiled).href);
rmSync(compiled);
for (const id of ENSEMBLE_SIGNAL_IDS) {
	const signal = ensembleSignal(id);
	writeFileSync(join(outDir, `${id}.wav`), encodeWav(signal.left, signal.right, signal.sampleRate));
	const { left, right, ...truth } = signal;
	writeFileSync(join(outDir, `${id}.truth.json`), JSON.stringify(truth, null, 1));
	console.log(`${id}.wav  ${(left.length / signal.sampleRate).toFixed(1)} s  ${signal.description}`);
}
