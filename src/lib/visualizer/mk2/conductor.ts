// Soma's reactive rails. The conductor lives in the shared journey and is
// rebuilt for every source, so it only owns what may restart with a song:
// fast transients (impact, kick, sparkle), a macro breath, and a few
// monotonic phases other systems read. Everything that must never visibly
// restart (the animal, its world, its camera, the slow envelopes) lives in
// SomaLook (look.ts), which the journey keeps across sources.

import type { VisualDirectorFrame, VisualizerSection } from '$lib/visualizer/director/types';
import { signalSeedWord, type SignalConductorFrame, type SignalSeed } from '$lib/visualizer/signal/conductor';
import type { SignalSpectrumProfile } from '$lib/visualizer/signal/spectrum';
import { somaLifecycleTarget } from './look';
import type { MusicCharacter } from '$lib/visualizer/character';

export type Mk2Seed = SignalSeed;

export type Mk2ConductorFrame = {
	section: VisualizerSection;
	/** Fast transient envelope 0..1: ~18 ms attack, ~300 ms release. */
	impact: number;
	/** Sub/kick transient 0..1, the bell's contraction strength. */
	kick: number;
	/** Presence/air transient 0..1, photophore glints and comb shimmer. */
	sparkle: number;
	/** Slow macro energy 0..1. */
	breath: number;
	/** Build anticipation 0..1; only grows from positive build evidence. */
	tension: number;
	/** Unwrapped slow spin of the animal's frame of reference. */
	rotationPhase: number;
	/** Signed radians per second; direction fixed for the seed's lifetime. */
	rotationRate: number;
	/** Monotonic camera-rail phase, advancing slowly even in silence. */
	cameraPhase: number;
	/** Monotonic water-current phase, advancing slowly even in silence. */
	backgroundFlowPhase: number;
	/** Lifecycle weights (sum to one), crossfaded over seconds. */
	seedForm: number;
	sproutForm: number;
	windingForm: number;
	bloomForm: number;
	sheddingForm: number;
	dormancyForm: number;
};

function clamp(value: number, low: number, high: number): number {
	return Math.min(high, Math.max(low, value));
}

function finite(value: number | undefined, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Exponential approach with separate rise/fall time constants (seconds). */
function approachAsymmetric(current: number, target: number, rise: number, fall: number, dt: number): number {
	const tau = target > current ? rise : fall;
	return current + (target - current) * (1 - Math.exp(-dt / Math.max(1e-4, tau)));
}

export class Mk2Conductor {
	private readonly seedPhase: number;
	private readonly direction: number;
	private readonly output: Mk2ConductorFrame;
	private impact = 0;
	private kick = 0;
	private sparkle = 0;
	private breath = 0;
	private tension = 0;
	private rotationRate: number;
	private rotationPhase = 0;
	private cameraPhase: number;
	private backgroundFlowPhase: number;
	private readonly forms = [0, 0, 0, 0, 0, 1];
	private previousBass = 0;
	private previousTreble = 0;

	constructor(seed: Mk2Seed = 0) {
		const word = signalSeedWord(seed);
		this.seedPhase = (word % 10_000) / 10_000;
		this.direction = (word >>> 13) % 2 === 0 ? 1 : -1;
		this.rotationRate = this.direction * 0.012;
		this.cameraPhase = this.seedPhase * 6;
		this.backgroundFlowPhase = this.seedPhase * Math.PI * 2;
		this.output = {
			section: 'calm',
			impact: 0,
			kick: 0,
			sparkle: 0,
			breath: 0,
			tension: 0,
			rotationPhase: 0,
			rotationRate: this.rotationRate,
			cameraPhase: this.cameraPhase,
			backgroundFlowPhase: this.backgroundFlowPhase,
			seedForm: 0,
			sproutForm: 0,
			windingForm: 0,
			bloomForm: 0,
			sheddingForm: 0,
			dormancyForm: 1
		};
	}

	/**
	 * Advance one analyzer (or silence) tick. The Signal conductor is optional:
	 * when present its impact rail is honoured, otherwise the director and the
	 * shared spectrum are enough.
	 */
	update(
		frame: VisualDirectorFrame,
		spectrum: Readonly<SignalSpectrumProfile>,
		dtSeconds: number,
		signal?: Readonly<SignalConductorFrame> | null,
		// What kind of music is playing; a new shiftSerial means it just changed.
		_character?: Readonly<MusicCharacter> | null
	): Readonly<Mk2ConductorFrame> {
		const dt = clamp(finite(dtSeconds, 1 / 60), 1 / 1000, 0.25);
		const silent = frame.silence;

		const bass = silent ? 0 : clamp(finite(spectrum.bass), 0, 1);
		const treble = silent ? 0 : clamp(finite(spectrum.treble), 0, 1);
		const kickRise = Math.max(0, bass - this.previousBass);
		const trebleRise = Math.max(0, treble - this.previousTreble);
		this.previousBass = bass;
		this.previousTreble = treble;
		const kickDelta = clamp(finite(spectrum.deltas?.kick) + finite(spectrum.deltas?.sub) * 0.5, 0, 1);
		const airDelta = clamp(finite(spectrum.deltas?.presence) + finite(spectrum.deltas?.air) * 0.6, 0, 1);

		const impactTarget = silent
			? 0
			: clamp(
					Math.max(
						// No clock.beatPulse here: a fresh source with no audio would
						// synthesize an initial impact from the beat grid alone.
						finite(signal?.impact) * 0.85,
						finite(frame.bassPunch) * 0.5,
						kickDelta * 0.9 + kickRise * 2,
						finite(spectrum.novelty) * 0.55
					),
					0,
					1
				);
		this.impact = approachAsymmetric(this.impact, impactTarget, 0.018, 0.3, dt);

		const kickTarget = silent ? 0 : clamp(Math.max(kickDelta * 1.1 + kickRise * 2.4, finite(frame.bassPunch) * 0.7), 0, 1);
		this.kick = approachAsymmetric(this.kick, kickTarget, 0.015, 0.22, dt);
		const sparkleTarget = silent ? 0 : clamp(airDelta * 1.2 + trebleRise * 3 + finite(frame.trebleSparkle) * 0.25, 0, 1);
		this.sparkle = approachAsymmetric(this.sparkle, sparkleTarget, 0.02, 0.25, dt);

		const breathTarget = silent ? 0 : clamp(finite(frame.energy) * 0.7 + finite(frame.context?.sectionEnergy) * 0.3, 0, 1);
		this.breath = approachAsymmetric(this.breath, breathTarget, 0.9, 1.6, dt);
		const buildEvidence = frame.drop.buildActive ? clamp(finite(frame.drop.buildProgress), 0, 1) : 0;
		const tensionTarget = Math.max(buildEvidence, clamp(finite(frame.drop.anticipation), 0, 1));
		this.tension = approachAsymmetric(this.tension, silent ? 0 : tensionTarget, 0.8, 1.2, dt);

		// Monotonic rails: never wrap, never reverse, slow but non-zero in silence.
		const rate = clamp(0.01 + this.breath * 0.018 + finite(frame.motion) * 0.006, 0.006, 0.04);
		this.rotationRate += (this.direction * rate - this.rotationRate) * (1 - Math.exp(-dt / 0.4));
		this.rotationPhase += this.rotationRate * dt;
		this.cameraPhase += (0.012 + this.breath * 0.025) * dt;
		this.backgroundFlowPhase += (0.02 + this.breath * 0.04 + this.tension * 0.02) * dt;

		const lifeTarget = somaLifecycleTarget(frame.section);
		let total = 0;
		for (let i = 0; i < 6; i += 1) {
			this.forms[i] += (lifeTarget[i] - this.forms[i]) * (1 - Math.exp(-dt / 2.5));
			total += this.forms[i];
		}
		const norm = total > 1e-6 ? 1 / total : 1;

		const out = this.output;
		out.section = frame.section;
		out.impact = this.impact;
		out.kick = this.kick;
		out.sparkle = this.sparkle;
		out.breath = this.breath;
		out.tension = this.tension;
		out.rotationPhase = this.rotationPhase;
		out.rotationRate = this.rotationRate;
		out.cameraPhase = this.cameraPhase;
		out.backgroundFlowPhase = this.backgroundFlowPhase;
		out.seedForm = this.forms[0] * norm;
		out.sproutForm = this.forms[1] * norm;
		out.windingForm = this.forms[2] * norm;
		out.bloomForm = this.forms[3] * norm;
		out.sheddingForm = this.forms[4] * norm;
		out.dormancyForm = this.forms[5] * norm;
		return out;
	}
}
