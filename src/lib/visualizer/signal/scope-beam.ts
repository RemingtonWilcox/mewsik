// Signal's real XY beam, CPU side: each frame it takes the stereo pairs
// whose time has come from the shared scope stream, lays them into the GPU
// window the beam and the channel traces read, and measures them: the
// level and auto gain that size the picture, how much stereo picture there
// is (the genome's reason to show it), and a trigger so the X and Y traces
// stand still on tonal material the way a real scope's sweep does.
//
// Nothing here touches the shared journey: the stream is renderer-only.

import {
	ScopeReader,
	SCOPE_RING_PAIRS,
	createScopeStats,
	measureScope,
	type ScopeStream
} from '$lib/visualizer/scope';
import { SIGNAL_BEAM_MAX_PAIRS, SIGNAL_BEAM_UPSAMPLE, SIGNAL_SCOPE_WINDOW } from './shaders';

export type SignalBeamFrame = {
	/** Window index of the first pair the beam draws this frame. */
	first: number;
	/** Beam segments this frame (pairs x upsampling). */
	segments: number;
	/** Segments per pair. */
	up: number;
	/**
	 * Auto gain: the signal's RMS to a fixed share of the figure's reach, so a
	 * dense mix (high crest) opens up instead of huddling in the centre; the
	 * shader's soft knee keeps its peaks on the face.
	 */
	agc: number;
	/** 0..1 the signal is arriving and audible. */
	live: number;
	/** 0..1 how much stereo picture there is (wide, structured, arriving). */
	interest: number;
	/**
	 * 0..1 the picture is a drawn figure rather than a cloud (slow): a beam
	 * turning slowly enough to trace curves. Noise and dense high partials
	 * scribble a fuzzy ball, which Signal never shows as its hero.
	 */
	structure: number;
	/** Mean XY travel per beam segment, figure-local units (after agc). */
	step: number;
	/** Newest drawn pair after agc (left, right). */
	head: [number, number];
	/** Triggered start and span of the X and Y traces, window indices. */
	traceStart: number;
	traceSpan: number;
	/** Smoothed measures, for the HUD and the voice. */
	width: number;
	correlation: number;
	smoothness: number;
	level: number;
};

function approach(current: number, target: number, tau: number, dt: number) {
	return current + (target - current) * (1 - Math.exp(-dt / Math.max(tau, 1e-3)));
}

function smoothstep(edge0: number, edge1: number, value: number) {
	const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

/** Trace span, seconds: two cycles of 80 Hz. */
const TRACE_SECONDS = 0.025;

export class SignalScopeBeam {
	/** The GPU window: interleaved L, R, oldest first. */
	readonly window = new Float32Array(SIGNAL_SCOPE_WINDOW * 2);
	readonly frame: SignalBeamFrame = {
		first: 0,
		segments: 0,
		up: SIGNAL_BEAM_UPSAMPLE,
		agc: 2,
		live: 0,
		interest: 0,
		structure: 0.5,
		step: 0.002,
		head: [0, 0],
		traceStart: 0,
		traceSpan: 1200,
		width: 0,
		correlation: 1,
		smoothness: 1,
		level: 0
	};
	private readonly reader = new ScopeReader(0.04);
	private readonly stats = createScopeStats();
	private peak = 0.3;
	private rms = 0.15;
	private rawInterest = 0;
	private frequency = 200;

	constructor(private readonly upsample = SIGNAL_BEAM_UPSAMPLE) {
		this.frame.up = upsample;
	}

	update(stream: ScopeStream, dt: number, now: number): SignalBeamFrame {
		const step = Math.max(0, Math.min(0.25, Number.isFinite(dt) ? dt : 0));
		const out = this.frame;
		const range = this.reader.take(stream, step, SIGNAL_BEAM_MAX_PAIRS);
		const written = stream.written;
		const oldest = stream.oldest;
		// The window ends a few pairs past the newest drawn one (the sinc's
		// look-ahead) and holds the history the traces need behind it.
		const drawnEnd = range.start + range.count;
		const end = Math.min(written, drawnEnd + 1 + ScopeReader.MARGIN);
		const start = end - SIGNAL_SCOPE_WINDOW;
		const ring = stream.ring;
		const win = this.window;
		for (let index = 0; index < SIGNAL_SCOPE_WINDOW; index += 1) {
			const pair = start + index;
			if (pair < oldest || pair < 0 || pair >= written) {
				win[index * 2] = 0;
				win[index * 2 + 1] = 0;
				continue;
			}
			const slot = (pair % SCOPE_RING_PAIRS) * 2;
			win[index * 2] = ring[slot];
			win[index * 2 + 1] = ring[slot + 1];
		}
		out.first = range.start - start;
		out.segments = range.count * this.upsample;

		const fresh = now - stream.lastAt < 300 && written > 0;
		if (range.count > 0) {
			measureScope(stream, range.start, range.count, this.stats);
			const s = this.stats;
			// Peak envelope: fast attack, slow release, so the picture keeps its
			// size through a quiet bar and shrinks only when the music does.
			this.peak = s.peak > this.peak ? approach(this.peak, s.peak, 0.08, step) : approach(this.peak, s.peak, 3, step);
			out.level = approach(out.level, s.rms, 0.25, step);
			this.rms = s.rms > this.rms ? approach(this.rms, s.rms, 0.15, step) : approach(this.rms, s.rms, 2.5, step);
			out.width = approach(out.width, s.width, 0.6, step);
			out.correlation = approach(out.correlation, s.correlation, 0.6, step);
			out.smoothness = approach(out.smoothness, s.smoothness, 0.6, step);
			this.frequency = approach(this.frequency, s.frequency, 0.5, step);
			out.step = Math.max(1e-5, (s.path * out.agc) / Math.max(1, out.segments));
		} else if (!fresh) {
			out.level = approach(out.level, 0, 0.25, step);
		}
		const target = Math.min(9, Math.max(0.9, Math.min(0.42 / Math.max(this.rms, 0.01), 1.6 / Math.max(this.peak, 0.02))));
		out.agc = approach(out.agc, target, 0.6, step);
		out.live = approach(out.live, fresh && out.level > 0.004 ? 1 : 0, fresh ? 0.25 : 0.4, step);
		// Stereo picture: a wide image (side energy) that draws smooth curves
		// (tonal, or a drawing) rather than scribble, and is actually there.
		const wide = smoothstep(0.03, 0.22, out.width);
		const drawn = (1 - smoothstep(350, 1100, this.frequency)) * smoothstep(0.3, 0.8, out.smoothness);
		out.structure = approach(out.structure, drawn, 1.5, step);
		const present = smoothstep(0.004, 0.03, out.level);
		this.rawInterest = wide * drawn * present * out.live;
		out.interest = approach(out.interest, this.rawInterest, 1.2, step);

		const newest = Math.max(0, Math.min(SIGNAL_SCOPE_WINDOW - 1, drawnEnd - start));
		out.head[0] = win[newest * 2] * out.agc;
		out.head[1] = win[newest * 2 + 1] * out.agc;
		this.trigger(newest, range.rate);
		return out;
	}

	/**
	 * Polar silhouette of the XY picture as drawn (gain, axis knee, rotation):
	 * the farthest reach per angular sector over the window's newest pairs,
	 * gaps filled from neighbours, so the horizon remembers the real picture.
	 */
	silhouette(out: Float32Array, turn: number): Float32Array {
		const bins = out.length;
		out.fill(-1);
		const win = this.window;
		const agc = this.frame.agc;
		const c = Math.cos(turn);
		const s = Math.sin(turn);
		const end = Math.max(0, Math.min(SIGNAL_SCOPE_WINDOW, this.frame.first + this.frame.segments / this.upsample + 1));
		const start = Math.max(0, end - 1600);
		for (let index = start; index < end; index += 2) {
			const l = 0.95 * Math.tanh((win[index * 2] * agc) / 0.95);
			const r = 0.95 * Math.tanh((win[index * 2 + 1] * agc) / 0.95);
			const x = l * c - r * s;
			const y = l * s + r * c;
			const bin = Math.floor(((Math.atan2(y, x) / (Math.PI * 2) + 1) % 1) * bins) % bins;
			const reach = Math.hypot(x, y);
			if (reach > out[bin]) out[bin] = reach;
		}
		for (let pass = 0; pass < bins; pass += 1) {
			let missing = 0;
			for (let b = 0; b < bins; b += 1) {
				if (out[b] >= 0) continue;
				const left = out[(b + bins - 1) % bins];
				const right = out[(b + 1) % bins];
				if (left >= 0 || right >= 0) out[b] = Math.max(left, right) * 0.9;
				else missing += 1;
			}
			if (missing === bins) {
				out.fill(0);
				break;
			}
			if (missing === 0) break;
		}
		return out;
	}

	/**
	 * Rising-edge trigger on the left channel (a scope's channel 1 source):
	 * the latest crossing that leaves a whole span after it, with a little
	 * hysteresis so hiss cannot trigger. Free-runs (the newest span) when
	 * nothing crosses.
	 */
	private trigger(newest: number, rate: number) {
		const out = this.frame;
		const win = this.window;
		const span = Math.max(64, Math.min(SIGNAL_SCOPE_WINDOW / 3, Math.round(rate * TRACE_SECONDS)));
		out.traceSpan = span;
		const latest = newest - span;
		const earliest = Math.max(20, latest - span * 2);
		const hysteresis = 0.06 * Math.max(this.peak, 0.02);
		for (let index = latest; index >= earliest; index -= 1) {
			const a = win[(index - 1) * 2];
			const b = win[index * 2];
			if (a < 0 && b >= 0) {
				let armed = false;
				for (let back = index - 2; back >= index - 20; back -= 1) {
					if (win[back * 2] < -hysteresis) {
						armed = true;
						break;
					}
				}
				if (armed) {
					out.traceStart = index - 1 + -a / Math.max(b - a, 1e-6);
					return;
				}
			}
		}
		out.traceStart = Math.max(0, latest);
	}
}
