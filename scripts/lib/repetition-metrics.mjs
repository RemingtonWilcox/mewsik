// Repetition metrics shared by scripts/visual-repetition-test.mjs and the
// offline recompute in scripts/repetition-from-matrix.mjs.

export function median(values) {
	const s = [...values].sort((x, y) => x - y);
	return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/**
 * Repetition metrics from a symmetric distance matrix sampled every `sampleMs`.
 * Thresholds are relative to the run's median pair distance (scale-free).
 *   recurrence     share of frames (after the first 45 s) whose nearest frame
 *                  at least 45 s earlier is within 0.5 x median: returns to a
 *                  look already shown
 *   nearDuplicate  the same at 0.3 x median: near-identical returns
 *   vocabulary     how many distinct states it takes to cover 80% of the
 *                  run (greedy clusters at 0.6 x median, largest first): an
 *                  engine cycling a few states needs few, an engine that
 *                  keeps finding new looks needs many
 *   revisits       mean number of separate visits per state among those
 *                  states (re-entered after 45 s counts again): high = the
 *                  engine cycles through a small set of states
 *   cadence        strongest autocorrelation of the change signal beyond its
 *                  first zero crossing (10-120 s): change on a fixed rhythm
 *   parked         share of 10 s windows with almost no change
 */
export function repetitionMetrics(D, sampleMs) {
	const n = D.length;
	const all = [];
	for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) all.push(D[i][j]);
	const typical = median(all);
	const gap = Math.ceil(45_000 / sampleMs);
	const recurrenceAt = (k) => {
		let hit = 0;
		let total = 0;
		for (let i = gap; i < n; i += 1) {
			let nearest = Infinity;
			for (let j = 0; j <= i - gap; j += 1) if (D[i][j] < nearest) nearest = D[i][j];
			total += 1;
			if (nearest < typical * k) hit += 1;
		}
		return hit / Math.max(1, total);
	};
	// Greedy leader clustering.
	const leaders = [];
	const label = new Array(n).fill(-1);
	for (let i = 0; i < n; i += 1) {
		let best = -1;
		let bestD = typical * 0.6;
		for (let c = 0; c < leaders.length; c += 1) {
			if (D[i][leaders[c]] < bestD) {
				bestD = D[i][leaders[c]];
				best = c;
			}
		}
		if (best < 0) {
			leaders.push(i);
			best = leaders.length - 1;
		}
		label[i] = best;
	}
	const sizes = new Array(leaders.length).fill(0);
	for (const l of label) sizes[l] += 1;
	const order = sizes.map((size, c) => [size, c]).sort((a, b) => b[0] - a[0]);
	const covering = [];
	let covered = 0;
	for (const [size, c] of order) {
		if (covered >= n * 0.8) break;
		covering.push(c);
		covered += size;
	}
	const vocabulary = covering.length;
	const visits = new Array(leaders.length).fill(0);
	const lastSeen = new Array(leaders.length).fill(-Infinity);
	for (let i = 0; i < n; i += 1) {
		const c = label[i];
		if (i - lastSeen[c] > gap) visits[c] += 1;
		lastSeen[c] = i;
	}
	const revisits = covering.length ? covering.reduce((sum, c) => sum + visits[c], 0) / covering.length : 0;
	// Cadence beyond the first zero crossing.
	const change = [];
	for (let i = 1; i < n; i += 1) change.push(D[i][i - 1]);
	const mean = change.reduce((a, b) => a + b, 0) / Math.max(1, change.length);
	const c = change.map((x) => x - mean);
	const var0 = c.reduce((a, b) => a + b * b, 0) || 1;
	const r = (lag) => {
		let sum = 0;
		for (let i = 0; i + lag < c.length; i += 1) sum += c[i] * c[i + lag];
		return (sum / var0) * (c.length / Math.max(1, c.length - lag));
	};
	const maxLag = Math.min(Math.round(120_000 / sampleMs), Math.floor(c.length / 2));
	let firstZero = 1;
	while (firstZero < maxLag && r(firstZero) > 0) firstZero += 1;
	let cadence = 0;
	let cadenceLag = 0;
	for (let lag = Math.max(firstZero, Math.round(10_000 / sampleMs)); lag <= maxLag; lag += 1) {
		const v = r(lag);
		if (v > cadence) {
			cadence = v;
			cadenceLag = (lag * sampleMs) / 1000;
		}
	}
	const win = Math.round(10_000 / sampleMs);
	let parked = 0;
	let windows = 0;
	for (let i = 0; i + win < n; i += win) {
		windows += 1;
		if (D[i][i + win] < typical * 0.2) parked += 1;
	}
	const round = (x) => Number(x.toFixed(3));
	return {
		recurrence: round(recurrenceAt(0.5)),
		nearDuplicate: round(recurrenceAt(0.3)),
		vocabulary,
		revisits: round(revisits),
		cadence: round(cadence),
		cadenceLagSeconds: cadenceLag,
		parked: round(parked / Math.max(1, windows))
	};
}

export function formatResult(r) {
	return `${r.engine.padEnd(8)} recurrence ${(r.recurrence * 100).toFixed(1).padStart(5)}%  near-dup ${(r.nearDuplicate * 100).toFixed(1).padStart(5)}%  vocabulary ${String(r.vocabulary).padStart(3)} x ${r.revisits.toFixed(1)} visits  cadence ${r.cadence.toFixed(2)} @${String(r.cadenceLagSeconds).padStart(3)}s  parked ${(r.parked * 100).toFixed(1).padStart(5)}%${r.reloads ? `  (${r.reloads} reloads!)` : ''}`;
}

