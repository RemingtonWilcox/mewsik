<script lang="ts">
	// Mark II visualizer — "Drift Through a Fractal Atmosphere"
	//
	// Architecture per research findings:
	//   • Mandelbulb SDF raymarched as the hero — a genuine fractal architecture,
	//     not a smoothed primitive. Forms read as alien geology, not "blob."
	//   • Volumetric participating medium — fog accumulates with transmittance
	//     and phase-weighted key light, while the hero retains real soft shadow.
	//     Atmosphere stays dimensional without nesting a shadow raymarch inside
	//     every fog sample.
	//   • Catmull-Rom camera path through 6 waypoints. Eased traversal speed.
	//     Camera looks at origin (where the Mandelbulb sits). Authored motion,
	//     not procedural drift.
	//   • Photographic 7-stop palette interpolated smoothly — golden hour /
	//     dusk / deep space stops, never cosine RGB.
	//   • AgX filmic tone map + procedural film grain + edge chromatic
	//     aberration + vignette + dither for post-processing signature.
	//
	// Audio routing (multiple timescales):
	//   • bass (fast)        → organism breath/growth + fog density
	//   • mid (medium)       → topology detail, twist + specular sharpness
	//   • treble (fast)      → grain intensity, small surface ripple
	//   • centroid (slow)    → palette LERP position
	//   • chromaKey (slow)   → key light hue
	//   • bpmNorm (slow)     → camera traversal speed multiplier
	//   • rms (slow)         → light shaft intensity
	//   • onset (impulse)    → tiny camera nudge
	//
	// Future iterations: optional quality tiers, real circle-of-confusion DOF,
	// Mandelbox / hybrid IFS variants per song seed.

	import { onMount, onDestroy } from 'svelte';
	import { useVisualizer } from '$lib/state/visualizer.svelte';
	import { usePlayer } from '$lib/state/player.svelte';
	import { createVisualDirector } from '$lib/visualizer/visual-director';
	import { stringHash01 } from '$lib/visualizer/director/util';

	const vis = useVisualizer();
	const player = usePlayer();
	let director = createVisualDirector();
	const t0 = performance.now();
	let { showHud = false } = $props<{ showHud?: boolean }>();

	let canvas = $state<HTMLCanvasElement | null>(null);
	let errorMsg = $state<string | null>(null);
	let gpuReady = $state(false);
	let raf = 0;
	let unsub: (() => void) | null = null;
	let initGeneration = 0;
	// Tripped in onDestroy before teardownGpu so any in-flight RAF tick early-
	// returns instead of touching destroyed GPU resources mid-frame.
	let running = false;
	// Per-TRACK identity seed (Lomas principle): hashed from the recording id,
	// so the same song always grows the same organism — palette family, camera
	// identity, FOV, roll — and every different song gets a different world.
	// Falls back to a random session seed when nothing identifiable plays.
	let mk2SongSeed = Math.random();
	let mk2TrackKey: string | null = null;

	// Phrase/section events move toward new authored framings. The offset is
	// eased instead of cutting the camera, and each track keeps one coherent
	// palette family instead of jumping colour worlds mid-song.
	let camPhaseOffset = 0;
	let camPhaseTargetOffset = 0;
	let lastPhraseIndex = -1;
	let lastDirSection = '';
	let audioWarmupFrames = 0;
	let temporalResetRequested = true;

	// ──────────────────────────────────────────────────────────────────────────
	// Audio smoothing — multiple timescales per research recommendation.
	// Fast-attack/release for transient-driven params; slow for mood-driven.
	// ──────────────────────────────────────────────────────────────────────────
	const smoothed = {
		bass: 0,
		mid: 0,
		treble: 0,
		centroidSlow: 0.5,
		chromaXSlow: 1,
		chromaYSlow: 0,
		rmsSlow: 0,
		bpmNormSlow: 0.4,
		flash: 0,
		// ADSR channels — onset response decomposed so different visual
		// behaviors can ride different envelope shapes.
		staccato: 0, // attack-only spike; decays ~60ms half-life
		sustain: 0, // slow-follower of long-RMS; ~5s window
		reverbStart: -10, // wall-time of last onset; used to derive reverbT
		smoothEnergy: 0 // 200ms attack / 800ms release follower for macro modulations
	};

	function lerp(a: number, b: number, t: number) {
		return a + (b - a) * t;
	}

	function smoothstepJs(edge0: number, edge1: number, x: number) {
		const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
		return t * t * (3 - 2 * t);
	}

	// ──────────────────────────────────────────────────────────────────────────
	// Catmull-Rom camera waypoint path. Six hand-picked positions around the
	// origin where the fractal lives. Camera always looks at origin (slightly
	// below to put hero in upper-center of frame for compositional weight).
	// ──────────────────────────────────────────────────────────────────────────
	const CAM_WAYPOINTS: [number, number, number][] = [
		[3.5, 1.2, 3.0],
		[-2.0, 2.4, 2.6],
		[-3.6, 0.8, -1.4],
		[-0.5, 2.6, -3.4],
		[2.8, 1.8, -2.4],
		[3.6, 0.4, 1.1]
	];

	// ──────────────────────────────────────────────────────────────────────────
	// Song section state machine. Real-time analysis maintains rolling RMS +
	// onset density buffers; transitions fire on detected events (drops,
	// buildups, releases). Each state has a dramatic mood template so the
	// visual reads as qualitatively different per section, not the same form
	// with subtle dialing.
	//
	// Detection rules (all relative to ~8-second windows):
	//   calm     → rising:    sustained positive RMS delta + transient density rising
	//   rising   → peak:      RMS high (>0.32) with onset burst (drop landing)
	//   peak     → releasing: sustained negative RMS delta
	//   releasing→ calm:      RMS low (<0.10) for >2s
	//   Any → calm fallback:  RMS < 0.05 for >3s
	// ──────────────────────────────────────────────────────────────────────────
	type SongState = 'calm' | 'rising' | 'peak' | 'releasing';
	type StateMood = {
		palOffset: number;
		power: number;
		fogMul: number;
		shaftMul: number;
		camDistMul: number; // camera distance scale
		camSpeedMul: number; // camera traversal speed scale
	};
	const STATE_MOODS: Record<SongState, StateMood> = {
		// Calm: cool, distant, slow, dim. Palette in deep navy / plum end.
		calm: {
			palOffset: 0.02,
			power: 6.8,
			fogMul: 0.5,
			shaftMul: 0.45,
			camDistMul: 1.25,
			camSpeedMul: 0.55
		},
		// Rising: warming, pushing in, increasing fog, palette moves toward gold.
		rising: {
			palOffset: 0.45,
			power: 7.5,
			fogMul: 0.95,
			shaftMul: 1.05,
			camDistMul: 1.0,
			camSpeedMul: 0.95
		},
		// Peak: hot, close, fast, full fog, palette in cream/gold. Drop hits live here.
		peak: {
			palOffset: 0.6,
			power: 8.4,
			fogMul: 1.3,
			shaftMul: 1.45,
			camDistMul: 0.92,
			camSpeedMul: 1.25
		},
		// Releasing: cooling out, pulling back, palette moves to steel/cyan.
		releasing: {
			palOffset: 0.85,
			power: 7.4,
			fogMul: 0.85,
			shaftMul: 0.9,
			camDistMul: 1.15,
			camSpeedMul: 0.7
		}
	};

	let songState = $state<SongState>('calm');
	let stateEnterTime = 0;
	let previousMood: StateMood = STATE_MOODS.calm;

	// 8-second rolling buffers @ ~60 Hz emit (lab) — overshoots slightly to give
	// us headroom for window stats.
	const HIST_LEN = 8 * 60;
	const rmsHist = new Float32Array(HIST_LEN);
	const onsetHist = new Float32Array(HIST_LEN);
	let histIdx = 0;
	let histFilled = 0;

	function pushHist(rms: number, onset: number) {
		rmsHist[histIdx] = rms;
		onsetHist[histIdx] = onset;
		histIdx = (histIdx + 1) % HIST_LEN;
		histFilled = Math.min(HIST_LEN, histFilled + 1);
	}

	function avgWindow(buf: Float32Array, startBack: number, len: number): number {
		let sum = 0;
		let n = 0;
		for (let i = 0; i < len; i++) {
			const idx = (histIdx - startBack - i - 1 + HIST_LEN * 2) % HIST_LEN;
			if (i < histFilled) {
				sum += buf[idx];
				n++;
			}
		}
		return n > 0 ? sum / n : 0;
	}

	function catmullRom3(
		t: number,
		p0: number[],
		p1: number[],
		p2: number[],
		p3: number[]
	): [number, number, number] {
		const t2 = t * t;
		const t3 = t2 * t;
		const r: [number, number, number] = [0, 0, 0];
		for (let i = 0; i < 3; i++) {
			r[i] =
				0.5 *
				(2 * p1[i] +
					(-p0[i] + p2[i]) * t +
					(2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 +
					(-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3);
		}
		return r;
	}

	// camera-cycle accumulator — driven by state speed multiplier rather than
	// raw time so calm states drift slowly and peak states traverse quickly.
	let camPhase = 0;
	let camPhaseLastTime = 0;

	// One of three authored camera identities per track. The old dive-through
	// and resettable spiral modes regularly crossed the geometry or visibly
	// snapped, so production Mk2 keeps only compositions that preserve a hero.
	//   0 waypoint   — current Catmull-Rom through 6 hand-picked positions
	//   1 ring       — constant-radius azimuthal orbit, slow y drift
	//   2 perched    — high overhead, slow yaw, looking down
	let CAM_MODE = Math.floor(mk2SongSeed * 3) % 3;

	function getCameraPos(
		time: number,
		speedMul: number,
		phaseOffset: number
	): [number, number, number] {
		const baseSpeed = 0.020 + smoothed.bpmNormSlow * 0.025 + smoothed.rmsSlow * 0.015;
		if (camPhaseLastTime === 0) camPhaseLastTime = time;
		const dt = Math.max(0, Math.min(0.1, time - camPhaseLastTime));
		camPhase += dt * baseSpeed * speedMul;
		camPhaseLastTime = time;
		const pathPhase = camPhase + phaseOffset;

		if (CAM_MODE === 1) {
			// Ring orbit — constant radius, azimuthal sweep
			const a = pathPhase * 1.1;
			const radius = 3.4;
			return [Math.cos(a) * radius, 1.0 + Math.sin(pathPhase * 0.27) * 0.65, Math.sin(a) * radius];
		}
		if (CAM_MODE === 2) {
			// Perched overhead — slow yaw, looking down (handled in target)
			const a = pathPhase * 0.35;
			return [Math.cos(a) * 2.4, 3.5, Math.sin(a) * 2.4];
		}
		// Default — original Catmull-Rom waypoint loop
		const cycle =
			((pathPhase % CAM_WAYPOINTS.length) + CAM_WAYPOINTS.length) % CAM_WAYPOINTS.length;
		const i = Math.floor(cycle);
		const f = cycle - i;
		const n = CAM_WAYPOINTS.length;
		const p0 = CAM_WAYPOINTS[(i - 1 + n) % n];
		const p1 = CAM_WAYPOINTS[i];
		const p2 = CAM_WAYPOINTS[(i + 1) % n];
		const p3 = CAM_WAYPOINTS[(i + 2) % n];
		const eased = smoothstepJs(0, 1, f);
		return catmullRom3(eased, p0, p1, p2, p3);
	}

	function resetTrackVisualState(seed: number) {
		// The director owns additional clock/drop/palette/structure envelopes and
		// has no public reset method. A fresh instance is the complete, local
		// reset and prevents a new track inheriting the previous drop or phrase.
		director = createVisualDirector();

		smoothed.bass = 0;
		smoothed.mid = 0;
		smoothed.treble = 0;
		smoothed.centroidSlow = 0.5;
		smoothed.chromaXSlow = 1;
		smoothed.chromaYSlow = 0;
		smoothed.rmsSlow = 0;
		smoothed.bpmNormSlow = 0.4;
		smoothed.flash = 0;
		smoothed.staccato = 0;
		smoothed.sustain = 0;
		smoothed.reverbStart = -10;
		smoothed.smoothEnergy = 0;

		songState = 'calm';
		stateEnterTime = (performance.now() - t0) / 1000;
		previousMood = { ...STATE_MOODS.calm };
		rmsHist.fill(0);
		onsetHist.fill(0);
		histIdx = 0;
		histFilled = 0;

		CAM_MODE = Math.floor(seed * 3) % 3;
		camPhase = seed * CAM_WAYPOINTS.length;
		camPhaseLastTime = 0;
		camPhaseOffset = 0;
		camPhaseTargetOffset = 0;
		lastPhraseIndex = -1;
		lastDirSection = '';

		// Ignore a few analyzer frames while playback swaps sources, then rebuild
		// every temporal target on the render loop before accepting new audio.
		audioWarmupFrames = 3;
		temporalResetRequested = true;
		gpuReady = false;
		resetFrameScheduler();
	}

	$effect(() => {
		const key = player.state.current_recording_id ?? player.state.current_source_url;
		if (key === mk2TrackKey) return;
		mk2TrackKey = key;
		mk2SongSeed = key ? stringHash01(key) : Math.random();
		resetTrackVisualState(mk2SongSeed);
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Uniform layout — 32 f32s = 128 bytes (multiple of 16 ✓)
	// 0-1  resolution
	// 2    time
	// 3-7  audio: bass, mid, treble, centroid, rms
	// 8    flash (onset)
	// 9    bpmNorm
	// 10-11 chromaKey x/y (unit-circle smoothed)
	// 12   chromaStrength
	// 13-15 camera position
	// 16-18 camera forward
	// 19-21 camera right
	// 22-24 camera up
	// 25   fovScale
	// 26   mandelbulbPower (audio + time modulated)
	// 27   paletteOffset (smoothed centroid + chroma → palette T)
	// 28   fogDensity
	// 29   lightShaftIntensity
	// 30-31 pad
	// ──────────────────────────────────────────────────────────────────────────
	// 36 floats = 144 bytes. New slots after _pad1: paletteFamily (0-5 song
	// family index), plus three reserved for future per-song flavor knobs.
	const UNIFORM_FLOATS = 36;
	const UNIFORM_BYTES = UNIFORM_FLOATS * 4;

	const SCENE_WGSL = /* wgsl */ `
struct Uniforms {
	resolutionX: f32,
	resolutionY: f32,
	time: f32,
	bass: f32,
	mid: f32,
	treble: f32,
	centroid: f32,
	rms: f32,
	flash: f32,
	bpmNorm: f32,
	chromaX: f32,
	chromaY: f32,
	chromaStrength: f32,
	camPosX: f32,
	camPosY: f32,
	camPosZ: f32,
	camFwdX: f32,
	camFwdY: f32,
	camFwdZ: f32,
	camRightX: f32,
	camRightY: f32,
	camRightZ: f32,
	camUpX: f32,
	camUpY: f32,
	camUpZ: f32,
	fovScale: f32,
	mandelbulbPower: f32,
	paletteOffset: f32,
	fogDensity: f32,
	lightShaftIntensity: f32,
	_pad0: f32,
	_pad1: f32,
	paletteFamily: f32,
	staccato: f32,   // attack-only spike from onsets, ~60ms decay
	sustain: f32,    // slow-follower of rms, ~5s window — long-form energy
	reverbT: f32,    // time since last onset, normalized 0..1 over 2s
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> bins: array<f32, 64>;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	var pos = array<vec2<f32>, 6>(
		vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
		vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0)
	);
	return vec4<f32>(pos[idx], 0.0, 1.0);
}

// ═══════════════════════════════════════════════════════════════════════════
// 7-stop palette LUT — six families, picked per song via u.paletteFamily.
// Each family is a totally distinct visual world rather than a rotation
// through the same hues. Picked by song seed so every track lands a
// different colour world.
//   0 dusk        photographic — deep navy → plum → burnt orange → cream → teal
//   1 aurora      cool — blacks → indigos → cyans → mint → bright magenta cap
//   2 synthwave   neon — black → hot magenta → cyan → electric purple
//   3 volcanic    warm — black → ember red → orange → bright yellow → bone white
//   4 bioluminous UV → cyan → green → chartreuse on near-black field
//   5 oil-on-water iridescent — petrol blues → magenta → gold → mint shifts
// ═══════════════════════════════════════════════════════════════════════════
fn palette7(t: f32) -> vec3<f32> {
	let s = fract(t);
	let x = s * 7.0;
	let i = i32(floor(x));
	let f = smoothstep(0.0, 1.0, x - floor(x));
	let family = i32(u.paletteFamily);
	var stops = array<vec3<f32>, 7>(
		vec3<f32>(0.020, 0.025, 0.080),
		vec3<f32>(0.090, 0.045, 0.150),
		vec3<f32>(0.380, 0.120, 0.105),
		vec3<f32>(0.880, 0.420, 0.150),
		vec3<f32>(0.950, 0.820, 0.620),
		vec3<f32>(0.460, 0.580, 0.700),
		vec3<f32>(0.090, 0.300, 0.380)
	);
	if (family == 1) {
		// aurora
		stops = array<vec3<f32>, 7>(
			vec3<f32>(0.010, 0.015, 0.045),
			vec3<f32>(0.040, 0.025, 0.180),
			vec3<f32>(0.060, 0.160, 0.420),
			vec3<f32>(0.180, 0.580, 0.640),
			vec3<f32>(0.520, 0.880, 0.640),
			vec3<f32>(0.900, 0.500, 0.880),
			vec3<f32>(0.310, 0.080, 0.380)
		);
	} else if (family == 2) {
		// synthwave neon
		stops = array<vec3<f32>, 7>(
			vec3<f32>(0.020, 0.010, 0.040),
			vec3<f32>(0.260, 0.020, 0.180),
			vec3<f32>(0.980, 0.140, 0.520),
			vec3<f32>(0.620, 0.080, 0.860),
			vec3<f32>(0.060, 0.780, 0.940),
			vec3<f32>(0.180, 0.220, 0.640),
			vec3<f32>(0.880, 0.300, 0.760)
		);
	} else if (family == 3) {
		// volcanic
		stops = array<vec3<f32>, 7>(
			vec3<f32>(0.018, 0.008, 0.005),
			vec3<f32>(0.220, 0.030, 0.020),
			vec3<f32>(0.640, 0.080, 0.040),
			vec3<f32>(0.940, 0.380, 0.070),
			vec3<f32>(0.980, 0.760, 0.180),
			vec3<f32>(0.980, 0.940, 0.760),
			vec3<f32>(0.400, 0.100, 0.030)
		);
	} else if (family == 4) {
		// bioluminous
		stops = array<vec3<f32>, 7>(
			vec3<f32>(0.005, 0.020, 0.030),
			vec3<f32>(0.020, 0.060, 0.260),
			vec3<f32>(0.040, 0.420, 0.580),
			vec3<f32>(0.180, 0.880, 0.620),
			vec3<f32>(0.720, 0.980, 0.220),
			vec3<f32>(0.080, 0.640, 0.480),
			vec3<f32>(0.040, 0.180, 0.220)
		);
	} else if (family == 5) {
		// oil-on-water iridescent
		stops = array<vec3<f32>, 7>(
			vec3<f32>(0.030, 0.060, 0.140),
			vec3<f32>(0.140, 0.080, 0.420),
			vec3<f32>(0.060, 0.640, 0.720),
			vec3<f32>(0.880, 0.380, 0.620),
			vec3<f32>(0.980, 0.840, 0.300),
			vec3<f32>(0.580, 0.940, 0.640),
			vec3<f32>(0.380, 0.120, 0.520)
		);
	}
	let a = stops[(i % 7 + 7) % 7];
	let b = stops[((i + 1) % 7 + 7) % 7];
	return mix(a, b, f);
}

// ═══════════════════════════════════════════════════════════════════════════
// Mandelbulb distance estimator. Iterates the formula z = z^n + c where
// raising to power n is done in spherical coordinates. Returns a distance
// approximation via the derivative magnitude — accurate enough to raymarch
// without overshooting the genuine fractal boundary.
// ═══════════════════════════════════════════════════════════════════════════
// iters now passed in — audio-driven from caller so the fractal literally
// reveals more detail during high-energy sections. 4 = smooth blob (calm),
// 11 = full fractal detail (drop/chorus). This is the actual "evolution"
// the user wants: the geometry has more or less complexity, not just a
// pulsing version of the same shape.
fn mandelbulbDE(p: vec3<f32>, power: f32, iters: i32) -> f32 {
	var z = p;
	var dr = 1.0;
	var r = 0.0;
	for (var i: i32 = 0; i < iters; i = i + 1) {
		r = length(z);
		if (r > 2.0) { break; }
		let safeR = max(r, 1e-5);
		let theta = acos(clamp(z.z / safeR, -1.0, 1.0));
		let phi = atan2(z.y, z.x);
		dr = pow(safeR, power - 1.0) * power * dr + 1.0;
		let zr = pow(safeR, power);
		let nTheta = theta * power;
		let nPhi = phi * power;
		z = zr * vec3<f32>(
			sin(nTheta) * cos(nPhi),
			sin(nPhi) * sin(nTheta),
			cos(nTheta)
		);
		z = z + p;
	}
	let safeR = max(r, 1e-5);
	return 0.5 * log(safeR) * safeR / max(dr, 1e-5);
}

fn rot2(v: vec2<f32>, a: f32) -> vec2<f32> {
	let c = cos(a);
	let s = sin(a);
	return vec2<f32>(c * v.x - s * v.y, s * v.x + c * v.y);
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
	let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
	return mix(b, a, h) - k * h * (1.0 - h);
}

fn smax(a: f32, b: f32, k: f32) -> f32 {
	return -smin(-a, -b, k);
}

fn safeNormalize(v: vec3<f32>, fallback: vec3<f32>) -> vec3<f32> {
	let lenV = length(v);
	if (lenV < 1e-5) {
		return fallback;
	}
	return v / lenV;
}

fn organismWarp(p: vec3<f32>) -> vec3<f32> {
	let growth = u._pad0;
	let tension = u._pad1;
	// BPM-locked breath rate — bpmNorm scales how fast the organism inflates.
	// 60bpm song = slow swelling, 174bpm dnb = rapid pulsing. Different songs
	// genuinely feel different in rhythm, not just one idle speed.
	let tempoT = u.time * (0.6 + u.bpmNorm * 1.2);
	let breath = 1.0 + u.rms * 0.22 + u.bass * 0.16 + u.flash * 0.08 + sin(tempoT) * 0.04 * (0.5 + u.bpmNorm);
	var q = p / breath;

	// Continuous unfolding — slow time-driven displacement that accumulates
	// across the song. Multi-period sinusoids (different frequencies per
	// axis) so the organism never returns to the same silhouette during a
	// session. Period ~30-60s; visible drift but not jittery per frame.
	// Drift rate ALSO scales with bpmNorm so faster songs unfold faster.
	let tSlow = u.time * (0.04 + u.bpmNorm * 0.08);
	let drift = vec3<f32>(
		sin(q.y * 0.9 + tSlow) * 0.07 + cos(q.z * 0.7 - tSlow * 0.6) * 0.05,
		sin(q.x * 0.7 - tSlow * 0.4) * 0.05,
		cos(q.x * 0.9 + tSlow * 0.8) * 0.07 + sin(q.y * 0.7 + tSlow * 0.5) * 0.05
	);
	q = q + drift * (0.5 + growth * 0.7);

	// Section-driven anisotropic stretch — gentler than the failed attempt.
	// 0.18 amplitude means clear silhouette change between sections without
	// the raymarcher safety factor needing to be aggressive.
	let differential = tension - growth;
	let stretchY = 1.0 + differential * 0.18;
	let stretchXZ = 1.0 - differential * 0.14;
	q.x = q.x / stretchXZ;
	q.z = q.z / stretchXZ;
	q.y = q.y / stretchY;

	// Chroma-driven structural axis — chord position (chromaX, chromaY) is
	// the smoothed unit-circle representation of the song's dominant pitch
	// class. We torque the entire organism's coordinate frame around an
	// axis derived from chroma so chord changes visibly rotate the
	// silhouette in 3D, not just hue-shift it. chromaStrength gates how
	// hard the rotation pulls (atonal songs barely rotate; tonal songs
	// torque visibly when the chord changes).
	let chromaAngle = atan2(u.chromaY, u.chromaX);
	let chromaPull = u.chromaStrength * 0.55;
	let chromaTilt = chromaAngle * chromaPull;
	let rChroma = rot2(q.xy, chromaTilt);
	q.x = rChroma.x;
	q.y = rChroma.y;

	// Twist — bpm-coupled time term so fast songs torque faster.
	let twist = q.y * (0.36 + tension * 1.55)
		+ sin(q.z * 1.35 + u.time * (0.20 + u.bpmNorm * 0.55)) * (0.10 + u.mid * 0.24)
		+ u.flash * 0.16
		+ chromaAngle * chromaPull * 0.35;
	let rxz = rot2(q.xz, twist);
	q.x = rxz.x;
	q.z = rxz.y;
	let rxy = rot2(q.xy, sin(q.z * 0.9 + u.time * (0.08 + u.bpmNorm * 0.20)) * (0.08 + growth * 0.11));
	q.x = rxy.x;
	q.y = rxy.y;
	q.y = q.y + sin(q.x * 1.7 + u.time * 0.19) * (0.045 + tension * 0.05);
	return q;
}

fn map(p: vec3<f32>) -> f32 {
	let growth = u._pad0;
	let tension = u._pad1;
	// Cheap conservative scene bound: most screen rays never get close to the
	// hero. Tendrils are explicitly capped and smoothly intersected with a
	// smaller p-space envelope below, so they cannot be silently clipped by this
	// shortcut or produce discontinuous normals at the early-out boundary.
	let outerBound = length(p) - 1.85;
	if (outerBound > 0.35) {
		return outerBound * 0.82;
	}
	let q = organismWarp(p);

	// Core fractal body. Audio changes the coordinate field and power, so the
	// organism actually grows/twists instead of sitting under a post glow.
	let bodyScale = 1.05 + growth * 0.10 - u.flash * 0.030;
	// Five to seven iterations retain the recognizable Mandelbulb silhouette;
	// energy reveals the last two detail bands without making peak sections
	// several times more expensive than calm sections.
	let audioIters = 5 + i32(floor(growth * 1.4 + tension * 1.2));
	let safeIters = clamp(audioIters, 5, 7);
	var body = mandelbulbDE(q * bodyScale, u.mandelbulbPower + tension * 0.55, safeIters) * (1.03 - growth * 0.10);

	// Breathing membrane/lobed shell. This gives build-ups a visible expansion
	// phase and drops a wider silhouette without replacing the Mandelbulb core.
	let shellRadius = 0.62 + growth * 0.18 + sin(q.y * 2.3 + u.time * 0.23) * (0.020 + u.mid * 0.020);
	let shell = abs(length(q * vec3<f32>(0.95, 1.08, 0.95)) - shellRadius)
		- (0.018 + u.bass * 0.018 + growth * 0.010);
	body = body - exp(-abs(shell) * 18.0) * (0.004 + growth * 0.007 + u.bass * 0.004);

	// Tendril lanes: multiple finite helixes attached to the same warped space.
	// Clamping the lane's Y coordinate turns each formerly-infinite tube into a
	// round-ended capsule. The p-space envelope is deliberately inside the
	// scene early-out radius, with ample room for the later smooth union.
	var tendril = 1000.0;
	let tendrilHalfLength = 0.82 + growth * 0.18;
	for (var i: i32 = 0; i < 4; i = i + 1) {
		let fi = f32(i) / 4.0;
		let phase = fi * 6.2831853 + u.paletteOffset * 6.2831853 + u.time * (0.045 + u.bpmNorm * 0.075);
		let laneY = clamp(q.y, -tendrilHalfLength, tendrilHalfLength);
		let yPhase = laneY * (2.1 + tension * 0.8) + phase;
		let radius = 0.30 + growth * 0.32 + sin(laneY * 2.7 + phase) * (0.040 + u.mid * 0.030);
		let lane = vec2<f32>(cos(yPhase), sin(yPhase)) * radius;
		let laneCenter = vec3<f32>(lane.x, laneY, lane.y);
		let d = length(q - laneCenter) - (0.014 + u.mid * 0.030 + u.flash * 0.026);
		tendril = min(tendril, d);
	}
	let tendrilEnvelope = length(p) - 1.72;
	tendril = smax(tendril, tendrilEnvelope, 0.055);
	body = smin(body, tendril, 0.052 + tension * 0.025);

	// Cavity carving: restrained negative space inside the creature. Kept small
	// so it creates breathing mouths/pockets without black tile artifacts.
	let c1 = length(q - vec3<f32>(sin(u.time * 0.12) * 0.20, 0.05 + growth * 0.12, cos(u.time * 0.10) * 0.18))
		- (0.075 + u.bass * 0.035 + tension * 0.020);
	let c2 = length(q - vec3<f32>(-0.26, -0.18 + sin(u.time * 0.15) * 0.08, 0.22))
		- (0.065 + growth * 0.030);
	body = max(body, -min(c1, c2));

	// High-frequency surface life from treble, tiny enough not to destabilize the
	// marcher but enough that hats/percussion make the skin crawl.
	let ripple = (
		sin(q.x * 16.0 + u.time * 1.3) +
		sin(q.y * 19.0 - u.time * 1.1) +
		sin(q.z * 14.0 + q.x * 4.0)
	) * (0.0018 + u.treble * 0.0032 + tension * 0.0015);
	return body + ripple;
}

// 4-tap tetrahedral normal estimation.
fn calcNormal(p: vec3<f32>) -> vec3<f32> {
	let e = vec2<f32>(0.0015, -0.0015);
	let m1 = map(p + e.xyy);
	let m2 = map(p + e.yyx);
	let m3 = map(p + e.yxy);
	let m4 = map(p + e.xxx);
	// Black-square guard — NaN comparisons all return false in WGSL, so a NaN
	// distance fails (x < 1e10) and we fall back to the up vector. Without
	// this, NaN propagates through normal/lighting and produces the tile-
	// shaped black artifacts characteristic of fragment-shader SDF failures.
	let allFinite = (m1 < 1e10) && (m2 < 1e10) && (m3 < 1e10) && (m4 < 1e10);
	if (!allFinite) {
		return vec3<f32>(0.0, 1.0, 0.0);
	}
	return safeNormalize(
		e.xyy * m1 + e.yyx * m2 + e.yxy * m3 + e.xxx * m4,
		vec3<f32>(0.0, 1.0, 0.0)
	);
}

// Short march toward the key light for the hero's soft surface shadow.
fn lightVisibility(ro: vec3<f32>, rd: vec3<f32>, maxt: f32) -> f32 {
	var res = 1.0;
	var t = 0.02;
	for (var i: i32 = 0; i < 7; i = i + 1) {
		let h = map(ro + rd * t);
		if (h < 0.001) { return 0.0; }
		res = min(res, 12.0 * h / t);
		t = t + clamp(h, 0.05, 0.4);
		if (t > maxt) { break; }
	}
	return clamp(res, 0.0, 1.0);
}

// Cheap dither — Bayer 4x4 thresholds for breaking up volumetric stepping
// banding without proper blue noise textures.
fn dither(p: vec2<f32>) -> f32 {
	let bayer = mat4x4<f32>(
		0.0/16.0, 8.0/16.0, 2.0/16.0,10.0/16.0,
		12.0/16.0, 4.0/16.0,14.0/16.0, 6.0/16.0,
		3.0/16.0,11.0/16.0, 1.0/16.0, 9.0/16.0,
		15.0/16.0, 7.0/16.0,13.0/16.0, 5.0/16.0
	);
	let ix = i32(p.x) % 4;
	let iy = i32(p.y) % 4;
	return bayer[iy][ix];
}

// Hash for procedural starfield.
fn h31(p: vec3<f32>) -> f32 {
	var q = fract(p * vec3<f32>(443.897, 441.423, 437.195));
	q = q + dot(q, q.yzx + 19.19);
	return fract((q.x + q.y) * q.z);
}

// 3D value noise — for nebula clouds. Cheap trilinear interp of hash values.
fn vn3(p: vec3<f32>) -> f32 {
	let i = floor(p);
	let f = fract(p);
	let u = f * f * (3.0 - 2.0 * f);
	let c000 = h31(i);
	let c100 = h31(i + vec3<f32>(1.0, 0.0, 0.0));
	let c010 = h31(i + vec3<f32>(0.0, 1.0, 0.0));
	let c110 = h31(i + vec3<f32>(1.0, 1.0, 0.0));
	let c001 = h31(i + vec3<f32>(0.0, 0.0, 1.0));
	let c101 = h31(i + vec3<f32>(1.0, 0.0, 1.0));
	let c011 = h31(i + vec3<f32>(0.0, 1.0, 1.0));
	let c111 = h31(i + vec3<f32>(1.0, 1.0, 1.0));
	let x00 = mix(c000, c100, u.x);
	let x10 = mix(c010, c110, u.x);
	let x01 = mix(c001, c101, u.x);
	let x11 = mix(c011, c111, u.x);
	let y0 = mix(x00, x10, u.y);
	let y1 = mix(x01, x11, u.y);
	return mix(y0, y1, u.z);
}

// Procedural nebula + starfield sky. Replaces the flat olive background
// with: (1) atmospheric horizon-to-zenith gradient, (2) three-octave nebula
// cloud field tinted with the palette family, (3) twinkling starfield
// from hashed pixel positions. Twinkle rate locks to BPM. Sky still
// behaves as a low-intensity HDR backdrop so AgX tonemap reads correctly.
fn sky(rd: vec3<f32>) -> vec3<f32> {
	let upT = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
	let baseT = u.paletteOffset;
	let horizon = palette7(baseT) * 0.10;
	let zenith = palette7(baseT + 0.7) * 0.025;
	var bg = mix(horizon, zenith, smoothstep(0.0, 1.0, upT));

	// Nebula clouds — 3-octave fBm at higher base frequency (was 3.5, now
	// 12.0). Earlier version produced bitmap-y patches because each value-
	// noise cell was 5+ pixels wide on screen. Higher frequency + more
	// octaves gives proper cloud structure. Two-tone tint (deep + warm)
	// for actual depth in the cloud field rather than a single colour wash.
	let cloudP = rd * 12.0 + vec3<f32>(u.time * 0.018, u.time * 0.011, u.time * 0.009);
	var cloud = 0.0;
	var amp = 0.5;
	var freq = 1.0;
	for (var oc: i32 = 0; oc < 3; oc = oc + 1) {
		cloud = cloud + vn3(cloudP * freq) * amp;
		amp = amp * 0.5;
		freq = freq * 2.1;
	}
	let cloudMask = smoothstep(0.42, 0.82, cloud);
	let cloudWarp = smoothstep(0.55, 0.95, cloud);
	let nebulaDeep = palette7(baseT + 0.32) * cloudMask * (0.14 + u.sustain * 0.08);
	let nebulaWarm = palette7(baseT + 0.55) * cloudWarp * (0.10 + u.sustain * 0.05);
	bg = bg + nebulaDeep + nebulaWarm;

	// Stars — sparse hashed bright dots. Twinkle phase locked to BPM so
	// faster songs have faster sparkle. Star density slightly higher in
	// the upper hemisphere (sky-facing rays).
	let starScale = 220.0;
	let starP = rd * starScale;
	let starHash = h31(floor(starP));
	let starMask = step(0.9975, starHash);
	let twinkle = 0.5 + 0.5 * sin(u.time * (4.0 + u.bpmNorm * 8.0) + starHash * 6.28);
	let star = starMask * twinkle * (0.6 + upT * 0.4);
	bg = bg + vec3<f32>(star * 0.7, star * 0.78, star * 0.92);

	return bg;
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let res = vec2<f32>(u.resolutionX, u.resolutionY);
	let uv = (frag.xy - 0.5 * res) / res.y;

	// Camera basis from uniforms (computed CPU-side via Catmull-Rom).
	let camPos = vec3<f32>(u.camPosX, u.camPosY, u.camPosZ);
	let fwd = vec3<f32>(u.camFwdX, u.camFwdY, u.camFwdZ);
	let right = vec3<f32>(u.camRightX, u.camRightY, u.camRightZ);
	let up = vec3<f32>(u.camUpX, u.camUpY, u.camUpZ);
	// Small onset-driven camera nudge (subpixel-scale jitter for "impact" feel).
	let kick = u.flash * 0.012;
	let kickDir = vec2<f32>(
		fract(sin(u.time * 0.7) * 13.0) - 0.5,
		fract(cos(u.time * 0.5) * 17.0) - 0.5
	);
	let uvK = uv + kickDir * kick;
	let rd = normalize(uvK.x * right + uvK.y * up + fwd * u.fovScale);

	// Key light — direction rotated by chroma so different musical keys land
	// in different lighting setups.
	let chromaAngle = atan2(u.chromaY, u.chromaX);
	let cChroma = cos(chromaAngle);
	let sChroma = sin(chromaAngle);
	let lightDir = safeNormalize(
		vec3<f32>(0.45 * cChroma + 0.30 * sChroma, 0.78, 0.55 * cChroma - 0.20 * sChroma),
		vec3<f32>(0.25, 0.82, 0.50)
	);

	// ── Volumetric raymarch.
	// At every step we accumulate fog scattering, attenuated by transmittance.
	// If a step hits the surface (distance < EPS) we shade it physically and
	// premultiply the surface contribution by the remaining transmittance,
	// then return — naturally compositing fog over surface over background.
	let MAX_STEPS = 48;
	let MAX_DIST = 10.0;
	let EPS_NEAR = 0.0014;
	let EPS_FAR  = 0.0070;

	var transmittance = 1.0;
	var scattered = vec3<f32>(0.0);
	var t = 0.05 + dither(frag.xy) * 0.04; // dither breaks fog banding

	for (var i: i32 = 0; i < MAX_STEPS; i = i + 1) {
		if (t > MAX_DIST) { break; }
		let p = camPos + rd * t;
		var d = map(p);
		// Black-square guard — if SDF returns NaN/Inf from a degenerate iteration,
		// treat as max distance so the marcher skips and the pixel falls through
		// to sky instead of stamping a NaN tile.
		if (!(d < 1e10)) { d = 0.5; }
		// Distance-adaptive hit threshold — far surfaces use looser EPS so we
		// don't waste precision; close surfaces tighten so detail reads sharp.
		// Eliminates the "spamming a close-up that's scaled up" degradation.
		let EPS = mix(EPS_NEAR, EPS_FAR, smoothstep(0.5, 6.0, t));

		// ── Surface hit
		if (d < EPS) {
			let n = calcNormal(p);
			let view = -rd;
			let cosNL = max(0.0, dot(n, lightDir));
			let halfDir = safeNormalize(lightDir + view, lightDir);
			let cosNH = max(0.0, dot(n, halfDir));
			let cosNV = max(0.0, dot(n, view));
			let shadow = lightVisibility(p + n * 0.005, lightDir, 4.0);

			// Three short ambient-occlusion probes preserve crevice depth without
			// repeating the full fractal map five times at every surface pixel.
			var ao = 0.0;
			var aoW = 0.0;
			for (var k: i32 = 1; k <= 3; k = k + 1) {
				let ko = f32(k) * 0.065;
				let occ = ko - map(p + n * ko);
				ao = ao + occ * pow(0.6, f32(k));
				aoW = aoW + pow(0.6, f32(k));
			}
			ao = clamp(1.0 - ao / aoW * 5.0, 0.0, 1.0);

			// Photographic palette base color sampled via centroid + iter depth
			// proxy (distance from origin gives "depth into the fractal").
			// Multi-axis palette variation — different parts of the organism
			// sample different stops of the 7-stop palette. Previously palT
			// only varied ~0.04 across the whole organism (1/14 of one stop)
			// so the surface read as one flat colour. New mix sweeps across
			// roughly 2 stops based on: position depth, surface orientation,
			// height above origin, treble-driven micro-shimmer, AND a
			// per-region FFT bin lookup so different parts of the organism
			// physically respond to different frequencies of the music.
			// Height maps to bin index — bottom of organism samples bass
			// bins, top samples treble bins. The surface literally hums to
			// the spectrum.
			let regionBin = i32(clamp((p.y + 1.5) * 16.0, 0.0, 63.0));
			let bandShimmer = bins[regionBin] * 0.18;
			let palT = u.paletteOffset
				+ length(p) * 0.22
				+ n.x * 0.10
				+ n.y * 0.08
				+ abs(p.y) * 0.14
				+ u.treble * sin(p.x * 5.0 + p.z * 4.0) * 0.04
				+ bandShimmer;
			let baseCol = palette7(palT);

			// Thin-film iridescence via wavelength interference. Thickness drifts
			// with treble + centroid, so different songs hit different colour bands.
			let thickness = 320.0 + u.centroid * 280.0 + u.treble * 100.0;
			let n_index = 1.4;
			let opd = 2.0 * n_index * thickness * cosNV;
			let wavelengths = vec3<f32>(680.0, 530.0, 470.0);
			let phase = 6.28318530718 * opd / wavelengths;
			let irid = 0.5 + 0.5 * cos(phase);

			let fresnel = pow(1.0 - cosNV, 4.0);
			let specPow = 32.0 + u.mid * 64.0;
			let specular = pow(cosNH, specPow);

			// Multi-scale surface detail — three octaves of triplanar noise
			// modulate the base color and add micro-shading. Macro form is
			// the fractal itself; meso detail is vein + ripple; micro
			// detail is this triplanar layer. Visible at close zoom as
			// pore-level texture without bloating the SDF.
			let triA = (sin(p.x * 28.0) * sin(p.y * 26.0) * sin(p.z * 30.0)) * 0.5 + 0.5;
			let triB = (sin(p.x * 73.0 + 2.1) * sin(p.y * 79.0 - 1.4) * sin(p.z * 71.0 + 3.7)) * 0.5 + 0.5;
			let microDetail = triA * 0.6 + triB * 0.4;
			let detailShade = 0.82 + microDetail * 0.36;

			// Three-point lighting — cinematic dramatic look.
			//   key   warm directional from upper-right (existing lightDir)
			//   fill  cool soft from below, palette accent — lifts shadows
			//   rim   palette rim hue from behind subject — silhouette pop
			let keyTint = palette7(u.paletteOffset + 0.18) * 1.4 + vec3<f32>(0.05);
			let fillTint = palette7(u.paletteOffset + 0.55) * 0.45;
			let rimTint = palette7(u.paletteOffset + 0.82) * 1.8;

			let fillDir = safeNormalize(vec3<f32>(-0.25, -0.55, -0.35), vec3<f32>(0.0, -1.0, 0.0));
			let rimDir = -lightDir;
			let cosNF = max(0.0, dot(n, fillDir));
			let cosNR = max(0.0, dot(n, rimDir));
			// Rim term — Fresnel-weighted backlight along silhouette edges only.
			let rimFresnel = pow(1.0 - cosNV, 3.5);
			let rim = rimTint * cosNR * rimFresnel * (0.65 + u.sustain * 0.5);

			let direct = keyTint * cosNL * shadow;
			let fill = fillTint * cosNF * 0.45;
			let ambient = fillTint * (0.32 + n.y * 0.30);
			let diffuse = baseCol * (direct + fill + ambient) * ao * detailShade;
			let specularCol = irid * (specular * 1.4 + fresnel * 0.5) * shadow + rim;
			let surfQ = organismWarp(p);
			let vein = pow(
				0.5 + 0.5 * sin(surfQ.x * 17.0 + surfQ.y * 11.0 - surfQ.z * 9.0 + u.time * (0.7 + u.bpmNorm)),
				7.0
			);
			let pulseVein = vein * (0.10 + u.mid * 0.18 + u.treble * 0.10) + u.flash * 0.18;
			let emission = palette7(u.paletteOffset + 0.22) * pulseVein * (0.65 + u.rms);

			// Staccato spike — sharp bright micro-spikes on surface aligned
			// with the vein pattern. Fires on every onset, decays in ~3
			// frames. Reads as the organism "flinching" on snare hits.
			let spikeMask = pow(vein, 3.0) * u.staccato;
			let staccatoCol = palette7(u.paletteOffset + 0.45) * spikeMask * 1.2;

			// Reverb ripple — expanding ring of bright displacement-emission
			// that radiates outward over ~2s after each onset. Inner-radius
			// clamp 0.5 ensures the ring NEVER glows at origin — that was
			// the persistent "inner glow" centered in the frame that the
			// user kept seeing. Ring is born at radius 0.5 and grows outward.
			let ringR = 0.5 + u.reverbT * 1.6;
			let ringWidth = 0.05 + u.reverbT * 0.18;
			let distToRing = abs(length(p) - ringR);
			let ringMask = smoothstep(ringWidth, 0.0, distToRing) * (1.0 - u.reverbT);
			let reverbCol = palette7(u.paletteOffset + 0.62) * ringMask * 0.65;

			let surfaceCol = diffuse + specularCol + emission + staccatoCol + reverbCol;
			scattered = scattered + surfaceCol * transmittance;
			transmittance = 0.0;
			break;
		}

		// ── In-medium fog scattering.
		// Density mildly increases in concavities near the fractal (proxied by
		// the SDF value), so fog hugs the form like incense smoke.
		let proxim = exp(-d * 1.4);
		let localDensity = u.fogDensity * (1.0 + proxim * 1.8);
		// A phase/clearance approximation replaces a nested shadow raymarch at
		// every fog step. Surface hits still receive a real soft shadow above;
		// atmosphere keeps directional depth at a tiny fraction of the cost.
		let lightPhase = pow(max(dot(rd, lightDir), 0.0), 4.0);
		let clearance = smoothstep(0.015, 0.45, d);
		let lightV = mix(0.32, 1.0, clearance) * (0.58 + lightPhase * 0.42);
		// Atmospheric tint — dramatically reduced from earlier attempt. The
		// per-step contribution gets multiplied by stepDensity and then
		// summed across ~30 fog steps, so what looks like a "tiny constant"
		// adds up to a bright central blob when camera points toward the
		// key light. Baseline 0.12 (was 0.6) and inscatter 0.0028 (was 0.012)
		// together make fog readable as atmosphere without dominating.
		let lightTint = palette7(u.paletteOffset + 0.18) * (0.12 + u.lightShaftIntensity * 0.08);
		let scatterIn = lightTint * lightV * 0.0028;
		// organismBloom — disabled. The colored halo around the organism
		// read as a detached glow overlay. Direct surface lighting carries
		// the silhouette now; no volumetric helper needed.
		let organismBloom = vec3<f32>(0.0);
		let stepDensity = localDensity * 0.08;
		scattered = scattered + (scatterIn + organismBloom) * stepDensity * transmittance;
		transmittance = transmittance * exp(-stepDensity);

		// March step. Smaller in dense areas (near surface), larger in open space.
		let stepSize = max(d * 0.92, 0.065);
		t = t + stepSize;
		if (transmittance < 0.025) { break; }
	}

	// Composite remaining transmittance with sky background.
	var col = scattered + sky(rd) * transmittance;

	// Gentle distance vignette (matches the eye's expectation of dimmer edges).
	let centered = (frag.xy - 0.5 * res) / res.y;
	let vig = smoothstep(1.2, 0.35, length(centered) * 1.3);
	col = col * (0.78 + 0.22 * vig);

	return vec4<f32>(col, 1.0);
}
`;

	// ──────────────────────────────────────────────────────────────────────────
	// Kawase bloom — diagonal 4-tap downsample with optional HDR threshold for
	// the first level (so only bright pixels actually bloom). Subsequent levels
	// use threshold = 0 so the already-bright glow propagates evenly.
	// ──────────────────────────────────────────────────────────────────────────
	const BLOOM_DOWN_WGSL = /* wgsl */ `
struct BloomParams {
	srcResX: f32,
	srcResY: f32,
	dstResX: f32,
	dstResY: f32,
	threshold: f32,
	_pad0: f32,
	_pad1: f32,
	_pad2: f32,
};

@group(0) @binding(0) var<uniform> p: BloomParams;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var srcTex: texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	var pos = array<vec2<f32>, 6>(
		vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
		vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0)
	);
	return vec4<f32>(pos[idx], 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let dstRes = vec2<f32>(p.dstResX, p.dstResY);
	let uv = frag.xy / dstRes;
	let texel = vec2<f32>(1.0 / p.srcResX, 1.0 / p.srcResY);
	// Diagonal 4-tap (Kawase-style)
	var c = textureSample(srcTex, samp, uv + vec2<f32>(-1.0, -1.0) * texel).rgb;
	c = c + textureSample(srcTex, samp, uv + vec2<f32>( 1.0, -1.0) * texel).rgb;
	c = c + textureSample(srcTex, samp, uv + vec2<f32>(-1.0,  1.0) * texel).rgb;
	c = c + textureSample(srcTex, samp, uv + vec2<f32>( 1.0,  1.0) * texel).rgb;
	c = c * 0.25;
	// Soft HDR threshold — only triggers on first level (threshold > 0).
	if (p.threshold > 0.0) {
		let bright = max(c.r, max(c.g, c.b));
		let knee = max(0.0, bright - p.threshold);
		let factor = knee / max(1e-4, bright);
		c = c * factor;
	}
	return vec4<f32>(c, 1.0);
}
`;

	// Upsample with Kawase 4-tap and ADDITIVELY blend into destination so the
	// smaller bloom mip contributions accumulate cleanly into the parent mip.
	const BLOOM_UP_WGSL = /* wgsl */ `
struct BloomParams {
	srcResX: f32,
	srcResY: f32,
	dstResX: f32,
	dstResY: f32,
	threshold: f32,
	intensity: f32,
	_pad1: f32,
	_pad2: f32,
};

@group(0) @binding(0) var<uniform> p: BloomParams;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var srcTex: texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	var pos = array<vec2<f32>, 6>(
		vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
		vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0)
	);
	return vec4<f32>(pos[idx], 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let dstRes = vec2<f32>(p.dstResX, p.dstResY);
	let uv = frag.xy / dstRes;
	let texel = vec2<f32>(1.0 / p.srcResX, 1.0 / p.srcResY);
	// Five-tap tent blur. The scene's temporal accumulation supplies the soft
	// tail, so four diagonal reads per mip were redundant bandwidth.
	var c = textureSample(srcTex, samp, uv).rgb * 0.4;
	c = c + textureSample(srcTex, samp, uv + vec2<f32>(-1.0,  0.0) * texel).rgb * 0.15;
	c = c + textureSample(srcTex, samp, uv + vec2<f32>( 1.0,  0.0) * texel).rgb * 0.15;
	c = c + textureSample(srcTex, samp, uv + vec2<f32>( 0.0, -1.0) * texel).rgb * 0.15;
	c = c + textureSample(srcTex, samp, uv + vec2<f32>( 0.0,  1.0) * texel).rgb * 0.15;
	return vec4<f32>(c * p.intensity, 1.0);
}
`;

	// ──────────────────────────────────────────────────────────────────────────
	// HDR composite — merges scene + bloom with previous frame's composite for
	// temporal motion blur. Stays in linear HDR; tone-map happens later in the
	// present pass so we don't double-ACES.
	// ──────────────────────────────────────────────────────────────────────────
	const COMPOSITE_WGSL = /* wgsl */ `
struct Uniforms {
	resolutionX: f32,
	resolutionY: f32,
	time: f32,
	bass: f32,
	mid: f32,
	treble: f32,
	centroid: f32,
	rms: f32,
	flash: f32,
	bpmNorm: f32,
	chromaX: f32,
	chromaY: f32,
	chromaStrength: f32,
	camPosX: f32,
	camPosY: f32,
	camPosZ: f32,
	camFwdX: f32,
	camFwdY: f32,
	camFwdZ: f32,
	camRightX: f32,
	camRightY: f32,
	camRightZ: f32,
	camUpX: f32,
	camUpY: f32,
	camUpZ: f32,
	fovScale: f32,
	mandelbulbPower: f32,
	paletteOffset: f32,
	fogDensity: f32,
	lightShaftIntensity: f32,
	_pad0: f32,
	_pad1: f32,
	paletteFamily: f32,
	staccato: f32,   // attack-only spike from onsets, ~60ms decay
	sustain: f32,    // slow-follower of rms, ~5s window — long-form energy
	reverbT: f32,    // time since last onset, normalized 0..1 over 2s
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var sceneTex: texture_2d<f32>;
@group(0) @binding(3) var bloomTex: texture_2d<f32>;
@group(0) @binding(4) var prevTex: texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	var pos = array<vec2<f32>, 6>(
		vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
		vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0)
	);
	return vec4<f32>(pos[idx], 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let res = vec2<f32>(u.resolutionX, u.resolutionY);
	let uv = frag.xy / res;
	// Linear-domain merge: scene + bloom + prev frame for temporal motion blur.
	let scene = textureSample(sceneTex, samp, uv).rgb;
	let bloom = textureSample(bloomTex, samp, uv).rgb;
	let prev = textureSample(prevTex, samp, uv).rgb;
	let current = scene + bloom * 0.85;
	// Subtle temporal accumulation — 12% of last frame held in current frame.
	// Looks like a cinema shutter without smearing fast camera moves into mud.
	let blended = mix(current, prev, 0.12);
	return vec4<f32>(blended, 1.0);
}
`;

	// ──────────────────────────────────────────────────────────────────────────
	// Particle pass — persistent spectrum-painted constellation around hero.
	// Each frame fades the previous particle texture and adds 32 paired-bin
	// "splat" contributions. Each FFT bin lives at angle = (bin/64) × 2π
	// around the screen center; radius drifts with time + bin index, glow
	// magnitude = bin energy, color sampled from palette7. Trails build up
	// over multiple frames because of the fade-not-clear strategy — gives
	// the spectrum a real persistent presence in 3D-feeling space.
	// ──────────────────────────────────────────────────────────────────────────
	const PARTICLE_WGSL = /* wgsl */ `
struct ParticleParams {
	resX: f32,
	resY: f32,
	time: f32,
	songSeed: f32,
	fadeRate: f32,
	spawnIntensity: f32,
	radiusOffset: f32,
	_pad0: f32,
};

@group(0) @binding(0) var<uniform> p: ParticleParams;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var prevTex: texture_2d<f32>;
@group(0) @binding(3) var<storage, read> bins: array<f32, 64>;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	var pos = array<vec2<f32>, 6>(
		vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
		vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0)
	);
	return vec4<f32>(pos[idx], 0.0, 1.0);
}

fn palette7(t: f32) -> vec3<f32> {
	let s = fract(t);
	let x = s * 7.0;
	let i = i32(floor(x));
	let f = smoothstep(0.0, 1.0, x - floor(x));
	let stops = array<vec3<f32>, 7>(
		vec3<f32>(0.020, 0.025, 0.080),
		vec3<f32>(0.090, 0.045, 0.150),
		vec3<f32>(0.380, 0.120, 0.105),
		vec3<f32>(0.880, 0.420, 0.150),
		vec3<f32>(0.950, 0.820, 0.620),
		vec3<f32>(0.460, 0.580, 0.700),
		vec3<f32>(0.090, 0.300, 0.380)
	);
	let a = stops[(i % 7 + 7) % 7];
	let b = stops[((i + 1) % 7 + 7) % 7];
	return mix(a, b, f);
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let res = vec2<f32>(p.resX, p.resY);
	let uv = frag.xy / res;
	let centered = uv - 0.5;
	let aspect = res.x / res.y;
	// Aspect-corrected coordinates so the constellation reads as circular,
	// not stretched on widescreen.
	let cAdj = vec2<f32>(centered.x * aspect, centered.y);

	// Fade previous accumulation.
	let prev = textureSample(prevTex, samp, uv).rgb * p.fadeRate;

	// Pair adjacent FFT bins into 32 visual bands. At one-third resolution this
	// retains the continuous aura while removing most of its per-pixel work.
	var contrib = vec3<f32>(0.0);
	for (var i: i32 = 0; i < 32; i = i + 1) {
		let binIdx = i * 2;
		let bin = (bins[binIdx] + bins[binIdx + 1]) * 0.5;
		if (bin < 0.03) { continue; }
		let fi = f32(i) / 32.0;
		// Two angular waves so contributions don't sit on a perfect ring
		let theta = fi * 6.28318530718 + p.time * 0.05 + sin(p.time * 0.18 + fi * 6.28) * 0.15;
		// Radius depends on bin index: low bins inner, high bins outer.
		// p.radiusOffset breathes radius range with audio.
		// Keep the spectrum as an aura close to the organism, not a separate
		// rainbow halo. Low bins sit near the lower body; high bins climb the
		// same spiral so it reads as one breathing structure.
		let lane = sin(fi * 18.0 + p.songSeed * 6.2831853 + p.time * 0.11);
		let radius = (0.08 + fi * 0.19 + bin * 0.045) * (1.0 + p.radiusOffset * 0.45);
		let squash = vec2<f32>(1.0, 0.58 + lane * 0.10);
		let offset = vec2<f32>(0.0, -0.04 + fi * 0.10);
		let binPos = vec2<f32>(cos(theta) * radius, sin(theta) * radius) * squash + offset;
		let d = length(cAdj - binPos);
		// Tight gaussian-ish kernel; the persistent fade does the bloom-like work.
		let glow = exp(-d * 44.0) * bin * p.spawnIntensity;
		let palT = p.songSeed + fi * 0.16 + lane * 0.025;
		contrib = contrib + palette7(palT) * glow;
	}

	return vec4<f32>(prev + contrib, 1.0);
}
`;

	// ──────────────────────────────────────────────────────────────────────────
	// Present pass — tone-map + film grain + chromatic aberration + dither.
	// Reads the temporally-blended HDR composite and outputs sRGB to the swap
	// chain. Doing tone-map here (not in composite) keeps temporal blend linear.
	// ──────────────────────────────────────────────────────────────────────────
	const PRESENT_WGSL = /* wgsl */ `
struct Uniforms {
	resolutionX: f32,
	resolutionY: f32,
	time: f32,
	bass: f32,
	mid: f32,
	treble: f32,
	centroid: f32,
	rms: f32,
	flash: f32,
	bpmNorm: f32,
	chromaX: f32,
	chromaY: f32,
	chromaStrength: f32,
	camPosX: f32,
	camPosY: f32,
	camPosZ: f32,
	camFwdX: f32,
	camFwdY: f32,
	camFwdZ: f32,
	camRightX: f32,
	camRightY: f32,
	camRightZ: f32,
	camUpX: f32,
	camUpY: f32,
	camUpZ: f32,
	fovScale: f32,
	mandelbulbPower: f32,
	paletteOffset: f32,
	fogDensity: f32,
	lightShaftIntensity: f32,
	_pad0: f32,
	_pad1: f32,
	paletteFamily: f32,
	staccato: f32,   // attack-only spike from onsets, ~60ms decay
	sustain: f32,    // slow-follower of rms, ~5s window — long-form energy
	reverbT: f32,    // time since last onset, normalized 0..1 over 2s
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var compositeTex: texture_2d<f32>;
@group(0) @binding(3) var particleTex: texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	var pos = array<vec2<f32>, 6>(
		vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
		vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0)
	);
	return vec4<f32>(pos[idx], 0.0, 1.0);
}

// AgX tone-map (Troy Sobotka). Preserves saturation in bright hues better
// than the cheap ACES approximation — gold cores stay gold instead of
// bleaching to white.
fn agx(c: vec3<f32>) -> vec3<f32> {
	let m = mat3x3<f32>(
		0.842479062253094, 0.0423282422610123, 0.0423756549057051,
		0.0784335999999992, 0.878468636469772, 0.0784336,
		0.0792237451477643, 0.0791661274605434, 0.879142973793104
	);
	let x = m * c;
	let lo = vec3<f32>(0.0001);
	let mapped = clamp((log2(max(x, lo)) + 12.47393) / (12.47393 + 4.026069), vec3<f32>(0.0), vec3<f32>(1.0));
	let m2 = mapped * mapped;
	let m4 = m2 * m2;
	return -17.86 * m4 * m2 + 78.01 * m4 * mapped - 126.7 * m4 + 92.06 * m2 * mapped - 28.72 * m2 + 4.361 * mapped - vec3<f32>(0.1718);
}

// IGN — Jorge Jimenez interleaved gradient noise. Per-pixel hash for the
// 16mm film-grain look — much less random-looking than scalar hash13.
fn ign(pixel: vec2<f32>) -> f32 {
	let m = vec3<f32>(0.06711056, 0.00583715, 52.9829189);
	return fract(m.z * fract(dot(pixel, m.xy)));
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let res = vec2<f32>(u.resolutionX, u.resolutionY);
	let uv = frag.xy / res;
	let centered = uv - 0.5;
	let r2 = dot(centered, centered);

	// Edge-only chromatic aberration on composited HDR.
	let caAmt = (0.0010 + r2 * 0.005) * (1.0 + u.flash * 0.8);
	let dir = normalize(centered + vec2<f32>(1e-4, 1e-4));
	let r = textureSample(compositeTex, samp, uv + dir * caAmt).r;
	let g = textureSample(compositeTex, samp, uv).g;
	let b = textureSample(compositeTex, samp, uv - dir * caAmt).b;
	var col = vec3<f32>(r, g, b);

	// Add spectrum-painted particle layer additively (still linear HDR).
	let particles = textureSample(particleTex, samp, uv).rgb;
	col = col + particles * 0.055;

	// Anamorphic lens streaks — three paired samples keep the cinematic accent
	// with substantially less full-resolution texture bandwidth. A high threshold
	// (1.10 vs 0.55) so only TRUE highlights streak. Old version was picking
	// up ambient glow + nebula clouds, producing the "white ash" the user
	// complained about.
	let texel = vec2<f32>(1.0 / u.resolutionX, 1.0 / u.resolutionY);
	var streak = vec3<f32>(0.0);
	for (var s: i32 = 1; s <= 3; s = s + 1) {
		let off = f32(s) * texel.x * 20.0;
		let sL = textureSample(compositeTex, samp, uv + vec2<f32>(-off, 0.0)).rgb;
		let sR = textureSample(compositeTex, samp, uv + vec2<f32>( off, 0.0)).rgb;
		let bright = max(sL, sR);
		let mask = max(bright - vec3<f32>(1.10), vec3<f32>(0.0));
		let falloff = 1.0 / (1.0 + f32(s) * 0.85);
		streak = streak + mask * falloff;
	}
	col = col + streak * vec3<f32>(0.20, 0.38, 0.52) * (0.35 + u.flash * 0.45);

	col = agx(col);
	// Black-point lift + micro-contrast so the deep volumetric blacks don't
	// read as flat. AgX is gentler than ACES so blacks need a little help.
	col = max(col - vec3<f32>(0.018), vec3<f32>(0.0));
	col = pow(col, vec3<f32>(1.06));

	// Luma-aware IGN grain — less grain in highlights so gold cores stay
	// clean, more in shadows where 16mm film naturally shows density noise.
	// (Named grainN — the simple letter g is already claimed by the green-
	// channel sample of compositeTex above in this same scope.)
	let pixelJitter = frag.xy + vec2<f32>(u.time * 137.0, u.time * 271.0);
	let grainN = ign(pixelJitter) - 0.5;
	let luma = dot(col, vec3<f32>(0.299, 0.587, 0.114));
	let grainStrength = (0.014 + u.treble * 0.022) * (1.0 - smoothstep(0.55, 1.0, luma));
	col = col + vec3<f32>(grainN * grainStrength);

	// Pre-quantization dither — kills 8-bit banding in volumetric gradients.
	col = col + vec3<f32>((ign(frag.xy + vec2<f32>(33.0, 71.0)) - 0.5) / 255.0);

	return vec4<f32>(col, 1.0);
}
`;

	// Bloom param uniform layout — 8 f32s = 32 bytes (×3 mips, down + up).
	const BLOOM_PARAM_FLOATS = 8;
	const BLOOM_PARAM_BYTES = BLOOM_PARAM_FLOATS * 4;
	const BLOOM_LEVELS = 3;

	// Particle params: 8 f32s = 32 bytes
	const PARTICLE_PARAM_FLOATS = 8;
	const PARTICLE_PARAM_BYTES = PARTICLE_PARAM_FLOATS * 4;
	const BIN_COUNT = 64;
	const BINS_BYTES = BIN_COUNT * 4;

	type GPU = {
		device: GPUDevice;
		context: GPUCanvasContext;
		format: GPUTextureFormat;
		sampler: GPUSampler;
		uniformBuf: GPUBuffer;
		uniformData: Float32Array;
		bloomParamBuf: GPUBuffer;
		bloomParamData: Float32Array;
		// Particle subsystem
		binsBuf: GPUBuffer; // storage buffer of 64 FFT bins
		binsData: Float32Array;
		particleParamBuf: GPUBuffer;
		particleParamData: Float32Array;
		pipelines: {
			scene: GPURenderPipeline;
			bloomDown: GPURenderPipeline;
			bloomUp: GPURenderPipeline;
			composite: GPURenderPipeline;
			particle: GPURenderPipeline;
			present: GPURenderPipeline;
		};
		targets: {
			scene: GPUTexture;
			sceneView: GPUTextureView;
			bloomMips: GPUTexture[];
			bloomViews: GPUTextureView[];
			bloomSizes: { w: number; h: number }[];
			compositeAB: [GPUTexture, GPUTexture];
			compositeViewsAB: [GPUTextureView, GPUTextureView];
			// Particle ping-pong textures (one-third res)
			particleAB: [GPUTexture, GPUTexture];
			particleViewsAB: [GPUTextureView, GPUTextureView];
			particleW: number;
			particleH: number;
			width: number;
			height: number;
		} | null;
		bindGroups: {
			scene: GPUBindGroup;
			composite: [GPUBindGroup, GPUBindGroup];
			present: [GPUBindGroup, GPUBindGroup];
			bloomDownBGs: GPUBindGroup[];
			bloomUpBGs: GPUBindGroup[];
			// particle[i] reads particleAB[i] as prev, writes to AB[1-i]
			particle: [GPUBindGroup, GPUBindGroup];
		} | null;
		frame: number;
	};

	let gpu: GPU | null = null;
	const TARGET_FRAME_MS = 1000 / 60;
	// Render at 72% of physical display resolution, then let the browser's
	// linear canvas upscale recover the final edge. Combined with 60 Hz this
	// keeps cost predictable on high-refresh / high-DPI displays.
	const INTERNAL_RENDER_SCALE = 0.72;
	const MAX_DEVICE_DPR = 1.5;
	let schedulerTickAt = 0;
	let renderBudgetMs = TARGET_FRAME_MS;
	let lastRenderedAt = 0;

	function resetFrameScheduler() {
		schedulerTickAt = 0;
		renderBudgetMs = TARGET_FRAME_MS;
		lastRenderedAt = 0;
	}

	function buildTargets(device: GPUDevice, w: number, h: number) {
		const hdr: GPUTextureFormat = 'rgba16float';
		const scene = device.createTexture({
			size: { width: Math.max(1, w), height: Math.max(1, h) },
			format: hdr,
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
		});
		// Bloom mip chain — start at 1/2, halve each level.
		const bloomMips: GPUTexture[] = [];
		const bloomViews: GPUTextureView[] = [];
		const bloomSizes: { w: number; h: number }[] = [];
		let mw = Math.max(1, Math.floor(w / 2));
		let mh = Math.max(1, Math.floor(h / 2));
		for (let i = 0; i < BLOOM_LEVELS; i++) {
			const tex = device.createTexture({
				size: { width: mw, height: mh },
				format: hdr,
				usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
			});
			bloomMips.push(tex);
			bloomViews.push(tex.createView());
			bloomSizes.push({ w: mw, h: mh });
			mw = Math.max(1, Math.floor(mw / 2));
			mh = Math.max(1, Math.floor(mh / 2));
		}
		// Ping-pong composite textures (full res HDR) for temporal motion blur.
		const cA = device.createTexture({
			size: { width: Math.max(1, w), height: Math.max(1, h) },
			format: hdr,
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
		});
		const cB = device.createTexture({
			size: { width: Math.max(1, w), height: Math.max(1, h) },
			format: hdr,
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
		});
		// Particle accumulation is intentionally one-third resolution; soft
		// persistent splats upscale cleanly and do not need scene resolution.
		const particleW = Math.max(1, Math.floor(w / 3));
		const particleH = Math.max(1, Math.floor(h / 3));
		const pA = device.createTexture({
			size: { width: particleW, height: particleH },
			format: hdr,
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
		});
		const pB = device.createTexture({
			size: { width: particleW, height: particleH },
			format: hdr,
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
		});
		return {
			scene,
			sceneView: scene.createView(),
			bloomMips,
			bloomViews,
			bloomSizes,
			compositeAB: [cA, cB] as [GPUTexture, GPUTexture],
			compositeViewsAB: [cA.createView(), cB.createView()] as [GPUTextureView, GPUTextureView],
			particleAB: [pA, pB] as [GPUTexture, GPUTexture],
			particleViewsAB: [pA.createView(), pB.createView()] as [GPUTextureView, GPUTextureView],
			particleW,
			particleH,
			width: w,
			height: h
		};
	}

	function buildBindGroups(g: GPU) {
		if (!g.targets) return null;
		const { device, pipelines, uniformBuf, bloomParamBuf, sampler, targets, binsBuf } = g;
		const scene = device.createBindGroup({
			layout: pipelines.scene.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: uniformBuf } },
				{ binding: 1, resource: { buffer: binsBuf } }
			]
		});
		// Composite has 2 bind groups — each reads a different prevTex (the
		// other ping-pong texture). Output target alternates each frame.
		const composite: [GPUBindGroup, GPUBindGroup] = [0, 1].map((i) =>
			device.createBindGroup({
				layout: pipelines.composite.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: uniformBuf } },
					{ binding: 1, resource: sampler },
					{ binding: 2, resource: targets.sceneView },
					{ binding: 3, resource: targets.bloomViews[0] },
					{ binding: 4, resource: targets.compositeViewsAB[i] }
				]
			})
		) as [GPUBindGroup, GPUBindGroup];
		// Particle has 2 bind groups — reads prev particle tex (i), writes other.
		const particle: [GPUBindGroup, GPUBindGroup] = [0, 1].map((i) =>
			device.createBindGroup({
				layout: pipelines.particle.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: g.particleParamBuf } },
					{ binding: 1, resource: sampler },
					{ binding: 2, resource: targets.particleViewsAB[i] },
					{ binding: 3, resource: { buffer: g.binsBuf } }
				]
			})
		) as [GPUBindGroup, GPUBindGroup];

		// Present has 2 bind groups — reads composite[i] + particle current.
		// We sample the SAME particle index as composite for visual coherence —
		// works because both ping-pong on the same frame counter.
		const present: [GPUBindGroup, GPUBindGroup] = [0, 1].map((i) =>
			device.createBindGroup({
				layout: pipelines.present.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: uniformBuf } },
					{ binding: 1, resource: sampler },
					{ binding: 2, resource: targets.compositeViewsAB[i] },
					{ binding: 3, resource: targets.particleViewsAB[i] }
				]
			})
		) as [GPUBindGroup, GPUBindGroup];
		// Bloom downsample bind groups: source for level i is sceneTex (i=0) or
		// bloomMip[i-1]. Each has a dedicated uniform-buffer slice for params.
		const bloomDownBGs: GPUBindGroup[] = [];
		for (let i = 0; i < BLOOM_LEVELS; i++) {
			const src = i === 0 ? targets.sceneView : targets.bloomViews[i - 1];
			bloomDownBGs.push(
				device.createBindGroup({
					layout: pipelines.bloomDown.getBindGroupLayout(0),
					entries: [
						{
							binding: 0,
							resource: { buffer: bloomParamBuf, offset: i * 256, size: BLOOM_PARAM_BYTES }
						},
						{ binding: 1, resource: sampler },
						{ binding: 2, resource: src }
					]
				})
			);
		}
		// Bloom upsample bind groups: src=mip[i+1], dst=mip[i]. Param slices
		// begin immediately after the three downsample slices.
		const bloomUpBGs: GPUBindGroup[] = [];
		for (let i = 0; i < BLOOM_LEVELS - 1; i++) {
			const srcLevel = BLOOM_LEVELS - 1 - i;
			bloomUpBGs.push(
				device.createBindGroup({
					layout: pipelines.bloomUp.getBindGroupLayout(0),
					entries: [
						{
							binding: 0,
							resource: {
								buffer: bloomParamBuf,
								offset: (BLOOM_LEVELS + i) * 256,
								size: BLOOM_PARAM_BYTES
							}
						},
						{ binding: 1, resource: sampler },
						{ binding: 2, resource: targets.bloomViews[srcLevel] }
					]
				})
			);
		}
		return { scene, composite, present, bloomDownBGs, bloomUpBGs, particle };
	}

	async function initGpu(c: HTMLCanvasElement): Promise<GPU | null> {
		const gpuApi = navigator.gpu;
		if (!gpuApi) {
			errorMsg = 'WebGPU not available.';
			return null;
		}
		const adapter = await gpuApi.requestAdapter();
		if (!adapter) {
			errorMsg = 'No WebGPU adapter found.';
			return null;
		}
		const device = (await adapter.requestDevice()) as GPUDevice;

		const context = c.getContext('webgpu') as unknown as GPUCanvasContext;
		if (!context) {
			device.destroy?.();
			errorMsg = 'WebGPU canvas context unavailable.';
			return null;
		}
		const format = gpuApi.getPreferredCanvasFormat() as GPUTextureFormat;
		context.configure({ device, format, alphaMode: 'opaque' });

		const hdr: GPUTextureFormat = 'rgba16float';

		const mkPipeline = (code: string, target: GPUTextureFormat) => {
			const module = device.createShaderModule({ code });
			return device.createRenderPipeline({
				layout: 'auto',
				vertex: { module, entryPoint: 'vs_main' },
				fragment: { module, entryPoint: 'fs_main', targets: [{ format: target }] },
				primitive: { topology: 'triangle-list' }
			});
		};

		// Bloom upsample uses additive blend so each mip's contribution accumulates
		// cleanly into the parent. Downsample uses replace.
		const mkUpsamplePipeline = (code: string) => {
			const module = device.createShaderModule({ code });
			return device.createRenderPipeline({
				layout: 'auto',
				vertex: { module, entryPoint: 'vs_main' },
				fragment: {
					module,
					entryPoint: 'fs_main',
					targets: [
						{
							format: hdr,
							blend: {
								color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
								alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
							}
						}
					]
				},
				primitive: { topology: 'triangle-list' }
			});
		};

		const pipelines = {
			scene: mkPipeline(SCENE_WGSL, hdr),
			bloomDown: mkPipeline(BLOOM_DOWN_WGSL, hdr),
			bloomUp: mkUpsamplePipeline(BLOOM_UP_WGSL),
			composite: mkPipeline(COMPOSITE_WGSL, hdr),
			particle: mkPipeline(PARTICLE_WGSL, hdr),
			present: mkPipeline(PRESENT_WGSL, format)
		};

		const sampler = device.createSampler({
			magFilter: 'linear',
			minFilter: 'linear',
			addressModeU: 'clamp-to-edge',
			addressModeV: 'clamp-to-edge'
		});

		const uniformBuf = device.createBuffer({
			size: UNIFORM_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});

		const bloomParamBuf = device.createBuffer({
			size: 256 * (BLOOM_LEVELS * 2 - 1),
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});

		// Particle uniform buffer + bins storage buffer.
		const particleParamBuf = device.createBuffer({
			size: PARTICLE_PARAM_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
		const binsBuf = device.createBuffer({
			size: BINS_BYTES,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});

		return {
			device,
			context,
			format,
			sampler,
			uniformBuf,
			uniformData: new Float32Array(UNIFORM_FLOATS),
			bloomParamBuf,
			bloomParamData: new Float32Array(BLOOM_PARAM_FLOATS),
			binsBuf,
			binsData: new Float32Array(BIN_COUNT),
			particleParamBuf,
			particleParamData: new Float32Array(PARTICLE_PARAM_FLOATS),
			pipelines,
			targets: null,
			bindGroups: null,
			frame: 0
		};
	}

	function discardTargets(g: GPU) {
		if (g.targets) {
			g.targets.scene.destroy();
			for (const t of g.targets.bloomMips) t.destroy();
			g.targets.compositeAB[0].destroy();
			g.targets.compositeAB[1].destroy();
			g.targets.particleAB[0].destroy();
			g.targets.particleAB[1].destroy();
		}
		g.targets = null;
		g.bindGroups = null;
		g.frame = 0;
	}

	function ensureTargets(g: GPU, w: number, h: number) {
		if (g.targets && g.targets.width === w && g.targets.height === h) return;
		discardTargets(g);
		g.targets = buildTargets(g.device, w, h);
		g.bindGroups = buildBindGroups(g);
	}

	function destroyGpuResources(g: GPU) {
		try {
			discardTargets(g);
			g.uniformBuf.destroy();
			g.bloomParamBuf.destroy();
			g.binsBuf.destroy();
			g.particleParamBuf.destroy();
			g.device.destroy?.();
		} catch {}
	}

	function failGpuDevice(g: GPU, generation: number, message: string) {
		// An old device may resolve `lost` after a normal engine switch. Identity
		// and generation checks ensure it cannot tear down a newer replacement.
		if (gpu !== g || generation !== initGeneration) return;
		initGeneration++;
		gpu = null;
		gpuReady = false;
		resetFrameScheduler();
		temporalResetRequested = true;
		errorMsg = message;
		destroyGpuResources(g);
	}

	function teardownGpu() {
		initGeneration++;
		gpuReady = false;
		resetFrameScheduler();
		temporalResetRequested = true;
		if (!gpu) return;
		const doomed = gpu;
		gpu = null;
		destroyGpuResources(doomed);
	}

	function loop(frameNow = performance.now()) {
		if (!running) return;
		raf = requestAnimationFrame(loop);
		if (!canvas || !gpu) return;

		if (!schedulerTickAt) {
			schedulerTickAt = frameNow;
			renderBudgetMs = TARGET_FRAME_MS;
		} else {
			const tickElapsed = Math.max(0, frameNow - schedulerTickAt);
			schedulerTickAt = frameNow;
			// Accumulate refresh intervals instead of phase-adjusting the previous
			// render timestamp. Keep only a small catch-up budget so a stalled or
			// backgrounded window renders one current frame, never an obsolete burst.
			renderBudgetMs = Math.min(TARGET_FRAME_MS * 4, renderBudgetMs + tickElapsed);
		}
		if (renderBudgetMs + 0.25 < TARGET_FRAME_MS) return;
		// Carry fractional refresh time forward. Subtract first to avoid a value
		// microscopically below one interval wrapping to an almost-full budget.
		let remainderMs = renderBudgetMs - TARGET_FRAME_MS;
		if (remainderMs >= TARGET_FRAME_MS) remainderMs %= TARGET_FRAME_MS;
		renderBudgetMs = Math.max(0, remainderMs);

		// This is the actual time between rendered frames, independent of the
		// scheduler's fractional budget, so smoothing remains time-correct on
		// 60/75/90/120/144 Hz displays and after an occasional missed frame.
		const elapsedMs = lastRenderedAt ? Math.max(0, frameNow - lastRenderedAt) : TARGET_FRAME_MS;
		lastRenderedAt = frameNow;
		const frameDt = Math.min(1, Math.max(0.001, elapsedMs / 1000));

		const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_DPR) * INTERNAL_RENDER_SCALE;
		const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
		const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		const targetGpu = gpu;
		const targetGeneration = initGeneration;
		try {
			if (temporalResetRequested) {
				discardTargets(targetGpu);
				temporalResetRequested = false;
			}
			ensureTargets(targetGpu, w, h);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			failGpuDevice(
				targetGpu,
				targetGeneration,
				`Mk2 could not prepare its WebGPU render targets: ${detail}. Switch to another visualizer and back to retry; if it repeats, restart Mewsik or update the graphics driver.`
			);
			return;
		}
		if (!gpu.bindGroups || !gpu.targets) {
			return;
		}

		const time = (performance.now() - t0) / 1000;
		const feat = audioWarmupFrames > 0 ? null : vis.getLatest();
		if (audioWarmupFrames > 0) audioWarmupFrames--;
		const directed = director.update(feat, time);

		// Convert the original 60 Hz tuning into time-correct coefficients so
		// reactions feel identical if a machine occasionally misses a frame.
		const frameScale = frameDt * 60;
		const alpha = (at60Hz: number) => 1 - Math.pow(1 - at60Hz, frameScale);
		const decay = (at60Hz: number) => Math.pow(at60Hz, frameScale);

		// Smooth audio at appropriate timescales.
		// Fast-attack params for transients:
		smoothed.bass = lerp(smoothed.bass, feat?.bass ?? 0, alpha(0.25));
		smoothed.mid = lerp(smoothed.mid, feat?.mid ?? 0, alpha(0.18));
		smoothed.treble = lerp(smoothed.treble, feat?.treble ?? 0, alpha(0.35));
		if (feat?.onset) {
			smoothed.flash = 1;
			smoothed.staccato = 1;
			smoothed.reverbStart = time;
		}
		smoothed.flash *= decay(0.88);
		// staccato — sharper than flash; ~3-frame half-life. Used for crisp
		// surface spike emission, not for the broader fog flash.
		smoothed.staccato *= decay(0.74);
		// sustain — long-RMS follower (~5s envelope). Drives mood-level
		// changes, not transient response.
		const sustainTarget = smoothed.rmsSlow;
		smoothed.sustain = lerp(smoothed.sustain, sustainTarget, alpha(0.008));
		// smoothEnergy — slow follower of overall instantaneous energy with
		// asymmetric envelope (200ms attack / 800ms release). This is the
		// channel that drives BIG modulations (camera dolly, organism scale,
		// rim brightness) so they don't track instantaneous transients and
		// flicker. Fast channels (flash, staccato) keep handling per-hit
		// reactions; smoothEnergy keeps the macro feel from being jittery.
		const energyTarget = Math.min(1, (feat?.rms ?? 0) * 1.4 + (feat?.bass ?? 0) * 0.4);
		const smoothAttack = alpha(energyTarget > smoothed.smoothEnergy ? 0.08 : 0.02);
		smoothed.smoothEnergy = smoothed.smoothEnergy + (energyTarget - smoothed.smoothEnergy) * smoothAttack;
		// Slow params (mood / palette / camera):
		smoothed.centroidSlow = lerp(smoothed.centroidSlow, feat?.centroid ?? 0.5, alpha(0.015));
		smoothed.rmsSlow = lerp(smoothed.rmsSlow, feat?.rms ?? 0, alpha(0.02));
		smoothed.bpmNormSlow = lerp(
			smoothed.bpmNormSlow,
			feat?.bpm ? Math.max(0, Math.min(1, (feat.bpm - 60) / 120)) : 0,
			alpha(0.012)
		);
		// Circular chroma smoothing (slow)
		const chromaAngle = (feat?.chroma_key ?? 0) * 2 * Math.PI;
		smoothed.chromaXSlow = lerp(smoothed.chromaXSlow, Math.cos(chromaAngle), alpha(0.02));
		smoothed.chromaYSlow = lerp(smoothed.chromaYSlow, Math.sin(chromaAngle), alpha(0.02));

		// ── Real-time section detection: feed history, compute window stats,
		// run state machine, lerp to current state's mood template. Runs before
		// camera so the camera can use state-driven speed and distance scalars.
		pushHist(feat?.rms ?? 0, feat?.onset ? 1 : 0);

		// Window stats — averages over ~2-second slices at different offsets.
		const WS = 120; // ~2s at 60Hz
		const rmsNow = avgWindow(rmsHist, 0, WS);
		const rmsAgo = avgWindow(rmsHist, WS * 2, WS); // 4-6s ago
		const onsetNow = avgWindow(onsetHist, 0, WS) * WS; // count in 2s
		const onsetAgo = avgWindow(onsetHist, WS * 2, WS) * WS;
		const rmsDelta = rmsNow - rmsAgo;
		const onsetRatio = onsetNow / Math.max(1, onsetAgo);

		// State machine transitions
		let timeInState = time - stateEnterTime;
		const transitionTo = (next: SongState) => {
			if (next !== songState) {
				// Snapshot the actual in-between mood. This also handles a section
				// changing again before the previous 2.5-second ease has completed.
				const currentTarget = STATE_MOODS[songState];
				const currentT = smoothstepJs(0, 1, Math.min(1, timeInState / 2.5));
				previousMood = {
					palOffset: lerp(previousMood.palOffset, currentTarget.palOffset, currentT),
					power: lerp(previousMood.power, currentTarget.power, currentT),
					fogMul: lerp(previousMood.fogMul, currentTarget.fogMul, currentT),
					shaftMul: lerp(previousMood.shaftMul, currentTarget.shaftMul, currentT),
					camDistMul: lerp(previousMood.camDistMul, currentTarget.camDistMul, currentT),
					camSpeedMul: lerp(previousMood.camSpeedMul, currentTarget.camSpeedMul, currentT)
				};
				songState = next;
				stateEnterTime = time;
				timeInState = 0;
			}
		};

		// Failsafe: drop to calm if silence has held for >3s
		if (rmsNow < 0.05 && timeInState > 3 && songState !== 'calm') {
			transitionTo('calm');
		} else {
			switch (songState) {
				case 'calm':
					// Rising = sustained positive delta + transient density growing.
					// Needs at least 2.5s in calm so we don't bounce off noise spikes.
					if (timeInState > 2.5 && rmsDelta > 0.03 && onsetRatio > 1.3) {
						transitionTo('rising');
					}
					break;
				case 'rising':
					// Peak = absolute RMS crosses threshold (the drop has landed).
					if (rmsNow > 0.32 || (rmsDelta > 0.08 && onsetRatio > 2.0)) {
						transitionTo('peak');
					} else if (timeInState > 12 && rmsDelta < 0) {
						// Buildup that fizzled — go back to calm.
						transitionTo('releasing');
					}
					break;
				case 'peak':
					// Release = sustained negative delta (peak is sliding off).
					if (timeInState > 3 && rmsDelta < -0.04) {
						transitionTo('releasing');
					}
					break;
				case 'releasing':
					if (rmsNow < 0.10 && timeInState > 2) {
						transitionTo('calm');
					} else if (rmsDelta > 0.05 && timeInState > 3) {
						// Re-buildup detected — back up the energy curve.
						transitionTo('rising');
					}
					break;
			}
		}

		// LERP from previous mood snapshot → current state's mood, over 2.5s.
		const target = STATE_MOODS[songState];
		const transitionT = Math.min(1, timeInState / 2.5);
		const eased = smoothstepJs(0, 1, transitionT);
		const moodPalOffset = lerp(previousMood.palOffset, target.palOffset, eased);
		const moodPower = lerp(previousMood.power, target.power, eased);
		const moodFogMul = lerp(previousMood.fogMul, target.fogMul, eased);
		const moodShaftMul = lerp(previousMood.shaftMul, target.shaftMul, eased);
		const moodCamDistMul = lerp(previousMood.camDistMul, target.camDistMul, eased);
		const moodCamSpeedMul = lerp(previousMood.camSpeedMul, target.camSpeedMul, eased);

		// Audio overlays the state baseline — bass adds power pulse, centroid
		// nudges palette inside the state's window, RMS modulates shafts.
		// V2 director fields (drop / clock / palette) consumed defensively so
		// hot-reload races or older directors don't kill the RAF loop.
		const antic = directed.drop?.anticipation ?? 0;
		const postDrop = directed.drop?.postDropDecay ?? 0;
		const phrasePos = directed.clock?.phrasePos ?? directed.phrase ?? 0;
		const baseHue = directed.palette?.baseHue ?? directed.paletteBase ?? 0;
		const accentHue = directed.palette?.accentHue ?? directed.paletteAccent ?? 0;
		// Modest section bias — pushes growth/tension apart per section so
		// the anisotropic stretch in organismWarp produces a visible shape
		// change. Small enough that the raymarcher safety factor stays valid.
		let growthBias = 0;
		let tensionBias = 0;
		const dirSec = directed.section;
		if (dirSec === 'drop' || dirSec === 'chorus') {
			growthBias = 0.2;
			tensionBias = -0.1;
		} else if (dirSec === 'build' || dirSec === 'pre_chorus') {
			growthBias = -0.05;
			tensionBias = 0.25;
		} else if (dirSec === 'bridge') {
			growthBias = -0.15;
			tensionBias = -0.1;
		} else if (dirSec === 'breakdown' || dirSec === 'calm') {
			growthBias = -0.2;
			tensionBias = -0.15;
		}

		// ── Authored evolution events ──────────────────────────────────────
		// Phrase boundaries request a new framing, but the camera eases toward
		// it. Drops still feel decisive through light/form response without a
		// random hard cut or palette-family swap.
		const phraseIdx = directed.clock?.phraseIndex ?? 0;
		if (phraseIdx !== lastPhraseIndex) {
			if (lastPhraseIndex >= 0) {
				camPhaseTargetOffset += 0.32 + mk2SongSeed * 0.18;
			}
			lastPhraseIndex = phraseIdx;
		}
		// Alternate phrases bias the fractal power so the organism's topology
		// breathes on a 16-bar cycle instead of holding one shape forever.
		const phrasePowerBias = phraseIdx % 2 === 1 ? 0.28 : -0.18;
		if (dirSec !== lastDirSection) {
			if (dirSec === 'drop') {
				camPhaseTargetOffset += 0.7;
				smoothed.flash = Math.min(1, smoothed.flash + 0.7);
			} else if (dirSec === 'chorus' && lastDirSection !== 'drop') {
				camPhaseTargetOffset += 0.42;
			} else if (dirSec === 'breakdown' || dirSec === 'bridge') {
				camPhaseTargetOffset += 0.24;
			}
			lastDirSection = dirSec;
		}
		camPhaseOffset = lerp(camPhaseOffset, camPhaseTargetOffset, alpha(0.025));
		const growth = Math.max(
			0,
			Math.min(
				1,
				directed.energy * 0.42 +
					smoothed.smoothEnergy * 0.36 +
					smoothed.bass * 0.32 +
					smoothed.rmsSlow * 0.12 +
					smoothed.flash * 0.08 +
					antic * 0.22 +
					postDrop * 0.18 +
					growthBias
			)
		);
		const tension = Math.max(
			0,
			Math.min(
				1,
				directed.motion * 0.26 +
					directed.density * 0.18 +
					smoothed.mid * 0.34 +
					smoothed.treble * 0.12 +
					smoothed.flash * 0.08 +
					antic * 0.28 +
					tensionBias
			)
		);
		// Topology stays in the Mandelbulb's strongest range. Section mood sets
		// the base form; mids and sustained energy reveal detail without wildly
		// remeshing the whole subject on every transient.
		const mandelbulbPower = Math.max(
			5.8,
			Math.min(
				9.0,
				moodPower +
					smoothed.smoothEnergy * 0.35 +
					smoothed.mid * 0.25 +
					phrasePowerBias * (0.25 + smoothed.sustain * 0.15)
			)
		);
		const chromaAngleSlow = Math.atan2(smoothed.chromaYSlow, smoothed.chromaXSlow) / (2 * Math.PI);
		// Tonnetz palette (V2): baseHue + accent blend for harmonically-aware drift.
		const tonnetzBlend = 0.5 + 0.5 * Math.sin(phrasePos * Math.PI * 2);
		const hueFromTonnetz = baseHue * (1 - 0.3 * tonnetzBlend) + accentHue * 0.3 * tonnetzBlend;
		const paletteOffset =
			hueFromTonnetz + (moodPalOffset - 0.45) * 0.12 + (smoothed.centroidSlow - 0.5) * 0.06 + chromaAngleSlow * 0.04;
		const fogDensity =
			0.055 * moodFogMul +
			smoothed.bass * 0.025 +
			directed.density * 0.025 +
			antic * 0.012;
		const lightShaftIntensity =
			moodShaftMul *
			(0.28 +
				directed.energy * 0.34 +
				smoothed.bass * 0.16 +
				antic * 0.25 +
				postDrop * 0.35);
		// Track-stable focal length varies inside a deliberately narrow range;
		// identity changes without turning some tracks into distorted wide shots.
		const fovScale = 1.5 + mk2SongSeed * 0.2;

		// Camera path — state mood drives traversal speed and overall distance
		// from origin. Calm = far + slow drift; peak = close + fast traversal.
		// The track seed gives a restrained target offset and roll. Phrase/drop
		// events glide to a new path phase rather than cutting the camera.
		const sessionTargetY = -0.05 + (mk2SongSeed - 0.5) * 0.24;
		const sessionRoll = (mk2SongSeed - 0.5) * 0.24;
		const camPosRaw = getCameraPos(time, moodCamSpeedMul, camPhaseOffset);
		const camSceneScale = 1.08 - growth * 0.08;
		// Hand-held camera shake — driven by smoothEnergy (slow follower)
		// instead of raw flash, so kicks add subtle drift not jittery snap.
		// flash still contributes a tiny extra spike per onset for the
		// "impact" feel without making the whole image vibrate.
		const shakeT = time * 7.0;
		const shakeAmp = (smoothed.smoothEnergy * 0.014 + smoothed.flash * 0.004) * camSceneScale;
		const shakeX = (Math.sin(shakeT * 1.13) + Math.sin(shakeT * 2.7) * 0.5) * shakeAmp;
		const shakeY = (Math.cos(shakeT * 1.39) + Math.sin(shakeT * 3.1) * 0.5) * shakeAmp * 0.7;
		const shakeZ = (Math.sin(shakeT * 0.87 + 1.5) + Math.cos(shakeT * 2.3) * 0.5) * shakeAmp * 0.8;
		const camPos: [number, number, number] = [
			camPosRaw[0] * moodCamDistMul * camSceneScale + shakeX,
			camPosRaw[1] * moodCamDistMul * camSceneScale + shakeY,
			camPosRaw[2] * moodCamDistMul * camSceneScale + shakeZ
		];
		// Mode 2 (perched overhead) needs to look down at origin, not at the
		// session-biased Y target — otherwise camera looks past the organism.
		const targetY = CAM_MODE === 2 ? -0.35 : sessionTargetY;
		const camTarget: [number, number, number] = [0, targetY, 0];
		const fwd: [number, number, number] = [
			camTarget[0] - camPos[0],
			camTarget[1] - camPos[1],
			camTarget[2] - camPos[2]
		];
		const fwdLen = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
		fwd[0] /= fwdLen;
		fwd[1] /= fwdLen;
		fwd[2] /= fwdLen;
		// cross(fwd, worldUp=(0,1,0)) = (fwd.z, 0, -fwd.x)
		const right: [number, number, number] = [fwd[2], 0, -fwd[0]];
		const rLen = Math.hypot(right[0], right[1], right[2]) || 1;
		right[0] /= rLen;
		right[1] /= rLen;
		right[2] /= rLen;
		// up = cross(right, fwd) — then roll around fwd by sessionRoll so the
		// horizon line is tilted per session. Adds Dutch-angle camera identity.
		const baseUp: [number, number, number] = [
			right[1] * fwd[2] - right[2] * fwd[1],
			right[2] * fwd[0] - right[0] * fwd[2],
			right[0] * fwd[1] - right[1] * fwd[0]
		];
		const cr = Math.cos(sessionRoll);
		const sr = Math.sin(sessionRoll);
		const camUp: [number, number, number] = [
			baseUp[0] * cr + right[0] * sr,
			baseUp[1] * cr + right[1] * sr,
			baseUp[2] * cr + right[2] * sr
		];
		const rolledRight: [number, number, number] = [
			right[0] * cr - baseUp[0] * sr,
			right[1] * cr - baseUp[1] * sr,
			right[2] * cr - baseUp[2] * sr
		];
		right[0] = rolledRight[0];
		right[1] = rolledRight[1];
		right[2] = rolledRight[2];

		const u = gpu.uniformData;
		u[0] = w;
		u[1] = h;
		u[2] = time;
		u[3] = smoothed.bass;
		u[4] = smoothed.mid;
		u[5] = smoothed.treble;
		u[6] = smoothed.centroidSlow;
		u[7] = smoothed.rmsSlow;
		u[8] = smoothed.flash;
		u[9] = smoothed.bpmNormSlow;
		u[10] = smoothed.chromaXSlow;
		u[11] = smoothed.chromaYSlow;
		u[12] = feat?.chroma_strength ?? 0;
		u[13] = camPos[0];
		u[14] = camPos[1];
		u[15] = camPos[2];
		u[16] = fwd[0];
		u[17] = fwd[1];
		u[18] = fwd[2];
		u[19] = right[0];
		u[20] = right[1];
		u[21] = right[2];
		u[22] = camUp[0];
		u[23] = camUp[1];
		u[24] = camUp[2];
		u[25] = fovScale;
		u[26] = mandelbulbPower;
		u[27] = paletteOffset;
		u[28] = fogDensity;
		u[29] = lightShaftIntensity;
		u[30] = growth;
		u[31] = tension;
		// Per-track palette family stays stable; harmonic analysis moves within
		// it, so the track develops without looking like a preset roulette.
		u[32] = Math.floor(mk2SongSeed * 6);
		// ADSR + reverb channels — staccato spike, sustain mood envelope,
		// reverb time-since-onset normalized 0..1 over 2s.
		u[33] = smoothed.staccato;
		u[34] = smoothed.sustain;
		u[35] = Math.min(1, Math.max(0, (time - smoothed.reverbStart) / 2.0));
		gpu.device.queue.writeBuffer(gpu.uniformBuf, 0, u.buffer, u.byteOffset, u.byteLength);

		// Write FFT bins to storage buffer (consumed by particle shader).
		const featBins = feat?.bins;
		if (featBins) {
			for (let i = 0; i < BIN_COUNT; i++) gpu.binsData[i] = featBins[i] ?? 0;
		} else {
			gpu.binsData.fill(0);
		}
		gpu.device.queue.writeBuffer(
			gpu.binsBuf,
			0,
			gpu.binsData.buffer,
			gpu.binsData.byteOffset,
			gpu.binsData.byteLength
		);

		// Particle params — fade rate + spawn intensity vary with detected state
		// so particle persistence/density visibly evolves with song section.
		const pp = gpu.particleParamData;
		pp[0] = gpu.targets.particleW;
		pp[1] = gpu.targets.particleH;
		pp[2] = time;
		pp[3] = paletteOffset;
		// Fade: peak holds trails longer, calm fades faster.
		pp[4] =
			songState === 'peak' ? 0.92 : songState === 'rising' ? 0.9 : songState === 'releasing' ? 0.88 : 0.85;
		// Spawn intensity: keep the aura subordinate to the raymarched organism.
		pp[5] =
			songState === 'peak' ? 0.28 : songState === 'rising' ? 0.22 : songState === 'releasing' ? 0.16 : 0.10;
		// Radius offset: bass opens the aura, but it should not become a separate ring.
		pp[6] = smoothed.bass * 0.08 + directed.energy * 0.04;
		pp[7] = 0;
		gpu.device.queue.writeBuffer(
			gpu.particleParamBuf,
			0,
			pp.buffer,
			pp.byteOffset,
			PARTICLE_PARAM_BYTES
		);

		// ── Pack bloom params for five passes (3 down + 2 up).
		// Each slice is 256-byte aligned (WebGPU minimum dynamic uniform alignment).
		const bloomThreshold = 1.15; // HDR threshold for first downsample
		const bloomIntensity = 0.3; // contribution scale for each upsample
		const gpuRef = gpu;
		const bp = gpuRef.bloomParamData;
		// Helper to write a slice
		const writeSlice = (passIdx: number, fields: number[]) => {
			for (let k = 0; k < BLOOM_PARAM_FLOATS; k++) bp[k] = fields[k] ?? 0;
			gpuRef.device.queue.writeBuffer(
				gpuRef.bloomParamBuf,
				passIdx * 256,
				bp.buffer,
				bp.byteOffset,
				BLOOM_PARAM_BYTES
			);
		};
		// Down passes: source resolution → destination (half each level)
		const t = gpu.targets;
		// Level 0 down: src = scene full res; dst = mip 0 (half)
		writeSlice(0, [w, h, t.bloomSizes[0].w, t.bloomSizes[0].h, bloomThreshold, 0, 0, 0]);
		for (let i = 1; i < BLOOM_LEVELS; i++) {
			const src = t.bloomSizes[i - 1];
			const dst = t.bloomSizes[i];
			writeSlice(i, [src.w, src.h, dst.w, dst.h, 0, 0, 0, 0]);
		}
		// Up passes climb from the smallest mip back to mip 0.
		for (let i = 0; i < BLOOM_LEVELS - 1; i++) {
			const srcLevel = BLOOM_LEVELS - 1 - i;
			const dstLevel = srcLevel - 1;
			const src = t.bloomSizes[srcLevel];
			const dst = t.bloomSizes[dstLevel];
			writeSlice(BLOOM_LEVELS + i, [src.w, src.h, dst.w, dst.h, 0, bloomIntensity, 0, 0]);
		}

		const submittingGpu = gpuRef;
		const submittingBindGroups = submittingGpu.bindGroups;
		if (!submittingBindGroups) return;
		const submittingGeneration = initGeneration;
		try {
			const encoder = submittingGpu.device.createCommandEncoder();

		// Scene → sceneTex
		{
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{
						view: t.sceneView,
						clearValue: { r: 0, g: 0, b: 0, a: 1 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				]
			});
			pass.setPipeline(submittingGpu.pipelines.scene);
			pass.setBindGroup(0, submittingBindGroups.scene);
			pass.draw(6);
			pass.end();
		}

		// Bloom downsample chain (clear each mip, threshold on first only).
		for (let i = 0; i < BLOOM_LEVELS; i++) {
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{
						view: t.bloomViews[i],
						clearValue: { r: 0, g: 0, b: 0, a: 1 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				]
			});
			pass.setPipeline(submittingGpu.pipelines.bloomDown);
			pass.setBindGroup(0, submittingBindGroups.bloomDownBGs[i]);
			pass.draw(6);
			pass.end();
		}

		// Bloom upsample chain (additive blend into parent mip).
		for (let i = 0; i < BLOOM_LEVELS - 1; i++) {
			const dstLevel = BLOOM_LEVELS - 2 - i;
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{ view: t.bloomViews[dstLevel], loadOp: 'load', storeOp: 'store' }
				]
			});
			pass.setPipeline(submittingGpu.pipelines.bloomUp);
			pass.setBindGroup(0, submittingBindGroups.bloomUpBGs[i]);
			pass.draw(6);
			pass.end();
		}

		const prevIdx = (submittingGpu.frame % 2) as 0 | 1;
		const currIdx = (1 - prevIdx) as 0 | 1;

		// Particle update — reads previous particle tex, fades, adds bin splats,
		// writes new particle tex (ping-pong).
		{
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{
						view: t.particleViewsAB[currIdx],
						clearValue: { r: 0, g: 0, b: 0, a: 1 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				]
			});
			pass.setPipeline(submittingGpu.pipelines.particle);
			pass.setBindGroup(0, submittingBindGroups.particle[prevIdx]);
			pass.draw(6);
			pass.end();
		}

		// Composite → compositeTex (current ping-pong slot). Reads prev slot for
		// temporal motion blur via mix() in the shader.
		{
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{
						view: t.compositeViewsAB[currIdx],
						clearValue: { r: 0, g: 0, b: 0, a: 1 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				]
			});
			pass.setPipeline(submittingGpu.pipelines.composite);
			pass.setBindGroup(0, submittingBindGroups.composite[prevIdx]);
			pass.draw(6);
			pass.end();
		}

		// Present (tone-map + grain + CA) → swap chain
		{
			const view = submittingGpu.context.getCurrentTexture().createView();
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{
						view,
						clearValue: { r: 0, g: 0, b: 0, a: 1 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				]
			});
			pass.setPipeline(submittingGpu.pipelines.present);
			pass.setBindGroup(0, submittingBindGroups.present[currIdx]);
			pass.draw(6);
			pass.end();
		}

			submittingGpu.device.queue.submit([encoder.finish()]);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			failGpuDevice(
				submittingGpu,
				submittingGeneration,
				`Mk2 could not encode or submit WebGPU work: ${detail}. Switch to another visualizer and back to retry; if it repeats, restart Mewsik or update the graphics driver.`
			);
			return;
		}
		submittingGpu.frame++;
		if (!gpuReady) gpuReady = true;
	}

	$effect(() => {
		if (!canvas) {
			teardownGpu();
			return;
		}
		if (gpu) return;
		errorMsg = null;
		gpuReady = false;
		const initFor = canvas;
		const generation = ++initGeneration;
		initGpu(initFor)
			.then((g) => {
				if (!g) return;
				if (generation !== initGeneration || canvas !== initFor) {
					destroyGpuResources(g);
					return;
				}
				gpu = g;
				resetFrameScheduler();
				void g.device.lost.then((info) => {
					const reason = info.reason === 'destroyed' ? 'destroyed unexpectedly' : 'lost';
					const detail = info.message.trim();
					failGpuDevice(
						g,
						generation,
						`Mk2's WebGPU device was ${reason}${detail ? `: ${detail}` : ''}. Switch to another visualizer and back to retry; if it repeats, restart Mewsik or update the graphics driver.`
					);
				});
			})
			.catch((e) => {
				if (generation === initGeneration && canvas === initFor) {
					errorMsg = e instanceof Error ? e.message : String(e);
				}
			});
	});

	onMount(() => {
		running = true;
		raf = requestAnimationFrame(loop);
		void vis.subscribe().then((stop) => {
			if (!running) {
				stop();
				return;
			}
			unsub = stop;
		});
	});

	onDestroy(() => {
		running = false;
		cancelAnimationFrame(raf);
		if (unsub) {
			unsub();
			unsub = null;
		}
		teardownGpu();
	});
</script>

{#if vis.active}
	<div class="fixed inset-0 z-[100] overflow-hidden bg-black">
		<div
			class="pointer-events-none absolute inset-0 transition-opacity duration-500"
			class:opacity-0={gpuReady}
			style="background: radial-gradient(circle at 50% 44%, #171029 0%, #070410 46%, #000 78%);"
			aria-hidden="true"
		></div>
		<canvas
			bind:this={canvas}
			class="relative z-10 h-full w-full transition-opacity duration-300"
			class:opacity-0={!gpuReady}
		></canvas>
		{#if showHud}
			<button
				type="button"
				class="absolute inset-0 z-20 cursor-default border-0 bg-transparent p-0"
				aria-label="Close visualizer"
				onclick={() => vis.toggle()}
				onkeydown={(event) => {
					if (event.key === 'Escape') vis.toggle();
				}}
			></button>
			<div class="pointer-events-none absolute right-6 top-6 z-30 text-xs text-white/40">
				mk2 — fractal atmosphere — click anywhere or press esc to exit
			</div>
			<div
				class="pointer-events-none absolute left-6 top-6 z-30 rounded border border-white/15 bg-black/40 px-2 py-1 font-mono text-xs uppercase tracking-wider text-white/70"
			>
				section: <strong>{songState}</strong>
			</div>
		{/if}
		{#if errorMsg}
			<div class="pointer-events-none absolute left-6 top-16 z-30 max-w-md text-xs text-red-300/80">
				Visualizer error: {errorMsg}
			</div>
		{/if}
	</div>
{/if}
