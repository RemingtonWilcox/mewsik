<script lang="ts">
	// Mark II visualizer — "Drift Through a Fractal Atmosphere"
	//
	// Architecture per research findings:
	//   • Mandelbulb SDF raymarched as the hero — a genuine fractal architecture,
	//     not a smoothed primitive. Forms read as alien geology, not "blob."
	//   • Volumetric participating medium — fog density accumulates along each
	//     ray with proper transmittance, AND scatters light from a key source.
	//     Light shafts emerge naturally where the fractal occludes the sun.
	//     ~60% of label-grade visuals by pixel count IS atmosphere.
	//   • Catmull-Rom camera path through 6 waypoints. Eased traversal speed.
	//     Camera looks at origin (where the Mandelbulb sits). Authored motion,
	//     not procedural drift.
	//   • Photographic 7-stop palette interpolated smoothly — golden hour /
	//     dusk / deep space stops, never cosine RGB.
	//   • ACES filmic tone map + procedural film grain + edge chromatic
	//     aberration + vignette + dither for post-processing signature.
	//
	// Audio routing (multiple timescales):
	//   • bass (fast)        → Mandelbulb power pulse + fog density
	//   • mid (medium)       → specular sharpness, displacement amplitude
	//   • treble (fast)      → grain intensity, small surface ripple
	//   • centroid (slow)    → palette LERP position
	//   • chromaKey (slow)   → key light hue
	//   • bpmNorm (slow)     → camera traversal speed multiplier
	//   • rms (slow)         → light shaft intensity
	//   • onset (impulse)    → tiny camera nudge
	//
	// Future iterations: phrase-aware waypoint advancement, Kawase bloom, real
	// circle-of-confusion DOF, Mandelbox / hybrid IFS variants per song seed.

	import { onMount, onDestroy } from 'svelte';
	import { useVisualizer } from '$lib/state/visualizer.svelte';
	import { createVisualDirector } from '$lib/visualizer/visual-director';

	const vis = useVisualizer();
	const director = createVisualDirector();
	let { showHud = false } = $props<{ showHud?: boolean }>();

	let canvas = $state<HTMLCanvasElement | null>(null);
	let errorMsg = $state<string | null>(null);
	let raf = 0;
	let unsub: (() => void) | null = null;
	// Tripped in onDestroy before teardownGpu so any in-flight RAF tick early-
	// returns instead of touching destroyed GPU resources mid-frame.
	let running = false;
	// Per-session seed → picks the palette family on mount. Different mounts
	// (engine swap in lab, app remount) reroll the colour world.
	const mk2SongSeed = Math.random();

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
		reverbStart: -10 // wall-time of last onset; used to derive reverbT
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
		saturation: number; // post-saturation
	};
	const STATE_MOODS: Record<SongState, StateMood> = {
		// Calm: cool, distant, slow, dim. Palette in deep navy / plum end.
		calm: {
			palOffset: 0.02,
			power: 7.0,
			fogMul: 0.55,
			shaftMul: 0.4,
			camDistMul: 1.35,
			camSpeedMul: 0.5,
			saturation: 0.85
		},
		// Rising: warming, pushing in, increasing fog, palette moves toward gold.
		rising: {
			palOffset: 0.45,
			power: 7.7,
			fogMul: 1.1,
			shaftMul: 1.2,
			camDistMul: 1.0,
			camSpeedMul: 1.1,
			saturation: 1.0
		},
		// Peak: hot, close, fast, full fog, palette in cream/gold. Drop hits live here.
		peak: {
			palOffset: 0.6,
			power: 8.6,
			fogMul: 1.7,
			shaftMul: 1.9,
			camDistMul: 0.82,
			camSpeedMul: 1.6,
			saturation: 1.15
		},
		// Releasing: cooling out, pulling back, palette moves to steel/cyan.
		releasing: {
			palOffset: 0.85,
			power: 7.4,
			fogMul: 0.85,
			shaftMul: 0.9,
			camDistMul: 1.15,
			camSpeedMul: 0.7,
			saturation: 0.95
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

	// One of five camera identities per session — picked from mk2SongSeed
	// at module scope below. Each mode produces a fundamentally different
	// motion pattern through 3D space, not just different visits to the
	// same waypoint loop.
	//   0 waypoint   — current Catmull-Rom through 6 hand-picked positions
	//   1 ring       — constant-radius azimuthal orbit, slow y drift
	//   2 dive       — figure-eight passes THROUGH the organism each loop
	//   3 spiral     — radius decays then snaps back; spirals inward
	//   4 perched    — high overhead, slow yaw, looking down
	const CAM_MODE = Math.floor(mk2SongSeed * 5) % 5;

	function getCameraPos(time: number, speedMul: number): [number, number, number] {
		const baseSpeed = 0.020 + smoothed.bpmNormSlow * 0.025 + smoothed.rmsSlow * 0.015;
		const dt = Math.max(0, time - camPhaseLastTime);
		camPhase += dt * baseSpeed * speedMul;
		camPhaseLastTime = time;

		if (CAM_MODE === 1) {
			// Ring orbit — constant radius, azimuthal sweep
			const a = camPhase * 1.1;
			const radius = 3.4;
			return [Math.cos(a) * radius, 1.0 + Math.sin(camPhase * 0.27) * 0.8, Math.sin(a) * radius];
		}
		if (CAM_MODE === 2) {
			// Dive-through — figure-eight passing through origin
			const a = camPhase * 0.7;
			const r = 3.0 + Math.sin(a * 2) * 1.8; // pulses inward
			return [Math.cos(a) * r, Math.sin(a * 0.5) * 1.4, Math.sin(a * 2) * r * 0.7];
		}
		if (CAM_MODE === 3) {
			// Spiral — radius shrinks then resets each ~12s
			const phase = (camPhase * 0.5) % 12;
			const t = phase / 12;
			const a = phase * 0.8;
			const radius = 4.5 - t * 2.5;
			const y = 0.6 + t * 1.4;
			return [Math.cos(a) * radius, y, Math.sin(a) * radius];
		}
		if (CAM_MODE === 4) {
			// Perched overhead — slow yaw, looking down (handled in target)
			const a = camPhase * 0.35;
			return [Math.cos(a) * 2.2, 3.6, Math.sin(a) * 2.2];
		}
		// Default — original Catmull-Rom waypoint loop
		const cycle = camPhase % CAM_WAYPOINTS.length;
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
	let q = organismWarp(p);

	// Core fractal body. Audio changes the coordinate field and power, so the
	// organism actually grows/twists instead of sitting under a post glow.
	let bodyScale = 1.05 + growth * 0.10 - u.flash * 0.030;
	// Audio-driven iter count — calm sections are intentionally LESS detailed
	// so drops landing at 11 iterations read as the fractal "blooming" into
	// existence. 4 iters = smooth blob; 11 = full Mandelbulb spine detail.
	let audioIters = 4 + i32(floor(growth * 5.0 + tension * 3.0));
	let safeIters = clamp(audioIters, 4, 11);
	var body = mandelbulbDE(q * bodyScale, u.mandelbulbPower + tension * 0.55, safeIters) * (1.03 - growth * 0.10);

	// Breathing membrane/lobed shell. This gives build-ups a visible expansion
	// phase and drops a wider silhouette without replacing the Mandelbulb core.
	let shellRadius = 0.62 + growth * 0.18 + sin(q.y * 2.3 + u.time * 0.23) * (0.020 + u.mid * 0.020);
	let shell = abs(length(q * vec3<f32>(0.95, 1.08, 0.95)) - shellRadius)
		- (0.018 + u.bass * 0.018 + growth * 0.010);
	body = body - exp(-abs(shell) * 18.0) * (0.004 + growth * 0.007 + u.bass * 0.004);

	// Tendril lanes: multiple helixes attached to the same warped space. These
	// react to tension/midrange so hooks and bridges visibly braid or loosen.
	var tendril = 1000.0;
	for (var i: i32 = 0; i < 6; i = i + 1) {
		let fi = f32(i) / 6.0;
		let phase = fi * 6.2831853 + u.paletteOffset * 6.2831853 + u.time * (0.045 + u.bpmNorm * 0.075);
		let yPhase = q.y * (2.1 + tension * 0.8) + phase;
		let radius = 0.30 + growth * 0.32 + sin(q.y * 2.7 + phase) * (0.040 + u.mid * 0.030);
		let lane = vec2<f32>(cos(yPhase), sin(yPhase)) * radius;
		let d = length(q.xz - lane) - (0.014 + u.mid * 0.030 + u.flash * 0.026);
		tendril = min(tendril, d);
	}
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

// Short march toward light for soft shadow + light-shaft occlusion test.
fn lightVisibility(ro: vec3<f32>, rd: vec3<f32>, maxt: f32) -> f32 {
	var res = 1.0;
	var t = 0.02;
	for (var i: i32 = 0; i < 16; i = i + 1) {
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

// Background gradient — deep cosmic with subtle palette-position-driven tint.
// Sampled via the palette where the deepest end is the "void."
fn sky(rd: vec3<f32>) -> vec3<f32> {
	let up = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
	let baseT = u.paletteOffset;
	let horizon = palette7(baseT) * 0.18;
	let zenith = palette7(baseT + 0.7) * 0.05;
	return mix(horizon, zenith, smoothstep(0.0, 1.0, up));
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
	let MAX_STEPS = 96;
	let MAX_DIST = 14.0;
	let EPS = 0.0015;

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

		// ── Surface hit
		if (d < EPS) {
			let n = calcNormal(p);
			let view = -rd;
			let cosNL = max(0.0, dot(n, lightDir));
			let halfDir = safeNormalize(lightDir + view, lightDir);
			let cosNH = max(0.0, dot(n, halfDir));
			let cosNV = max(0.0, dot(n, view));
			let shadow = lightVisibility(p + n * 0.005, lightDir, 4.0);

			// Cheap ambient occlusion — five short samples along surface normal.
			var ao = 0.0;
			var aoW = 0.0;
			for (var k: i32 = 1; k <= 5; k = k + 1) {
				let ko = f32(k) * 0.05;
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

			// Key + ambient lighting
			let keyTint = palette7(u.paletteOffset + 0.18) * 1.4 + vec3<f32>(0.05);
			let fillTint = palette7(u.paletteOffset + 0.6) * 0.35;
			let direct = keyTint * cosNL * shadow;
			let ambient = fillTint * (0.55 + n.y * 0.5);
			let diffuse = baseCol * (direct + ambient) * ao;
			let specularCol = irid * (specular * 1.4 + fresnel * 0.5) * shadow;
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
			// that radiates outward from the organism over ~2s after each
			// onset. reverbT goes 0->1 over 2s; ringR is the radius of the
			// expanding ring (grows with reverbT); ringWidth pinches as it
			// expands so it reads as a single moving band.
			let ringR = u.reverbT * 1.4;
			let ringWidth = 0.05 + u.reverbT * 0.20;
			let distToRing = abs(length(p) - ringR);
			let ringMask = smoothstep(ringWidth, 0.0, distToRing) * (1.0 - u.reverbT);
			let reverbCol = palette7(u.paletteOffset + 0.62) * ringMask * 0.8;

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
		// Light visibility from this point — what fraction of light reaches here?
		let lightV = lightVisibility(p, lightDir, 5.5);
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
		let stepSize = max(d * 0.85, 0.05);
		t = t + stepSize;
		if (transmittance < 0.01) { break; }
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
	// Wide tent-blur for upsample (9-tap Kawase variation).
	var c = textureSample(srcTex, samp, uv).rgb * 0.25;
	c = c + textureSample(srcTex, samp, uv + vec2<f32>(-1.0,  0.0) * texel).rgb * 0.125;
	c = c + textureSample(srcTex, samp, uv + vec2<f32>( 1.0,  0.0) * texel).rgb * 0.125;
	c = c + textureSample(srcTex, samp, uv + vec2<f32>( 0.0, -1.0) * texel).rgb * 0.125;
	c = c + textureSample(srcTex, samp, uv + vec2<f32>( 0.0,  1.0) * texel).rgb * 0.125;
	c = c + textureSample(srcTex, samp, uv + vec2<f32>(-1.0, -1.0) * texel).rgb * 0.0625;
	c = c + textureSample(srcTex, samp, uv + vec2<f32>( 1.0, -1.0) * texel).rgb * 0.0625;
	c = c + textureSample(srcTex, samp, uv + vec2<f32>(-1.0,  1.0) * texel).rgb * 0.0625;
	c = c + textureSample(srcTex, samp, uv + vec2<f32>( 1.0,  1.0) * texel).rgb * 0.0625;
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
	// Each frame fades the previous particle texture and adds 64 bin-keyed
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

	// Add 64 bin contributions. Each bin lives at angle = (bin/64)·2π with
	// slow azimuthal drift, radius staircase, energy-driven brightness.
	var contrib = vec3<f32>(0.0);
	for (var i: i32 = 0; i < 64; i = i + 1) {
		let bin = bins[i];
		if (bin < 0.03) { continue; }
		let fi = f32(i) / 64.0;
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

	// Bloom param uniform layout — 8 f32s = 32 bytes (×4 mips, ×2 for up/down).
	const BLOOM_PARAM_FLOATS = 8;
	const BLOOM_PARAM_BYTES = BLOOM_PARAM_FLOATS * 4;
	const BLOOM_LEVELS = 4;

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
			// Particle ping-pong textures (half res)
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
	const t0 = performance.now();

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
		// Particle ping-pong textures (half res — 64-bin inner loop per pixel
		// is expensive at full res).
		const particleW = Math.max(1, Math.floor(w / 2));
		const particleH = Math.max(1, Math.floor(h / 2));
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
		// Bloom upsample bind groups: src=mip[i+1], dst=mip[i]; 3 upsamples to
		// climb from mip 3 → 2 → 1 → 0. Param slice offset starts at level 4.
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
			size: 256 * 7,
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

	function ensureTargets(g: GPU, w: number, h: number) {
		if (g.targets && g.targets.width === w && g.targets.height === h) return;
		if (g.targets) {
			g.targets.scene.destroy();
			for (const t of g.targets.bloomMips) t.destroy();
			g.targets.compositeAB[0].destroy();
			g.targets.compositeAB[1].destroy();
			g.targets.particleAB[0].destroy();
			g.targets.particleAB[1].destroy();
		}
		g.targets = buildTargets(g.device, w, h);
		g.bindGroups = buildBindGroups(g);
	}

	function teardownGpu() {
		if (!gpu) return;
		try {
			if (gpu.targets) {
				gpu.targets.scene.destroy();
				for (const t of gpu.targets.bloomMips) t.destroy();
				gpu.targets.compositeAB[0].destroy();
				gpu.targets.compositeAB[1].destroy();
				gpu.targets.particleAB[0].destroy();
				gpu.targets.particleAB[1].destroy();
			}
			gpu.uniformBuf.destroy();
			gpu.bloomParamBuf.destroy();
			gpu.binsBuf.destroy();
			gpu.particleParamBuf.destroy();
			gpu.device.destroy?.();
		} catch {}
		gpu = null;
	}

	function loop() {
		if (!running || !canvas || !gpu) {
			if (running) raf = requestAnimationFrame(loop);
			return;
		}

		// Mandelbulb is expensive — cap DPR at 1.5 so we get good fps on integrated GPUs.
		const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
		const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
		const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		ensureTargets(gpu, w, h);
		if (!gpu.bindGroups || !gpu.targets) {
			raf = requestAnimationFrame(loop);
			return;
		}

		const time = (performance.now() - t0) / 1000;
		const feat = vis.latest;
		const directed = director.update(feat, time);

		// Smooth audio at appropriate timescales.
		// Fast-attack params for transients:
		smoothed.bass = lerp(smoothed.bass, feat?.bass ?? 0, 0.25);
		smoothed.mid = lerp(smoothed.mid, feat?.mid ?? 0, 0.18);
		smoothed.treble = lerp(smoothed.treble, feat?.treble ?? 0, 0.35);
		if (feat?.onset) {
			smoothed.flash = 1;
			smoothed.staccato = 1;
			smoothed.reverbStart = time;
		}
		smoothed.flash *= 0.88;
		// staccato — sharper than flash; ~3-frame half-life. Used for crisp
		// surface spike emission, not for the broader fog flash.
		smoothed.staccato *= 0.74;
		// sustain — long-RMS follower (~5s envelope). Drives mood-level
		// changes, not transient response.
		const sustainTarget = smoothed.rmsSlow;
		smoothed.sustain = smoothed.sustain * 0.992 + sustainTarget * 0.008;
		// Slow params (mood / palette / camera):
		smoothed.centroidSlow = lerp(smoothed.centroidSlow, feat?.centroid ?? 0.5, 0.015);
		smoothed.rmsSlow = lerp(smoothed.rmsSlow, feat?.rms ?? 0, 0.02);
		smoothed.bpmNormSlow = lerp(
			smoothed.bpmNormSlow,
			feat?.bpm ? Math.max(0, Math.min(1, (feat.bpm - 60) / 120)) : 0,
			0.012
		);
		// Circular chroma smoothing (slow)
		const chromaAngle = (feat?.chroma_key ?? 0) * 2 * Math.PI;
		smoothed.chromaXSlow = lerp(smoothed.chromaXSlow, Math.cos(chromaAngle), 0.02);
		smoothed.chromaYSlow = lerp(smoothed.chromaYSlow, Math.sin(chromaAngle), 0.02);

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
		const timeInState = time - stateEnterTime;
		const transitionTo = (next: SongState) => {
			if (next !== songState) {
				previousMood = (() => {
					// Snapshot current effective mood at transition start so we LERP
					// from where the visual currently sits, not from the template baseline.
					const mp = STATE_MOODS[songState];
					return { ...mp };
				})();
				songState = next;
				stateEnterTime = time;
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
			growthBias = 0.20; tensionBias = -0.10;
		} else if (dirSec === 'build' || dirSec === 'pre_chorus') {
			growthBias = -0.05; tensionBias = 0.25;
		} else if (dirSec === 'bridge') {
			growthBias = -0.15; tensionBias = -0.10;
		} else if (dirSec === 'breakdown' || dirSec === 'calm') {
			growthBias = -0.20; tensionBias = -0.15;
		}
		const growth = Math.max(0, Math.min(1,
			directed.energy * 0.72 + smoothed.bass * 0.24 + smoothed.rmsSlow * 0.18 + smoothed.flash * 0.18 + antic * 0.42 + postDrop * 0.35 + growthBias
		));
		const tension = Math.max(0, Math.min(1,
			directed.motion * 0.38 +
				directed.density * 0.26 +
				smoothed.mid * 0.20 +
				smoothed.treble * 0.12 +
				smoothed.flash * 0.24 +
				antic * 0.40 + tensionBias
		));
		const mandelbulbPower =
			moodPower + smoothed.bass * 0.28 + smoothed.mid * 0.16 + directed.structure * 0.10 + smoothed.flash * 0.18 + antic * 0.22 + postDrop * 0.18;
		const chromaAngleSlow = Math.atan2(smoothed.chromaYSlow, smoothed.chromaXSlow) / (2 * Math.PI);
		// Tonnetz palette (V2): baseHue + accent blend for harmonically-aware drift.
		const tonnetzBlend = 0.5 + 0.5 * Math.sin(phrasePos * Math.PI * 2);
		const hueFromTonnetz = baseHue * (1 - 0.3 * tonnetzBlend) + accentHue * 0.3 * tonnetzBlend;
		const paletteOffset =
			hueFromTonnetz + (moodPalOffset - 0.45) * 0.12 + (smoothed.centroidSlow - 0.5) * 0.06 + chromaAngleSlow * 0.04;
		const fogDensity = 0.07 * moodFogMul + smoothed.bass * 0.035 + directed.density * 0.055 + antic * 0.025;
		const lightShaftIntensity = moodShaftMul * (0.30 + directed.energy * 0.48 + smoothed.bass * 0.13 + antic * 0.55 + postDrop * 0.70);
		// Per-session FOV — different sessions land different focal lengths
		// (1.35 = wide-angle dramatic, 1.95 = tighter portrait). Combined
		// with target offset + roll below, the same waypoint loop produces
		// totally different framings per mount.
		const fovScale = 1.35 + mk2SongSeed * 0.60;

		// Camera path — state mood drives traversal speed and overall distance
		// from origin. Calm = far + slow drift; peak = close + fast traversal.
		// PER-SESSION VARIATION: each load shifts the look-target Y, adds a
		// roll on camUp, and offsets the traversal start phase so different
		// mounts visit the waypoints in different orders → genuinely different
		// camera identity.
		const sessionPhaseOffset = mk2SongSeed * 6.28318; // 0..2π start offset
		const sessionTargetY = -0.05 + (mk2SongSeed - 0.5) * 0.45; // -0.275..+0.20
		const sessionRoll = (mk2SongSeed - 0.5) * 0.55; // ±0.275 rad ≈ ±16°
		const camPosRaw = getCameraPos(time + sessionPhaseOffset, moodCamSpeedMul);
		const camSceneScale = 1.18 + growth * 0.20;
		const camPos: [number, number, number] = [
			camPosRaw[0] * moodCamDistMul * camSceneScale,
			camPosRaw[1] * moodCamDistMul * camSceneScale,
			camPosRaw[2] * moodCamDistMul * camSceneScale
		];
		// Mode 4 (perched overhead) needs to look down at origin, not at the
		// session-biased Y target — otherwise camera looks past the organism.
		const targetY = CAM_MODE === 4 ? -0.4 : sessionTargetY;
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
		let camUp: [number, number, number] = [
			right[1] * fwd[2] - right[2] * fwd[1],
			right[2] * fwd[0] - right[0] * fwd[2],
			right[0] * fwd[1] - right[1] * fwd[0]
		];
		const cr = Math.cos(sessionRoll);
		const sr = Math.sin(sessionRoll);
		camUp = [
			camUp[0] * cr + right[0] * sr,
			camUp[1] * cr + right[1] * sr,
			camUp[2] * cr + right[2] * sr
		];
		const rolledRight: [number, number, number] = [
			right[0] * cr - camUp[0] * sr,
			right[1] * cr - camUp[1] * sr,
			right[2] * cr - camUp[2] * sr
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
		// Per-session palette family — mk2SongSeed picks one of six totally
		// distinct colour worlds (dusk / aurora / synthwave / volcanic /
		// bioluminous / oil-on-water). Reload or switch engines to reroll.
		u[32] = Math.floor(mk2SongSeed * 6) % 6;
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
			songState === 'peak' ? 0.94 : songState === 'rising' ? 0.925 : songState === 'releasing' ? 0.91 : 0.885;
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

		// ── Pack bloom params for all 7 passes (4 down + 3 up).
		// Each slice is 256-byte aligned (WebGPU minimum dynamic uniform alignment).
		const bloomThreshold = 1.15; // HDR threshold for first downsample
		const bloomIntensity = 0.34; // contribution scale for each upsample
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
		// Up passes: index 4,5,6 → climb from mip 3 to mip 0
		for (let i = 0; i < BLOOM_LEVELS - 1; i++) {
			const srcLevel = BLOOM_LEVELS - 1 - i;
			const dstLevel = srcLevel - 1;
			const src = t.bloomSizes[srcLevel];
			const dst = t.bloomSizes[dstLevel];
			writeSlice(BLOOM_LEVELS + i, [src.w, src.h, dst.w, dst.h, 0, bloomIntensity, 0, 0]);
		}

		const encoder = gpu.device.createCommandEncoder();

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
			pass.setPipeline(gpu.pipelines.scene);
			pass.setBindGroup(0, gpu.bindGroups.scene);
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
			pass.setPipeline(gpu.pipelines.bloomDown);
			pass.setBindGroup(0, gpu.bindGroups.bloomDownBGs[i]);
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
			pass.setPipeline(gpu.pipelines.bloomUp);
			pass.setBindGroup(0, gpu.bindGroups.bloomUpBGs[i]);
			pass.draw(6);
			pass.end();
		}

		const prevIdx = (gpu.frame % 2) as 0 | 1;
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
			pass.setPipeline(gpu.pipelines.particle);
			pass.setBindGroup(0, gpu.bindGroups.particle[prevIdx]);
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
			pass.setPipeline(gpu.pipelines.composite);
			pass.setBindGroup(0, gpu.bindGroups.composite[prevIdx]);
			pass.draw(6);
			pass.end();
		}

		// Present (tone-map + grain + CA) → swap chain
		{
			const view = gpu.context.getCurrentTexture().createView();
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
			pass.setPipeline(gpu.pipelines.present);
			pass.setBindGroup(0, gpu.bindGroups.present[currIdx]);
			pass.draw(6);
			pass.end();
		}

		gpu.device.queue.submit([encoder.finish()]);
		gpu.frame++;
		raf = requestAnimationFrame(loop);
	}

	$effect(() => {
		if (!canvas) {
			teardownGpu();
			return;
		}
		if (gpu) return;
		errorMsg = null;
		const initFor = canvas;
		initGpu(initFor)
			.then((g) => {
				if (!g) return;
				if (canvas !== initFor) {
					try {
						g.uniformBuf.destroy();
						g.device.destroy?.();
					} catch {}
					return;
				}
				gpu = g;
			})
			.catch((e) => {
				errorMsg = e instanceof Error ? e.message : String(e);
			});
	});

	onMount(async () => {
		unsub = await vis.subscribe();
		running = true;
		raf = requestAnimationFrame(loop);
	});

	onDestroy(() => {
		running = false;
		cancelAnimationFrame(raf);
		if (unsub) unsub();
		teardownGpu();
	});
</script>

{#if vis.active}
	<div
		class="fixed inset-0 z-[100] bg-black"
		role="button"
		aria-label="Close visualizer"
		onclick={() => {
			if (showHud) vis.toggle();
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape' && showHud) vis.toggle();
		}}
		tabindex="0"
	>
		<canvas bind:this={canvas} class="h-full w-full"></canvas>
		{#if showHud}
			<div class="pointer-events-none absolute right-6 top-6 text-xs text-white/40">
				mk2 — fractal atmosphere — click anywhere or press esc to exit
			</div>
			<div
				class="pointer-events-none absolute left-6 top-6 rounded border border-white/15 bg-black/40 px-2 py-1 font-mono text-xs uppercase tracking-wider text-white/70"
			>
				section: <strong>{songState}</strong>
			</div>
		{/if}
		{#if errorMsg}
			<div class="absolute left-6 top-16 max-w-md text-xs text-red-300/80">
				Visualizer error: {errorMsg}
			</div>
		{/if}
	</div>
{/if}
