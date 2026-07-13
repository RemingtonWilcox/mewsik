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
	//   • AgX filmic tone map + restrained edge chromatic aberration, vignette,
	//     and stable dither for a clean post-processing signature.
	//
	// Audio routing (multiple timescales):
	//   • bass (fast)        → organism breath/growth + fog density
	//   • mid (medium)       → topology detail, twist + specular sharpness
	//   • treble (fast)      → small surface ripple + spectral detail
	//   • centroid (slow)    → palette LERP position
	//   • chromaKey (slow)   → key light hue
	//   • bpmNorm (slow)     → camera traversal speed multiplier
	//   • rms (slow)         → light shaft intensity
	//   • onset (impulse)    → restrained surface/scale impact only
	//
	// Future iterations: optional quality tiers, real circle-of-confusion DOF,
	// Mandelbox / hybrid IFS variants per song seed.

	import { onMount, onDestroy } from 'svelte';
	import {
		useVisualizer,
		type VisualizerJourneySnapshot
	} from '$lib/state/visualizer.svelte';
	import { mk2ContinuousPaletteBlend } from '$lib/visualizer/mk2/conductor';

	const vis = useVisualizer();
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
	let mk2SongSeed = 0.5;
	let rendererSourceEpoch = -1;
	let rendererSyncRequested = true;

	// Mk2 borrows Signal's persistent song journey, then moves on deliberately
	// slower rails. The only fast rail is a restrained surface/scale impact.
	let temporalResetRequested = true;
	let currentSection = $state('intro');

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
		staccato: 0,
		sustain: 0
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

	// One of three authored camera identities per track. The old dive-through
	// and resettable spiral modes regularly crossed the geometry or visibly
	// snapped, so production Mk2 keeps only compositions that preserve a hero.
	//   0 waypoint   — current Catmull-Rom through 6 hand-picked positions
	//   1 ring       — constant-radius azimuthal orbit, slow y drift
	//   2 perched    — high overhead, slow yaw, looking down
	let CAM_MODE = Math.floor(mk2SongSeed * 3) % 3;

	function getCameraPos(cameraPhase: number, phaseOffset: number): [number, number, number] {
		const pathPhase = cameraPhase + phaseOffset;

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

	function syncRendererToJourney(snapshot: VisualizerJourneySnapshot) {
		if (snapshot.sourceEpoch === rendererSourceEpoch) return;
		rendererSourceEpoch = snapshot.sourceEpoch;
		mk2SongSeed = snapshot.seed;
		CAM_MODE = Math.floor(mk2SongSeed * 3) % 3;
		currentSection = snapshot.director.section;
		rendererSyncRequested = true;
		temporalResetRequested = true;
		resetFrameScheduler();
	}

	// ──────────────────────────────────────────────────────────────────────────
	// Uniform layout — 40 f32s = 160 bytes (multiple of 16 ✓)
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
	// 30-31 growth / tension
	// 32-35 palette family / surface impact / openness / rotation phase
	// 36-39 background phase / posture yaw / posture pitch / suspense
	const UNIFORM_FLOATS = 40;
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
	surfaceImpact: f32,
	openness: f32,
	journeyPhase: f32,
	backgroundPhase: f32,
	postureYaw: f32,
	posturePitch: f32,
	suspense: f32,
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
	let impact = clamp(u.flash, 0.0, 1.0);
	let openness = clamp(u.openness, 0.0, 1.0);
	// Expansion is a slow section posture. The transient rail contributes only a
	// small, quickly-settling punch instead of remeshing every part of the scene.
	let breath = 1.0
		+ growth * 0.115
		+ openness * 0.065
		+ u.bass * 0.035
		+ impact * 0.024
		+ sin(u.journeyPhase * 0.72) * 0.010;
	var q = p / breath;

	// A continuous, unwrapped phase rotates the same organism over the song.
	// Key/phrase posture is separately smoothed on the CPU, so neither pitch-class
	// wrap nor phrase boundaries can snap the coordinate frame.
	let globalYaw = u.journeyPhase + u.postureYaw;
	let yawed = rot2(q.xz, globalYaw);
	q.x = yawed.x;
	q.z = yawed.y;
	let pitched = rot2(q.yz, u.posturePitch);
	q.y = pitched.x;
	q.z = pitched.y;

	// Slow organic unfolding follows the musical journey phase, not wall-clock
	// noise or raw onsets.
	let tSlow = u.journeyPhase * 0.9 + u.backgroundPhase * 0.35;
	let drift = vec3<f32>(
		sin(q.y * 0.9 + tSlow) * 0.038 + cos(q.z * 0.7 - tSlow * 0.6) * 0.026,
		sin(q.x * 0.7 - tSlow * 0.4) * 0.026,
		cos(q.x * 0.9 + tSlow * 0.8) * 0.038 + sin(q.y * 0.7 + tSlow * 0.5) * 0.026
	);
	q = q + drift * (0.45 + growth * 0.45);

	// Section-driven anisotropic stretch — gentler than the failed attempt.
	// 0.18 amplitude means clear silhouette change between sections without
	// the raymarcher safety factor needing to be aggressive.
	let differential = tension - growth;
	let stretchY = 1.0 + differential * 0.18;
	let stretchXZ = 1.0 - differential * 0.14;
	q.x = q.x / stretchXZ;
	q.z = q.z / stretchXZ;
	q.y = q.y / stretchY;

	// Use the circular key vector directly. Unlike atan2(), these controls remain
	// continuous when pitch class crosses the 0/1 boundary.
	let chromaPull = clamp(u.chromaStrength, 0.0, 1.0);
	let chromaTilt = u.chromaY * chromaPull * 0.15;
	let rChroma = rot2(q.xy, chromaTilt);
	q.x = rChroma.x;
	q.y = rChroma.y;

	// Tension winds the form gradually; mids add texture-scale motion rather than
	// an onset-driven whole-body jolt.
	let twist = q.y * (0.28 + tension * 0.78 + u.suspense * 0.12)
		+ sin(q.z * 1.35 + tSlow * 1.25) * (0.055 + u.mid * 0.10)
		+ u.chromaX * chromaPull * 0.045;
	let rxz = rot2(q.xz, twist);
	q.x = rxz.x;
	q.z = rxz.y;
	let rxy = rot2(q.xy, sin(q.z * 0.9 + tSlow * 0.72) * (0.055 + growth * 0.075));
	q.x = rxy.x;
	q.y = rxy.y;
	q.y = q.y + sin(q.x * 1.7 + tSlow * 0.65) * (0.028 + tension * 0.035);
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
	let bodyScale = 1.04 + growth * 0.055;
	// A constant iteration count avoids discrete 5/6/7-step topology pops. Power,
	// stretch and warp already provide continuous musical evolution.
	var body = mandelbulbDE(q * bodyScale, u.mandelbulbPower + tension * 0.34, 6) * (1.025 - growth * 0.065);

	// Breathing membrane/lobed shell. This gives build-ups a visible expansion
	// phase and drops a wider silhouette without replacing the Mandelbulb core.
	let shellRadius = 0.61 + growth * 0.15 + u.openness * 0.055
		+ sin(q.y * 2.3 + u.journeyPhase * 0.82) * (0.012 + u.mid * 0.012);
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
		let phase = fi * 6.2831853 + u.paletteOffset * 6.2831853 + u.journeyPhase * 0.62;
		let laneY = clamp(q.y, -tendrilHalfLength, tendrilHalfLength);
		let yPhase = laneY * (2.1 + tension * 0.8) + phase;
		let radius = 0.30 + growth * 0.32 + sin(laneY * 2.7 + phase) * (0.040 + u.mid * 0.030);
		let lane = vec2<f32>(cos(yPhase), sin(yPhase)) * radius;
		let laneCenter = vec3<f32>(lane.x, laneY, lane.y);
		let d = length(q - laneCenter) - (0.014 + u.mid * 0.022 + u.surfaceImpact * 0.006);
		tendril = min(tendril, d);
	}
	let tendrilEnvelope = length(p) - 1.72;
	tendril = smax(tendril, tendrilEnvelope, 0.055);
	body = smin(body, tendril, 0.052 + tension * 0.025);

	// Cavity carving: restrained negative space inside the creature. Kept small
	// so it creates breathing mouths/pockets without black tile artifacts.
	let c1 = length(q - vec3<f32>(sin(u.journeyPhase * 0.55) * 0.20, 0.05 + growth * 0.12, cos(u.journeyPhase * 0.47) * 0.18))
		- (0.075 + u.bass * 0.035 + tension * 0.020);
	let c2 = length(q - vec3<f32>(-0.26, -0.18 + sin(u.journeyPhase * 0.68) * 0.08, 0.22))
		- (0.065 + growth * 0.030);
	body = max(body, -min(c1, c2));

	// High-frequency surface life from treble, tiny enough not to destabilize the
	// marcher but enough that hats/percussion make the skin crawl.
	let ripple = (
		sin(q.x * 16.0 + u.journeyPhase * 4.2) +
		sin(q.y * 19.0 - u.journeyPhase * 3.6) +
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

// Hash primitive used by the single-sample atmospheric current warp.
fn h31(p: vec3<f32>) -> f32 {
	var q = fract(p * vec3<f32>(443.897, 441.423, 437.195));
	q = q + dot(q, q.yzx + 19.19);
	return fract((q.x + q.y) * q.z);
}

// 3D value noise — one sample gives the world-space current a soft, organic
// bend without another raymarch, texture, or stacked fullscreen layer.
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

// One coherent world-space atmospheric current. It is sampled at a distant
// point along the camera ray, so camera translation creates real parallax
// instead of sliding a screen-space texture over the hero. Growth/tension and
// the slow audio rails continuously reshape the same field; there are no stars,
// sprites, flashes, or independent visual layers competing with the organism.
fn sky(rd: vec3<f32>) -> vec3<f32> {
	let upT = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
	let baseT = u.paletteOffset;
	let growth = clamp(u._pad0, 0.0, 1.0);
	let tension = clamp(u._pad1, 0.0, 1.0);
	let horizon = palette7(baseT) * (0.042 + growth * 0.012);
	let zenith = palette7(baseT + 0.70) * 0.010;
	var bg = mix(horizon, zenith, smoothstep(0.0, 1.0, upT));

	let camPos = vec3<f32>(u.camPosX, u.camPosY, u.camPosZ);
	let camFwd = safeNormalize(
		vec3<f32>(u.camFwdX, u.camFwdY, u.camFwdZ),
		vec3<f32>(0.0, 0.0, -1.0)
	);
	let worldP = camPos + rd * 8.0;
	let familyPhase = u.paletteFamily * 1.04719755 + baseT * 1.7;
	let currentAxis = safeNormalize(
		vec3<f32>(cos(familyPhase), 0.22 + tension * 0.16, sin(familyPhase)),
		vec3<f32>(0.7, 0.25, 0.6)
	);
	let sideAxis = safeNormalize(
		cross(currentAxis, vec3<f32>(0.0, 1.0, 0.0)),
		vec3<f32>(1.0, 0.0, 0.0)
	);
	let liftAxis = safeNormalize(cross(sideAxis, currentAxis), vec3<f32>(0.0, 1.0, 0.0));
	let along = dot(worldP, currentAxis);
	let across = dot(worldP, sideAxis);
	let lift = dot(worldP, liftAxis);

	// The CPU integrates this phase from the shared song journey. Mids/tension
	// bend the current, while bass/growth change its body; no transient rail
	// touches background luminance.
	let flowPhase = u.backgroundPhase + familyPhase;
	let warpP = worldP * 0.24 + currentAxis * flowPhase * 0.20;
	let warp = vn3(warpP) - 0.5;
	let bend = sin(along * 0.54 + flowPhase + warp * 2.0) * (0.30 + u.mid * 0.16)
		+ sin(lift * 0.31 - flowPhase * 0.47 + familyPhase) * (0.10 + tension * 0.10);
	let currentCoord = across * 0.30 + bend;
	let currentWidth = 0.50 + u.bass * 0.08 + growth * 0.07 + u.openness * 0.06
		- tension * 0.16 - u.suspense * 0.08;
	let normalizedDistance = currentCoord / max(currentWidth, 0.20);
	let currentBody = exp(-normalizedDistance * normalizedDistance);
	let filament = 0.72 + 0.28 * (0.5 + 0.5 * sin(along * 1.63 - flowPhase * 0.61 + warp * 2.4));
	let current = currentBody * filament;
	let currentCol = mix(
		palette7(baseT + 0.28 + warp * 0.05),
		palette7(baseT + 0.55),
		clamp(0.35 + tension * 0.35 + upT * 0.15, 0.0, 1.0)
	);
	bg = bg + currentCol * current * (0.036 + u.rms * 0.030 + growth * 0.030);

	// Preserve a quiet pocket behind the subject. The current remains visible at
	// the periphery and through negative-space openings without becoming a halo.
	let heroFocus = pow(clamp(dot(rd, camFwd), 0.0, 1.0), 18.0);
	bg = bg * (1.0 - heroFocus * (0.22 + tension * 0.06));

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
	let rd = normalize(uv.x * right + uv.y * up + fwd * u.fovScale);

	// The circular key vector directly steers the light without atan2 wrap.
	let cChroma = u.chromaX;
	let sChroma = u.chromaY;
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
			let rim = rimTint * cosNR * rimFresnel * (0.65 + u.openness * 0.34);

			let direct = keyTint * cosNL * shadow;
			let fill = fillTint * cosNF * 0.45;
			let ambient = fillTint * (0.32 + n.y * 0.30);
			let diffuse = baseCol * (direct + fill + ambient) * ao * detailShade;
			let specularCol = irid * (specular * 1.4 + fresnel * 0.5) * shadow + rim;
			let surfQ = organismWarp(p);
			let vein = pow(
				0.5 + 0.5 * sin(surfQ.x * 17.0 + surfQ.y * 11.0 - surfQ.z * 9.0 + u.journeyPhase * 5.2),
				7.0
			);
			let pulseVein = vein * (0.10 + u.mid * 0.16 + u.treble * 0.08) + u.flash * 0.055;
			let emission = palette7(u.paletteOffset + 0.22) * pulseVein * (0.65 + u.rms);

			// Impact is a restrained surface highlight. No expanding screen-space
			// ring and no geometry-wide onset reset are layered over the organism.
			let impactMask = pow(vein, 3.0) * u.surfaceImpact;
			let impactCol = palette7(u.paletteOffset + 0.45) * impactMask * 0.38;

			let surfaceCol = diffuse + specularCol + emission + impactCol;
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

	// Composite remaining transmittance with the current field. An explicit
	// branch lets opaque hero pixels skip all background noise/math.
	var col = scattered;
	if (transmittance > 0.001) {
		col = col + sky(rd) * transmittance;
	}

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
	surfaceImpact: f32,
	openness: f32,
	journeyPhase: f32,
	backgroundPhase: f32,
	postureYaw: f32,
	posturePitch: f32,
	suspense: f32,
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
	// Present pass — tone-map + restrained chromatic aberration + stable dither.
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
	surfaceImpact: f32,
	openness: f32,
	journeyPhase: f32,
	backgroundPhase: f32,
	postureYaw: f32,
	posturePitch: f32,
	suspense: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var compositeTex: texture_2d<f32>;

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

// IGN — Jorge Jimenez interleaved gradient noise, used only as stable
// pre-quantization dither. It no longer changes every frame like film static.
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
	let caAmt = 0.0010 + r2 * 0.005;
	let dir = normalize(centered + vec2<f32>(1e-4, 1e-4));
	let r = textureSample(compositeTex, samp, uv + dir * caAmt).r;
	let g = textureSample(compositeTex, samp, uv).g;
	let b = textureSample(compositeTex, samp, uv - dir * caAmt).b;
	var col = vec3<f32>(r, g, b);

	// Anamorphic lens streaks — three paired samples keep the cinematic accent
	// with substantially less full-resolution texture bandwidth. A high threshold
	// (1.10 vs 0.55) so only TRUE highlights streak. Old version was picking
	// up ambient glow in older builds, producing the "white ash" the user
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
	col = col + streak * vec3<f32>(0.20, 0.38, 0.52) * (0.28 + u.openness * 0.12);

	col = agx(col);
	// Black-point lift + micro-contrast so the deep volumetric blacks don't
	// read as flat. AgX is gentler than ACES so blacks need a little help.
	col = max(col - vec3<f32>(0.018), vec3<f32>(0.0));
	col = pow(col, vec3<f32>(1.06));

	// Pre-quantization dither — kills 8-bit banding in volumetric gradients.
	col = col + vec3<f32>((ign(frag.xy + vec2<f32>(33.0, 71.0)) - 0.5) / 255.0);

	return vec4<f32>(col, 1.0);
}
`;

	// Bloom param uniform layout — 8 f32s = 32 bytes (×3 mips, down + up).
	const BLOOM_PARAM_FLOATS = 8;
	const BLOOM_PARAM_BYTES = BLOOM_PARAM_FLOATS * 4;
	const BLOOM_LEVELS = 3;

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
		// Spectrum storage sampled directly by the raymarched surface.
		binsBuf: GPUBuffer;
		binsData: Float32Array;
		pipelines: {
			scene: GPURenderPipeline;
			bloomDown: GPURenderPipeline;
			bloomUp: GPURenderPipeline;
			composite: GPURenderPipeline;
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
			width: number;
			height: number;
		} | null;
		bindGroups: {
			scene: GPUBindGroup;
			composite: [GPUBindGroup, GPUBindGroup];
			present: [GPUBindGroup, GPUBindGroup];
			bloomDownBGs: GPUBindGroup[];
			bloomUpBGs: GPUBindGroup[];
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
		return {
			scene,
			sceneView: scene.createView(),
			bloomMips,
			bloomViews,
			bloomSizes,
			compositeAB: [cA, cB] as [GPUTexture, GPUTexture],
			compositeViewsAB: [cA.createView(), cB.createView()] as [GPUTextureView, GPUTextureView],
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
		// Present has 2 bind groups so it can read the current composite ping-pong
		// slot without any separate screen-space overlay textures.
		const present: [GPUBindGroup, GPUBindGroup] = [0, 1].map((i) =>
			device.createBindGroup({
				layout: pipelines.present.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: uniformBuf } },
					{ binding: 1, resource: sampler },
					{ binding: 2, resource: targets.compositeViewsAB[i] }
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
		return { scene, composite, present, bloomDownBGs, bloomUpBGs };
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

		// Spectrum storage remains part of the scene pipeline: the raymarched
		// surface maps vertical regions to individual FFT bins.
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

		// Bind the current source epoch before preserving or recreating temporal
		// targets. A track switch must never present one frame of the previous
		// source's composite history.
		const time = (performance.now() - t0) / 1000;
		const feat = vis.getLatest(frameNow);
		const shared = vis.getJourney(frameNow);
		syncRendererToJourney(shared);
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

		const directed = shared.director;
		const spectrum = shared.spectrum;
		const signalJourney = shared.signal;
		const journey = shared.mk2;
		currentSection = directed.section;

		// Time-correct renderer-side polish. The musical controller already owns
		// the longer envelopes; this final smoothing only keeps GPU uniforms calm.
		const frameScale = frameDt * 60;
		const alpha = (at60Hz: number) => 1 - Math.pow(1 - at60Hz, frameScale);
		const chromaAngle = signalJourney.key * Math.PI * 2;
		if (rendererSyncRequested) {
			smoothed.bass = spectrum.bass;
			smoothed.mid = spectrum.mid;
			smoothed.treble = spectrum.treble;
			smoothed.centroidSlow = spectrum.centroid;
			smoothed.rmsSlow = journey.macroEnergy;
			smoothed.bpmNormSlow = signalJourney.tempo;
			smoothed.flash = 0;
			smoothed.staccato = 0;
			smoothed.sustain = journey.openness;
			smoothed.chromaXSlow = Math.cos(chromaAngle);
			smoothed.chromaYSlow = Math.sin(chromaAngle);
			rendererSyncRequested = false;
		} else {
			smoothed.bass = lerp(smoothed.bass, spectrum.bass, alpha(0.12));
			smoothed.mid = lerp(smoothed.mid, spectrum.mid, alpha(0.09));
			smoothed.treble = lerp(smoothed.treble, spectrum.treble, alpha(0.15));
			smoothed.centroidSlow = lerp(smoothed.centroidSlow, spectrum.centroid, alpha(0.025));
			smoothed.rmsSlow = lerp(smoothed.rmsSlow, journey.macroEnergy, alpha(0.035));
			smoothed.bpmNormSlow = lerp(smoothed.bpmNormSlow, signalJourney.tempo, alpha(0.02));
			smoothed.flash = lerp(smoothed.flash, journey.impact, alpha(0.32));
			smoothed.staccato = lerp(smoothed.staccato, journey.impact, alpha(0.38));
			smoothed.sustain = lerp(smoothed.sustain, journey.openness, alpha(0.035));
			smoothed.chromaXSlow = lerp(smoothed.chromaXSlow, Math.cos(chromaAngle), alpha(0.025));
			smoothed.chromaYSlow = lerp(smoothed.chromaYSlow, Math.sin(chromaAngle), alpha(0.025));
		}

		const growth = journey.growth;
		const tension = journey.tension;
		const mandelbulbPower = Math.max(
			5.9,
			Math.min(8.8, 7.15 + journey.topologyBias + smoothed.mid * 0.12)
		);
		const baseHue = directed.palette.baseHue;
		const hueDelta = ((directed.palette.accentHue - baseHue + 1.5) % 1) - 0.5;
		const tonnetzBlend = mk2ContinuousPaletteBlend(signalJourney.spectrumTravel);
		const paletteOffset =
			baseHue + hueDelta * tonnetzBlend + (smoothed.centroidSlow - 0.5) * 0.055;
		const fogDensity = journey.fogDensity;
		const lightShaftIntensity = journey.shaftIntensity;
		const fovScale = 1.54 + mk2SongSeed * 0.12;

		// The camera follows a continuous path at the conductor's physical rate.
		// Harmony can gently reframe the target, but phrases and drops never add
		// accumulated offsets and impacts never shake the camera.
		const sessionTargetY = -0.05 + (mk2SongSeed - 0.5) * 0.1;
		const sessionRoll = (mk2SongSeed - 0.5) * 0.14;
		const camPosRaw = getCameraPos(journey.cameraPhase, journey.postureYaw * 0.2);
		const camPos: [number, number, number] = [
			camPosRaw[0] * journey.cameraDistance,
			camPosRaw[1] * journey.cameraDistance,
			camPosRaw[2] * journey.cameraDistance
		];
		const targetY = CAM_MODE === 2
			? -0.35
			: sessionTargetY + journey.posturePitch * 0.8;
		const camTarget: [number, number, number] = [journey.postureYaw * 0.7, targetY, 0];
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
		u[12] = Math.max(feat?.chroma_strength ?? 0, directed.context.keyConfidence);
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
		u[33] = smoothed.staccato;
		u[34] = smoothed.sustain;
		u[35] = journey.rotationPhase;
		u[36] = journey.backgroundFlowPhase;
		u[37] = journey.postureYaw;
		u[38] = journey.posturePitch;
		u[39] = journey.suspense;
		gpu.device.queue.writeBuffer(gpu.uniformBuf, 0, u.buffer, u.byteOffset, u.byteLength);

		// Upload decoded, baseline-relative detail. Static hiss and compressed
		// display-bin floor no longer shimmer across the entire surface.
		gpu.binsData.set(spectrum.detailBins);
		gpu.device.queue.writeBuffer(
			gpu.binsBuf,
			0,
			gpu.binsData.buffer,
			gpu.binsData.byteOffset,
			gpu.binsData.byteLength
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

		// Present (tone-map + restrained CA + stable dither) → swap chain
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
			aria-label="Mk2 audio visualizer"
			data-mk2-section={currentSection}
			data-mk2-render-passes="8"
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
				section: <strong>{currentSection}</strong>
			</div>
		{/if}
		{#if errorMsg}
			<div class="pointer-events-none absolute left-6 top-16 z-30 max-w-md text-xs text-red-300/80">
				Visualizer error: {errorMsg}
			</div>
		{/if}
	</div>
{/if}
