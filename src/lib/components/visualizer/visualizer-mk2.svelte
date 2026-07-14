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
	//   • One continuous seeded camera drift with no knots, segment resets, or
	//     short advertised loop. The organism remains the subject, not the camera.
	//   • Photographic 7-stop palette interpolated smoothly — golden hour /
	//     dusk / deep space stops, never cosine RGB.
	//   • AgX filmic tone map + stable dither for a clean post-processing
	//     signature without pasted-on lens overlays.
	//
	// Audio routing (multiple timescales):
	//   • sub/kick            → localized root mass and rooted punch
	//   • body/mids           → axial growth, lobe splitting, winding and folds
	//   • presence/air        → ridges, filaments, erosion and surface emission
	//   • spectral direction  → signed anatomical lean and travelling deformation
	//   • section/phrase      → seed → sprout → winding → bloom → shedding → dormancy
	//   • harmony/key         → continuous palette and material development
	//   • bpmNorm (slow)     → camera traversal speed multiplier
	//   • rms (slow)         → light shaft intensity
	//   • onset (impulse)    → restrained root/surface impact only
	//
	// Future iterations: optional quality tiers, real circle-of-confusion DOF,
	// Mandelbox / hybrid IFS variants per song seed.

	import { onMount, onDestroy } from 'svelte';
	import {
		VISUALIZER_RESPONSE_PROFILES,
		useVisualizer,
		type VisualizerJourneySnapshot
	} from '$lib/state/visualizer.svelte';
	import { mk2ContinuousPaletteBlend } from '$lib/visualizer/mk2/conductor';

	const vis = useVisualizer();
	const t0 = performance.now();

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
	// slower rails. Only root punch and a restrained surface impact react quickly.
	let temporalResetRequested = true;
	let currentSection = $state('intro');
	let currentForm = $state('seed');

	function dominantLifecycleForm(journey: VisualizerJourneySnapshot['mk2']): string {
		const forms = [
			['seed', journey.seedForm],
			['sprout', journey.sproutForm],
			['winding', journey.windingForm],
			['bloom', journey.bloomForm],
			['shedding', journey.sheddingForm],
			['dormancy', journey.dormancyForm]
		] as const;
		let dominant: (typeof forms)[number] = forms[0];
		for (const form of forms) if (form[1] > dominant[1]) dominant = form;
		return dominant[0];
	}

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
		sustain: 0,
		responseMotion: 1,
		responseImpact: 1,
		responseFog: 1,
		responseShafts: 1
	};

	function lerp(a: number, b: number, t: number) {
		return a + (b - a) * t;
	}

	// ──────────────────────────────────────────────────────────────────────────
	// One continuous, non-resetting camera drift. The former authored waypoint
	// loop eased to a full stop at every knot, which made the organism appear to
	// twitch backwards even while its own rotation phase stayed continuous.
	// Irrationally-related drift rates keep this path from advertising a short
	// repeated loop during a song.
	// ──────────────────────────────────────────────────────────────────────────
	function getCameraPos(
		cameraPhase: number,
		perspectiveAzimuth: number,
		perspectiveElevation: number
	): [number, number, number] {
		const seedAngle = mk2SongSeed * Math.PI * 2;
		const azimuth =
			seedAngle + cameraPhase * (0.56 + mk2SongSeed * 0.08) + perspectiveAzimuth;
		const baseRadius =
			3.45 + Math.sin(cameraPhase * 0.173 + seedAngle * 0.7) * 0.22 +
			Math.sin(cameraPhase * 0.071 - seedAngle) * 0.1;
		const radius = baseRadius * Math.cos(perspectiveElevation * 0.82);
		const sideDrift = Math.sin(cameraPhase * 0.119 + seedAngle * 1.3) * 0.18;
		return [
			Math.cos(azimuth) * radius + Math.cos(azimuth * 0.37 + seedAngle) * sideDrift,
			1.25 +
				Math.sin(cameraPhase * 0.227 + seedAngle * 0.4) * 0.58 +
				Math.sin(perspectiveElevation) * baseRadius * 0.86,
			Math.sin(azimuth) * radius + Math.sin(azimuth * 0.41 - seedAngle) * sideDrift
		];
	}

	function syncRendererToJourney(snapshot: VisualizerJourneySnapshot) {
		if (snapshot.sourceEpoch === rendererSourceEpoch) return;
		rendererSourceEpoch = snapshot.sourceEpoch;
		mk2SongSeed = snapshot.seed;
		currentSection = snapshot.director.section;
		rendererSyncRequested = true;
		temporalResetRequested = true;
		resetFrameScheduler();
	}

	// ──────────────────────────────────────────────────────────────────────────
	// Uniform layout — 72 f32s = 288 bytes (multiple of 16 ✓)
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
	// 40-45 lifecycle form weights: seed / sprout / winding / bloom / shedding / dormancy
	// 46-47 unwrapped morph phase / rate
	// 48-55 root mass / root pulse / axial stretch / lobe split / folds / cavity / ridges / filaments
	// 56-58 signed spectral lean / unwrapped spectral travel / travel rate
	// 59-63 palette phase / warmth / density / iridescence / erosion
	// 64-70 shot zoom / close study / detail / azimuth / elevation / framing x/y
	// 71    padding
	const UNIFORM_FLOATS = 72;
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
	seedForm: f32,
	sproutForm: f32,
	windingForm: f32,
	bloomForm: f32,
	sheddingForm: f32,
	dormancyForm: f32,
	morphPhase: f32,
	morphRate: f32,
	rootMass: f32,
	rootPulse: f32,
	axialStretch: f32,
	lobeSplit: f32,
	foldDepth: f32,
	cavityOpen: f32,
	surfaceRidges: f32,
	filamentReach: f32,
	spectralLean: f32,
	spectralTravelPhase: f32,
	spectralTravelRate: f32,
	palettePhase: f32,
	paletteWarmth: f32,
	materialDensity: f32,
	materialIridescence: f32,
	materialErosion: f32,
	shotZoom: f32,
	closeStudy: f32,
	detailFocus: f32,
	perspectiveAzimuth: f32,
	perspectiveElevation: f32,
	shotFramingX: f32,
	shotFramingY: f32,
	_shotPad: f32,
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
	if (!(lenV > 1e-5 && lenV < 1e10)) {
		return fallback;
	}
	return v / lenV;
}

fn sdCapsule(p: vec3<f32>, a: vec3<f32>, b: vec3<f32>, radius: f32) -> f32 {
	let pa = p - a;
	let ba = b - a;
	let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
	return length(pa - ba * h) - radius;
}

fn sdEllipsoid(p: vec3<f32>, radii: vec3<f32>) -> f32 {
	let safeRadii = max(radii, vec3<f32>(0.025));
	let k0 = length(p / safeRadii);
	let k1 = max(length(p / (safeRadii * safeRadii)), 1e-5);
	return k0 * (k0 - 1.0) / k1;
}

fn sproutDirection(i: i32) -> vec3<f32> {
	if (i == 0) { return safeNormalize(vec3<f32>(0.48, 0.86, 0.12), vec3<f32>(0.0, 1.0, 0.0)); }
	if (i == 1) { return safeNormalize(vec3<f32>(-0.72, 0.52, 0.34), vec3<f32>(-1.0, 0.0, 0.0)); }
	if (i == 2) { return safeNormalize(vec3<f32>(0.30, -0.12, 0.94), vec3<f32>(0.0, 0.0, 1.0)); }
	return safeNormalize(vec3<f32>(-0.24, -0.34, -0.91), vec3<f32>(0.0, 0.0, -1.0));
}

fn windingDirection(i: i32) -> vec3<f32> {
	if (i == 0) { return safeNormalize(vec3<f32>(0.30, 0.94, 0.16), vec3<f32>(0.0, 1.0, 0.0)); }
	if (i == 1) { return safeNormalize(vec3<f32>(-0.34, 0.88, -0.32), vec3<f32>(0.0, 1.0, 0.0)); }
	if (i == 2) { return safeNormalize(vec3<f32>(0.42, -0.74, 0.52), vec3<f32>(0.0, -1.0, 0.0)); }
	return safeNormalize(vec3<f32>(-0.48, -0.72, -0.50), vec3<f32>(0.0, -1.0, 0.0));
}

fn bloomDirection(i: i32) -> vec3<f32> {
	if (i == 0) { return safeNormalize(vec3<f32>(0.94, 0.25, 0.12), vec3<f32>(1.0, 0.0, 0.0)); }
	if (i == 1) { return safeNormalize(vec3<f32>(-0.86, 0.20, 0.46), vec3<f32>(-1.0, 0.0, 0.0)); }
	if (i == 2) { return safeNormalize(vec3<f32>(0.08, 0.58, 0.81), vec3<f32>(0.0, 0.0, 1.0)); }
	return safeNormalize(vec3<f32>(0.18, -0.78, -0.60), vec3<f32>(0.0, -1.0, 0.0));
}

fn organismWarp(p: vec3<f32>) -> vec3<f32> {
	let growth = u._pad0;
	let tension = u._pad1;
	let openness = clamp(u.openness, 0.0, 1.0);
	// Whole-body breathing is deliberately restrained. Sub and kick now own a
	// localized root mass below, instead of scaling the same orb every beat.
	let breath = 1.0
		+ growth * 0.045
		+ openness * 0.028
		+ u.surfaceImpact * 0.008
		+ u.bloomForm * 0.045
		- u.seedForm * 0.035
		- u.dormancyForm * 0.085;
	var q = p / breath;

	// Rotation is now a secondary, multi-minute drift. Phrase posture only bends
	// the anatomy; it no longer rotates the body and camera in opposite directions.
	let globalYaw = u.journeyPhase * 0.52 + u.postureYaw * 0.30
		+ sin(u.morphPhase * 0.37) * 0.055;
	let yawed = rot2(q.xz, globalYaw);
	q.x = yawed.x;
	q.z = yawed.y;
	let pitched = rot2(q.yz, u.posturePitch * 0.55);
	q.y = pitched.x;
	q.z = pitched.y;

	// Morph phase never wraps or resets. Its low physical rate produces long,
	// coherent development rather than a short canned wobble.
	let tSlow = u.morphPhase + u.spectralTravelPhase * 0.22;
	let drift = vec3<f32>(
		sin(q.y * 1.05 + tSlow) * 0.045 + cos(q.z * 0.73 - tSlow * 0.61) * 0.030,
		sin(q.x * 0.82 - tSlow * 0.43) * 0.032,
		cos(q.x * 0.92 + tSlow * 0.79) * 0.045 + sin(q.y * 0.71 + tSlow * 0.53) * 0.030
	);
	q = q + drift * (0.32 + growth * 0.28 + u.sproutForm * 0.22 + u.sheddingForm * 0.18);

	// Body/mids own large silhouette changes: long sprout, wound build, wide
	// bloom, and contracted dormancy are genuinely different coordinate fields.
	let stretchY = max(0.52,
		0.82 + u.axialStretch * 0.70 + u.sproutForm * 0.14 + u.windingForm * 0.08
		- u.bloomForm * 0.14 - u.dormancyForm * 0.28);
	let stretchX = max(0.64,
		0.80 + u.lobeSplit * 0.34 + u.bloomForm * 0.28 + u.dormancyForm * 0.12);
	let stretchZ = max(0.64,
		0.82 + u.lobeSplit * 0.27 + u.bloomForm * 0.20 + u.rootMass * 0.08
		+ u.dormancyForm * 0.14);
	q.x = q.x / stretchX;
	q.y = q.y / stretchY;
	q.z = q.z / stretchZ;

	// Sprout grows as one visibly biased shoot instead of a uniformly stretched
	// orb. Winding then pulls the cross-section inward before applying its twist;
	// bloom releases that stored pressure laterally, while dormancy settles flat.
	let sproutBend = u.sproutForm * (0.08 + u.axialStretch * 0.08);
	q.x = q.x - sin(q.y * 1.18 + tSlow * 0.23) * sproutBend
		- q.y * q.y * u.sproutForm * 0.045;
	let windingCompression = 1.0 + u.windingForm * (0.10 + u.foldDepth * 0.18);
	q.x = q.x * windingCompression;
	q.z = q.z * windingCompression;

	// Signed filter motion leans the organism through space instead of changing a
	// fullscreen overlay. Root energy expands only the lower anatomy.
	q.x = q.x - q.y * u.spectralLean * (0.10 + u.axialStretch * 0.13);
	let rootZone = 1.0 - smoothstep(-0.58, 0.34, q.y);
	let rootExpansion = 1.0 + rootZone * (u.rootMass * 0.18 + u.rootPulse * 0.11);
	q.x = q.x / rootExpansion;
	q.z = q.z / rootExpansion;

	// Use the circular key vector directly. Unlike atan2(), these controls remain
	// continuous when pitch class crosses the 0/1 boundary.
	let chromaPull = clamp(u.chromaStrength, 0.0, 1.0);
	let chromaTilt = u.chromaY * chromaPull * 0.055;
	let rChroma = rot2(q.xy, chromaTilt);
	q.x = rChroma.x;
	q.y = rChroma.y;

	// Builds physically wind inward; mids determine fold depth. Bloom releases
	// that stored twist into separated lobes rather than a uniform scale pulse.
	let twist = q.y * (0.20 + tension * 0.38 + u.windingForm * 1.18 + u.foldDepth * 0.72)
		+ sin(q.z * 1.52 + tSlow * 1.09) * (0.045 + u.foldDepth * 0.16)
		+ u.chromaX * chromaPull * 0.045;
	let rxz = rot2(q.xz, twist);
	q.x = rxz.x;
	q.z = rxz.y;
	let rxy = rot2(q.xy, sin(q.z * 0.96 + tSlow * 0.67) * (0.035 + u.foldDepth * 0.14));
	q.x = rxy.x;
	q.y = rxy.y;
	q.y = q.y + sin(q.x * 1.75 + tSlow * 0.59) * (0.022 + u.foldDepth * 0.075);
	return q;
}

fn map(p: vec3<f32>) -> f32 {
	let growth = u._pad0;
	let tension = u._pad1;
	// Cheap conservative scene bound. All lifecycle appendages and shed fragments
	// remain within this envelope, so empty screen rays avoid the fractal entirely.
	let outerBound = length(p) - 1.95;
	if (outerBound > 0.35) {
		return outerBound * 0.76;
	}
	let q = organismWarp(p);

	// A single expensive Mandelbulb remains the organic heart. Intro/outro blend
	// toward a waxy cocoon; active sections reveal the fractal continuously.
	let cocoonRadii = vec3<f32>(
		0.60 + u.rootMass * 0.08 + u.bloomForm * 0.12 + u.dormancyForm * 0.10,
		0.68 + u.axialStretch * 0.18 + u.sproutForm * 0.12 - u.dormancyForm * 0.14,
		0.58 + u.lobeSplit * 0.12 + u.bloomForm * 0.10 + u.dormancyForm * 0.12
	);
	let cocoon = sdEllipsoid(q, cocoonRadii);
	// A lifecycle-owned core scale keeps the expensive fractal itself from reading
	// as the same ball in every section. Larger coordinate scale means a smaller,
	// denser core; bloom deliberately moves in the opposite direction.
	let bodyScale = 1.04 + growth * 0.025 + u.seedForm * 0.12
		+ u.windingForm * 0.08 + u.sheddingForm * 0.04 + u.dormancyForm * 0.18
		- u.sproutForm * 0.04 - u.bloomForm * 0.12;
	// Macro studies earn extra true fractal iterations. Both gates are uniform
	// across the frame and require an elected close study, so an intricate normal
	// hero shot never pays the macro cost by accident.
	var fractalIterations = 6;
	if (u.closeStudy > 0.55 && u.detailFocus > 0.58) { fractalIterations = 7; }
	if (u.closeStudy > 0.84 && u.detailFocus > 0.90) { fractalIterations = 8; }
	let fractal = mandelbulbDE(
		q * bodyScale,
		u.mandelbulbPower + tension * 0.28 + u.foldDepth * 0.24 - u.bloomForm * 0.16,
		fractalIterations
	) * (1.01 - growth * 0.045);
	let fractalReveal = clamp(
		0.24 + u.sproutForm * 0.44 + u.windingForm * 0.62 + u.bloomForm * 0.76
		+ u.sheddingForm * 0.50 - u.seedForm * 0.08 - u.dormancyForm * 0.12,
		0.14,
		1.0
	);
	var body = mix(cocoon, fractal, fractalReveal);

	// Sub energy grows a rooted lower lobe. This is spatially localized, so a
	// kick reads as weight entering the organism rather than a fullscreen pulse.
	let rootCenter = vec3<f32>(u.spectralLean * 0.08, -0.48, 0.02);
	let rootLobe = sdEllipsoid(
		q - rootCenter,
		vec3<f32>(
			0.31 + u.rootMass * 0.20 + u.rootPulse * 0.08,
			0.25 + u.rootMass * 0.13 + u.rootPulse * 0.04,
			0.30 + u.rootMass * 0.18 + u.rootPulse * 0.07
		)
	);
	body = smin(body, rootLobe, 0.085 + u.rootMass * 0.035);

	// Four thick anatomical limbs replace the old hair-thin helixes that lived
	// inside the core. Their directions, reach, buds, and visibility crossfade
	// from asymmetric sprout to wound cocoon to open bloom.
	for (var i: i32 = 0; i < 4; i = i + 1) {
		var sproutGate = 0.04;
		var windingGate = 0.50;
		var bloomGate = 0.88;
		var lanePolarity = -1.0;
		if (i == 0) {
			sproutGate = 1.0;
			windingGate = 0.82;
			bloomGate = 1.0;
			lanePolarity = 1.0;
		} else if (i == 1) {
			sproutGate = 0.48;
			windingGate = 0.74;
			bloomGate = 0.96;
		} else if (i == 2) {
			sproutGate = 0.12;
			windingGate = 0.58;
			bloomGate = 0.92;
			lanePolarity = 1.0;
		}

		let activeForms = max(u.sproutForm + u.windingForm + u.bloomForm, 1e-4);
		let bloomMix = clamp(u.bloomForm / activeForms, 0.0, 1.0);
		let windingMix = clamp(u.windingForm / activeForms, 0.0, 1.0);
		var direction = safeNormalize(
			mix(sproutDirection(i), bloomDirection(i), bloomMix),
			sproutDirection(i)
		);
		direction = safeNormalize(
			mix(direction, windingDirection(i), windingMix * 0.82),
			direction
		);
		let travelTurn = u.morphPhase * (0.26 + f32(i) * 0.025)
			+ u.spectralTravelPhase * (0.18 + f32(i) * 0.035) * lanePolarity;
		let turned = rot2(direction.xz, travelTurn);
		direction.x = turned.x;
		direction.z = turned.y;
		direction.x = direction.x + u.spectralLean * (0.10 + f32(i) * 0.018) * lanePolarity;
		direction = safeNormalize(direction, sproutDirection(i));

		let presence = clamp(
			u.sproutForm * sproutGate + u.windingForm * windingGate
			+ u.bloomForm * bloomGate + u.sheddingForm * 0.14,
			0.0,
			1.0
		);
		let laneVariation = 0.90 + f32(i) * 0.055 + lanePolarity * u.spectralLean * 0.08;
		let reach = (
			0.52 + u.axialStretch * 0.28 + u.lobeSplit * 0.38
			+ u.bloomForm * 0.42 + u.filamentReach * 0.14 - u.windingForm * 0.12
		) * laneVariation;
		let a = direction * (0.14 + u.windingForm * 0.13);
		var b = direction * reach;
		b.y = b.y + sin(u.morphPhase * 0.73 + f32(i) * 1.9) * (0.025 + u.foldDepth * 0.07);
		b.x = b.x + u.spectralLean * lanePolarity * (0.035 + u.lobeSplit * 0.055);
		let branchRadius = 0.070 + u.rootMass * 0.030 + u.lobeSplit * 0.070
			+ u.bloomForm * 0.075 + u.filamentReach * 0.025;
		let branch = sdCapsule(q, a, b, branchRadius);
		let budRadius = 0.100 + u.lobeSplit * 0.100 + u.bloomForm * 0.140
			+ u.rootPulse * 0.018;
		let bud = sdEllipsoid(
			q - b,
			vec3<f32>(budRadius * (1.12 + u.lobeSplit * 0.18), budRadius * 0.86, budRadius)
		);
		let appendage = min(branch, bud) + (1.0 - presence) * 0.34;
		body = smin(body, appendage, 0.050 + presence * 0.060);
	}

	// Bridge/breakdown opens a real exterior-intersecting tunnel. Unlike the old
	// tiny internal spheres, this negative space reaches the silhouette from most
	// camera angles and makes shedding unmistakably different from bloom.
	var cavityQ = q;
	let cavityTurn = u.morphPhase * 0.31 + u.spectralLean * 0.36;
	let cavityYZ = rot2(cavityQ.yz, cavityTurn);
	cavityQ.y = cavityYZ.x;
	cavityQ.z = cavityYZ.y;
	let tunnel = sdCapsule(
		cavityQ,
		vec3<f32>(-1.35, 0.0, 0.0),
		vec3<f32>(1.35, 0.0, 0.0),
		0.070 + u.cavityOpen * 0.38
	);
	let cavityGate = smoothstep(0.08, 0.74, u.cavityOpen);
	body = smax(body, -tunnel - (1.0 - cavityGate) * 0.46, 0.052);
	let pocket = length(cavityQ - vec3<f32>(0.34, 0.29, 0.18))
		- (0.11 + u.cavityOpen * 0.21);
	body = smax(body, -pocket - (1.0 - u.sheddingForm) * 0.36, 0.044);

	// Two coherent shed fragments drift away during bridge/breakdown. They remain
	// part of this one world-space SDF—no translucent texture layer is involved.
	let shedGate = clamp(u.sheddingForm * 1.18, 0.0, 1.0);
	let fragmentDrift = 0.72 + shedGate * 0.43;
	let fragmentAOffset = vec3<f32>(
		fragmentDrift + sin(u.morphPhase * 0.61) * 0.12,
		0.30 + shedGate * 0.18 + cos(u.morphPhase * 0.47) * 0.13,
		-0.20 - shedGate * 0.10 + sin(u.morphPhase * 0.39) * 0.10
	);
	let fragmentBOffset = vec3<f32>(
		-fragmentDrift * 0.88 + cos(u.morphPhase * 0.53) * 0.15,
		-0.36 - shedGate * 0.16 + sin(u.morphPhase * 0.43) * 0.12,
		0.43 + shedGate * 0.20 + cos(u.morphPhase * 0.31) * 0.11
	);
	let fragmentRadius = 0.15 + u.filamentReach * 0.060 + u.materialErosion * 0.050;
	let fragmentA = sdEllipsoid(
		q - fragmentAOffset,
		vec3<f32>(fragmentRadius * 1.35, fragmentRadius * 0.78, fragmentRadius)
	);
	let fragmentB = sdEllipsoid(
		q - fragmentBOffset,
		vec3<f32>(fragmentRadius, fragmentRadius * 1.28, fragmentRadius * 0.82)
	);
	let fragments = min(fragmentA, fragmentB) + (1.0 - shedGate) * 0.34;
	body = smin(body, fragments, 0.045 + shedGate * 0.025);

	// True Mandelbulb detail, lifecycle anatomy, and hit-time pore material now
	// provide all fine structure. Removing procedural SDF corrugation prevents
	// bright grazing light from turning tiny ridges into another stripe pattern
	// and saves several trigonometric operations on every map evaluation.
	return body * 0.76;
}

// 4-tap tetrahedral normal estimation.
fn calcNormal(p: vec3<f32>) -> vec3<f32> {
	let macroFocus = clamp(u.closeStudy * u.detailFocus, 0.0, 1.0);
	let normalEpsilon = mix(0.0015, 0.00072, macroFocus);
	let e = vec2<f32>(normalEpsilon, -normalEpsilon);
	let m1 = map(p + e.xyy);
	let m2 = map(p + e.yyx);
	let m3 = map(p + e.yxy);
	let m4 = map(p + e.xxx);
	// Black-square guard — NaN comparisons all return false in WGSL, so a NaN
	// distance fails (x < 1e10) and we fall back to the up vector. Without
	// this, NaN propagates through normal/lighting and produces the tile-
	// shaped black artifacts characteristic of fragment-shader SDF failures.
	let allFinite = (abs(m1) < 1e10) && (abs(m2) < 1e10)
		&& (abs(m3) < 1e10) && (abs(m4) < 1e10);
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
	for (var i: i32 = 0; i < 5; i = i + 1) {
		var h = map(ro + rd * t);
		if (!(abs(h) < 1e10)) { h = 0.5; }
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
	let lifecycleHue = u.sproutForm * 0.035 + u.windingForm * 0.105
		+ u.bloomForm * 0.205 + u.sheddingForm * 0.315 + u.dormancyForm * 0.43;
	let baseT = u.paletteOffset + u.palettePhase * 0.34
		+ u.paletteWarmth * 0.075 + lifecycleHue;
	let growth = clamp(u._pad0, 0.0, 1.0);
	let tension = clamp(u._pad1, 0.0, 1.0);
	let horizon = palette7(baseT) * (
		0.030 + growth * 0.010 + u.bloomForm * 0.012 - u.dormancyForm * 0.009
	);
	let zenith = palette7(baseT + 0.70 + u.materialErosion * 0.08) * 0.008;
	var bg = mix(horizon, zenith, smoothstep(0.0, 1.0, upT));

	let camPos = vec3<f32>(u.camPosX, u.camPosY, u.camPosZ);
	let camFwd = safeNormalize(
		vec3<f32>(u.camFwdX, u.camFwdY, u.camFwdZ),
		vec3<f32>(0.0, 0.0, -1.0)
	);
	let worldP = camPos + rd * 8.0;
	let familyPhase = u.paletteFamily * 1.04719755 + baseT * 1.7
		+ u.spectralTravelPhase * 0.16;
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
	// Suspense accelerates the CPU-integrated phase instead of offsetting it here,
	// so the foreshadowing current can never rewind when anticipation releases.
	let flowPhase = u.backgroundPhase + familyPhase + u.morphPhase * 0.21;
	let warpP = worldP * 0.24 + currentAxis * flowPhase * 0.20;
	let warp = vn3(warpP) - 0.5;
	let bend = sin(along * 0.54 + flowPhase + warp * 2.0) * (0.30 + u.mid * 0.16)
		+ sin(lift * 0.31 - flowPhase * 0.47 + familyPhase) * (0.10 + tension * 0.10);
	let currentCoord = across * 0.30 + bend;
	let currentWidth = 0.32 + u.rootMass * 0.08 + growth * 0.05 + u.openness * 0.05
		+ u.sproutForm * 0.07 + u.bloomForm * 0.24 + u.sheddingForm * 0.10
		+ u.dormancyForm * 0.18 - u.windingForm * 0.15 - tension * 0.10
		- u.suspense * 0.08;
	let normalizedDistance = currentCoord / max(currentWidth, 0.20);
	var currentBody = exp(-normalizedDistance * normalizedDistance);
	// The same atmospheric river divides during bloom and frays during shedding.
	// This is one world-space field, but its arrangement now follows the lifeform.
	let splitAmount = clamp(
		u.bloomForm * 0.98 + u.sheddingForm * 0.68 + u.suspense * 0.30,
		0.0,
		0.92
	);
	let splitOffset = 0.24 + u.lobeSplit * 0.28 + u.filamentReach * 0.12;
	let splitA = (currentCoord - splitOffset) / max(currentWidth * 0.72, 0.16);
	let splitB = (currentCoord + splitOffset) / max(currentWidth * 0.72, 0.16);
	let splitBody = (exp(-splitA * splitA) + exp(-splitB * splitB)) * 0.58;
	currentBody = mix(currentBody, splitBody, splitAmount);
	let filament = 0.72 + 0.28 * (0.5 + 0.5 * sin(along * 1.63 - flowPhase * 0.61 + warp * 2.4));
	let erosionBreaks = mix(
		1.0,
		0.42 + 0.58 * smoothstep(-0.25, 0.55, sin(along * 2.3 + flowPhase * 0.44 + warp * 3.1)),
		clamp(u.materialErosion + u.suspense * 0.10, 0.0, 1.0)
	);
	let current = currentBody * filament * erosionBreaks;
	let currentCol = mix(
		palette7(baseT + 0.28 + warp * 0.05),
		palette7(baseT + 0.55),
		clamp(0.35 + tension * 0.35 + upT * 0.15, 0.0, 1.0)
	);
	let atmosphereTransfer = clamp(
		(1.0 - u.materialDensity) * 0.55 + u.materialErosion * 0.55
			+ u.cavityOpen * 0.22,
		0.0,
		1.0
	);
	bg = bg + currentCol * current * (
		0.023 + u.rms * 0.018 + growth * 0.018 + u.sproutForm * 0.006
			+ u.bloomForm * 0.036 + u.sheddingForm * 0.018
			+ atmosphereTransfer * 0.015 + u.suspense * 0.008
	);

	// Preserve a quiet pocket behind the subject. The current remains visible at
	// the periphery and through negative-space openings without becoming a halo.
	let heroFocus = pow(clamp(dot(rd, camFwd), 0.0, 1.0), 18.0);
	bg = bg * (1.0 - heroFocus * (0.24 + tension * 0.05 + u.dormancyForm * 0.08));

	return bg;
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let res = vec2<f32>(u.resolutionX, u.resolutionY);
	let uv = (frag.xy - 0.5 * res) / res.y;

	// Camera basis from the continuous CPU-side journey.
	let camPos = vec3<f32>(u.camPosX, u.camPosY, u.camPosZ);
	let fwd = vec3<f32>(u.camFwdX, u.camFwdY, u.camFwdZ);
	let right = vec3<f32>(u.camRightX, u.camRightY, u.camRightZ);
	let up = vec3<f32>(u.camUpX, u.camUpY, u.camUpZ);
	let rd = normalize(uv.x * right + uv.y * up + fwd * u.fovScale);

	// Lifecycle-directed lighting rigs. Each form has a different photographic
	// read (soft top light, side light, grazing contrast, back rim, or quiet
	// overhead light), while harmony only nudges the rig instead of spinning it.
	let cChroma = u.chromaX;
	let sChroma = u.chromaY;
	let lifecycleWeight = max(
		u.seedForm + u.sproutForm + u.windingForm + u.bloomForm
			+ u.sheddingForm + u.dormancyForm,
		0.0001
	);
	let lifecycleLight = (
		vec3<f32>(0.12, 0.97, 0.20) * u.seedForm
		+ vec3<f32>(0.78, 0.46, 0.30) * u.sproutForm
		+ vec3<f32>(-0.66, 0.14, 0.74) * u.windingForm
		+ vec3<f32>(-0.48, 0.54, -0.70) * u.bloomForm
		+ vec3<f32>(0.64, -0.12, -0.76) * u.sheddingForm
		+ vec3<f32>(-0.10, 0.98, -0.16) * u.dormancyForm
	) / lifecycleWeight;
	let lightDir = safeNormalize(
		lifecycleLight + vec3<f32>(
			cChroma * 0.08 + sChroma * 0.04,
			0.0,
			cChroma * 0.05 - sChroma * 0.07
		) * u.chromaStrength,
		vec3<f32>(0.25, 0.82, 0.50)
	);

	// ── Volumetric raymarch.
	// At every step we accumulate fog scattering, attenuated by transmittance.
	// If a step hits the surface (distance < EPS) we shade it physically and
	// premultiply the surface contribution by the remaining transmittance,
	// then return — naturally compositing fog over surface over background.
	let MAX_STEPS = 56;
	let MAX_DIST = 10.0;
	let macroFocus = clamp(u.closeStudy * u.detailFocus, 0.0, 1.0);
	let EPS_NEAR = mix(0.0014, 0.00062, macroFocus);
	let EPS_FAR  = mix(0.0070, 0.0036, macroFocus);

	var transmittance = 1.0;
	var scattered = vec3<f32>(0.0);
	var t = 0.05 + dither(frag.xy) * 0.04; // dither breaks fog banding

	for (var i: i32 = 0; i < MAX_STEPS; i = i + 1) {
		if (i >= 48 && (u.closeStudy < 0.55 || u.detailFocus < 0.55)) { break; }
		if (t > MAX_DIST) { break; }
		let p = camPos + rd * t;
		var d = map(p);
		// Black-square guard — if SDF returns NaN/Inf from a degenerate iteration,
		// treat as max distance so the marcher skips and the pixel falls through
		// to sky instead of stamping a NaN tile.
		if (!(abs(d) < 1e10)) { d = 0.5; }
		// Distance-adaptive hit threshold — far surfaces use looser EPS so we
		// don't waste precision; close surfaces tighten so detail reads sharp.
		// Eliminates the "spamming a close-up that's scaled up" degradation.
		let EPS = mix(EPS_NEAR, EPS_FAR, smoothstep(0.5, 6.0, t));

		// ── Surface hit
		if (d < EPS) {
			let geometryNormal = calcNormal(p);
			let view = -rd;
			let shadow = lightVisibility(p + geometryNormal * 0.005, lightDir, 4.0);

			// Two short ambient-occlusion probes preserve crevice depth. The lifecycle
			// primitives are funded by removing the third probe and two shadow steps,
			// rather than adding an unbounded second fractal evaluation.
			var ao = 0.0;
			var aoW = 0.0;
			for (var k: i32 = 1; k <= 2; k = k + 1) {
				let ko = f32(k) * 0.065;
				var aoSample = map(p + geometryNormal * ko);
				if (!(abs(aoSample) < 1e10)) { aoSample = ko; }
				let occ = ko - aoSample;
				ao = ao + occ * pow(0.6, f32(k));
				aoW = aoW + pow(0.6, f32(k));
			}
			ao = clamp(1.0 - ao / aoW * 5.0, 0.0, 1.0);

			// One geometry-bound detail field replaces every projected stripe,
			// triplanar sine, and direct FFT-to-albedo band. It changes material
			// response under real light, never adds an unlit texture over the form.
			let surfQ = organismWarp(p);
			let regionBin = i32(clamp((surfQ.y + 1.90) * 16.58, 0.0, 63.0));
			let bandDetail = clamp(abs(bins[regionBin]), 0.0, 1.0);
			let familyOffset = vec3<f32>(
				u.paletteFamily * 7.13 + 2.7,
				u.paletteFamily * 3.71 + 11.9,
				u.paletteFamily * 5.37 + 19.1
			);
			let surfaceNoise = vn3(
				surfQ * (5.4 + u.materialErosion * 4.8 + u.detailFocus * 3.2)
					+ familyOffset + vec3<f32>(u.morphPhase * 0.012)
			);
			// One hit-time octave gives broad cocoon lobes actual skin. Its spatial
			// scale stays fixed while audio changes contrast/roughness, so pores breathe
			// without crawling or rescaling. This never runs inside the raymarch, SDF
			// normal, shadow, or AO loops.
			let microScale = 19.0;
			let microP = surfQ * microScale + familyOffset * 1.71
				- vec3<f32>(u.morphPhase * 0.019);
			let microNoise = vn3(microP);
			// Keep lighting in the SDF/world frame. The material octave affects pigment
			// and roughness only, avoiding a detached bump layer on a heavily warped body.
			let n = geometryNormal;
			let cosNL = clamp(dot(n, lightDir), 0.0, 1.0);
			let halfDir = safeNormalize(lightDir + view, lightDir);
			let cosNH = clamp(dot(n, halfDir), 0.0, 1.0);
			let cosNV = clamp(dot(n, view), 0.0, 1.0);
			let pore = smoothstep(0.72, 0.94, 1.0 - surfaceNoise);

			let lifecycleHue = u.sproutForm * 0.035 + u.windingForm * 0.105
				+ u.bloomForm * 0.205 + u.sheddingForm * 0.315 + u.dormancyForm * 0.43;
			let surfacePalette = u.paletteOffset + u.palettePhase * 0.34
				+ u.paletteWarmth * 0.075 + lifecycleHue;
			// The same world-space river that crosses the sky passes through Soma's
			// skin as a material current. It only bends pigment/roughness; it never
			// adds unlit brightness, so it cannot become a pasted-on stripe layer.
			let skinFamilyPhase = u.paletteFamily * 1.04719755 + surfacePalette * 1.7
				+ u.spectralTravelPhase * 0.16;
			let skinCurrentAxis = safeNormalize(
				vec3<f32>(cos(skinFamilyPhase), 0.22 + u._pad1 * 0.16, sin(skinFamilyPhase)),
				vec3<f32>(0.7, 0.25, 0.6)
			);
			let skinFlowPhase = u.backgroundPhase + skinFamilyPhase + u.morphPhase * 0.21;
			let skinCurrent = sin(
				dot(p, skinCurrentAxis) * 1.45 - skinFlowPhase * 0.61
					+ surfaceNoise * 3.1 + microNoise * 0.65
			);
			let palT = surfacePalette
				+ length(surfQ) * 0.12
				+ n.x * 0.045 + n.y * 0.055
				+ (surfaceNoise - 0.5) * (0.12 + u.materialErosion * 0.06)
				+ (microNoise - 0.5) * (0.035 + u.surfaceRidges * 0.055)
				+ bandDetail * 0.022
				+ skinCurrent * (0.005 + u.materialIridescence * 0.012);
			let density = clamp(u.materialDensity, 0.30, 1.0);
			let rawBaseCol = palette7(palT);
			let rawBaseLuma = dot(rawBaseCol, vec3<f32>(0.2126, 0.7152, 0.0722));
			let rawBaseChroma = max(rawBaseCol.r, max(rawBaseCol.g, rawBaseCol.b))
				- min(rawBaseCol.r, min(rawBaseCol.g, rawBaseCol.b));
			let pigmentAnchorRaw = palette7(
				surfacePalette + 0.40
					+ (surfaceNoise - 0.5) * 0.14
					+ (microNoise - 0.5) * (0.08 + u.surfaceRidges * 0.05)
					+ skinCurrent * 0.010
			);
			let pigmentAnchorLuma = dot(
				pigmentAnchorRaw,
				vec3<f32>(0.2126, 0.7152, 0.0722)
			);
			let pigmentAnchor = clamp(
				mix(vec3<f32>(pigmentAnchorLuma), pigmentAnchorRaw, 1.18),
				vec3<f32>(0.0),
				vec3<f32>(1.0)
			) * 0.55;
			let washedRecovery = max(
				smoothstep(0.40, 0.70, rawBaseLuma),
				(1.0 - smoothstep(0.08, 0.30, rawBaseChroma))
					* smoothstep(0.22, 0.52, rawBaseLuma)
			);
			let paleRecovery = clamp(
				washedRecovery * (0.50 + density * 0.56)
					+ u.sproutForm * washedRecovery * 0.08
					+ u.sheddingForm * washedRecovery * 0.10,
				0.0,
				0.94
			);
			let pigmentGrain = clamp(
				0.94 + (surfaceNoise - 0.5) * 0.24
					+ (microNoise - 0.5) * (0.20 + u.surfaceRidges * 0.10),
				0.72,
				1.10
			);
			// Pale palette stops retain their hue, but are pulled back into a deeper
			// lifecycle pigment before lighting. White can remain a highlight, not a body.
			var baseCol = mix(rawBaseCol, pigmentAnchor, paleRecovery) * pigmentGrain;
			// Cap diffuse pigment luminance before any light touches it. Specular and
			// rim highlights can still flare, but a pale palette stop can no longer
			// turn the entire close-study body into a white/grey shell.
			let baseColLuma = max(
				dot(baseCol, vec3<f32>(0.2126, 0.7152, 0.0722)),
				0.0001
			);
			let pigmentCeiling = 0.44 + density * 0.12 + u.materialIridescence * 0.025;
			baseCol = baseCol * min(1.0, pigmentCeiling / baseColLuma);

			// Continuous lifecycle material vocabulary: seed/dormancy are waxy,
			// sprout is wet, winding is taut chitin, bloom is crystalline, and
			// shedding is dry/porous. The weights crossfade, so the same organism
			// actually matures rather than swapping arbitrary effects.
			let waxRaw = u.seedForm + u.dormancyForm * 0.45;
			let wetRaw = u.sproutForm;
			let tautRaw = u.windingForm;
			let crystalRaw = u.bloomForm;
			let porousRaw = u.sheddingForm + u.dormancyForm * 0.55;
			let materialWeight = max(waxRaw + wetRaw + tautRaw + crystalRaw + porousRaw, 0.0001);
			let wax = waxRaw / materialWeight;
			let wet = wetRaw / materialWeight;
			let taut = tautRaw / materialWeight;
			let crystal = crystalRaw / materialWeight;
			let porous = porousRaw / materialWeight;
			let ridgeRelief = (surfaceNoise - 0.5) * (0.18 + u.surfaceRidges * 0.22)
				+ (microNoise - 0.5) * (0.11 + u.surfaceRidges * 0.16)
				+ skinCurrent * u.surfaceRidges * 0.015;
			let iridescentShift = u.materialIridescence * (1.0 - cosNV)
				* (0.10 + surfaceNoise * 0.045)
				+ skinCurrent * u.materialIridescence * 0.009;

			let roughness = clamp(
				wax * 0.56 + wet * 0.24 + taut * 0.35 + crystal * 0.22 + porous * 0.80
					+ pore * porous * 0.08 - bandDetail * (wet + crystal) * 0.035
					- u.treble * (wet + crystal) * 0.025 - ridgeRelief * 0.12,
				0.09,
				0.92
			);
			let specStrength = wax * 0.16 + wet * 0.52 + taut * 0.34
				+ crystal * 0.56 + porous * 0.08;
			let diffuseStrength = wax * 0.92 + wet * 0.66 + taut * 0.72
				+ crystal * 0.66 + porous * 0.90;
			let detailShade = clamp(
				0.96 + ridgeRelief - pore * porous * 0.22
					+ (bandDetail - 0.5) * u.mid * 0.035,
				0.60,
				1.18
			);

			// Lighting arrangement and contrast evolve with the lifecycle. All
			// tints come from the song's palette and stay energy-bounded so bloom
			// cannot bleach them into white decals.
			let keyStrength = wax * 0.86 + wet * 1.00 + taut * 1.18
				+ crystal * 0.95 + porous * 0.90;
			let fillStrength = wax * 0.42 + wet * 0.32 + taut * 0.14
				+ crystal * 0.28 + porous * 0.20;
			let rimStrength = wax * 0.08 + wet * 0.22 + taut * 0.48
				+ crystal * 0.52 + porous * 0.42;
			let keyTint = palette7(surfacePalette + 0.16 + iridescentShift * 0.16) * 1.10;
			let fillTint = palette7(surfacePalette + 0.54) * 0.68;
			let rimTint = palette7(surfacePalette + 0.79 + iridescentShift * 1.12) * 1.04;
			let ambientTint = palette7(surfacePalette + 0.66) * 0.42;

			let fillDir = safeNormalize(
				-lightDir + vec3<f32>(-0.18, -0.36, 0.14),
				vec3<f32>(-0.25, -0.55, -0.35)
			);
			let rimDir = safeNormalize(
				-lightDir + vec3<f32>(0.08, 0.20, -0.06),
				-lightDir
			);
			let cosNF = clamp(dot(n, fillDir), 0.0, 1.0);
			let cosNR = clamp(dot(n, rimDir), 0.0, 1.0);
			let rimFresnel = pow(1.0 - cosNV, 3.8);
			let direct = keyTint * cosNL * shadow * keyStrength;
			let fill = fillTint * cosNF * fillStrength;
			let ambient = ambientTint * (0.16 + max(n.y, 0.0) * 0.16) * (0.78 + ao * 0.22);
			// AO still carves the fractal, but it can no longer erase all pigment and
			// leave only a pale rim/specular shell behind.
			let bodyAo = 0.24 + ao * 0.76;
			let diffuse = baseCol * (direct + fill + ambient)
				* bodyAo * detailShade * diffuseStrength * mix(0.90, 1.06, density);

			let specPow = mix(144.0, 12.0, roughness);
			let specular = pow(cosNH, specPow);
			let fresnel = 0.04 + 0.96 * pow(1.0 - cosNV, 5.0);
			let reflected = reflect(-view, n);
			let envLow = palette7(
				surfacePalette + 0.48 + reflected.x * 0.035 + iridescentShift * 0.82
			);
			let envHigh = palette7(
				surfacePalette + 0.82 + reflected.z * 0.035 + iridescentShift * 1.18
			);
			let environment = mix(
				envLow,
				envHigh,
				smoothstep(-0.60, 0.82, reflected.y)
			);
			let reflectionStrength = wet * 0.28 + taut * 0.10 + crystal * 0.36 + wax * 0.04;
			let specularCol = keyTint * specular * specStrength * shadow
				+ environment * fresnel * reflectionStrength;
			let rim = rimTint * cosNR * rimFresnel * rimStrength
				* (0.78 + u.openness * 0.18);

			// Hits remain local to the lower anatomy and modulate the material
			// already present; there is no stripe mask, unlit emission, or screen
			// flash. Crevice color is derived from real AO and stays deliberately low.
			let rootMask = 1.0 - smoothstep(-0.92, 0.24, surfQ.y);
			let impactGain = 1.0 + rootMask * (u.rootPulse * 0.09 + u.surfaceImpact * 0.045);
			let crevice = palette7(surfacePalette + 0.34) * pow(1.0 - ao, 2.0)
				* (porous * 0.026 + crystal * 0.014);
			let deepPigment = mix(pigmentAnchor, baseCol, 0.58);
			let bodyFill = deepPigment * (0.028 + density * 0.070)
				* (0.34 + cosNV * 0.46) * (0.48 + bodyAo * 0.52);
			let surfaceCol = (diffuse + specularCol + rim + bodyFill) * impactGain + crevice;
			scattered = scattered + surfaceCol * transmittance;
			transmittance = 0.0;
			break;
		}

		// ── In-medium fog scattering.
		// Density mildly increases in concavities near the fractal (proxied by
		// the SDF value), so fog hugs the form like incense smoke.
		let proxim = exp(-d * 1.4);
		// Dense tissue pushes the medium away from its silhouette; shedding and
		// cavities invite it back in. Body and atmosphere now trade substance
		// instead of a universal near-surface veil washing every form equally.
		let atmosphereTransfer = clamp(
			(1.0 - u.materialDensity) * 0.55 + u.materialErosion * 0.55
				+ u.cavityOpen * 0.22,
			0.0,
			1.0
		);
		let proximityFog = mix(0.30, 1.10, atmosphereTransfer);
		let localDensity = u.fogDensity * (0.88 + proxim * proximityFog);
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
		let fogLifecycleHue = u.sproutForm * 0.035 + u.windingForm * 0.105
			+ u.bloomForm * 0.205 + u.sheddingForm * 0.315 + u.dormancyForm * 0.43;
		let lightTint = palette7(
			u.paletteOffset + u.palettePhase * 0.34 + u.paletteWarmth * 0.075
			+ fogLifecycleHue + 0.18
		) * (0.12 + u.lightShaftIntensity * 0.08);
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
	let current = scene + bloom * 0.55;
	// Five percent continuity softens raymarch shimmer without holding an old
	// lighting arrangement over a new perspective.
	let blended = mix(current, prev, 0.05);
	return vec4<f32>(blended, 1.0);
}
`;

	// ──────────────────────────────────────────────────────────────────────────
	// Present pass — tone-map + stable dither.
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
	var col = textureSample(compositeTex, samp, uv).rgb;

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
		currentForm = dominantLifecycleForm(journey);

		// Time-correct renderer-side polish. The musical controller already owns
		// the longer envelopes; this final smoothing only keeps GPU uniforms calm.
		const frameScale = frameDt * 60;
		const alpha = (at60Hz: number) => 1 - Math.pow(1 - at60Hz, frameScale);
		const chromaAngle = signalJourney.key * Math.PI * 2;
		const response = VISUALIZER_RESPONSE_PROFILES.mk2[vis.response];
		const responseMotionTarget = response.motion;
		const responseImpactTarget = response.impact;
		const responseFogTarget = response.fog;
		const responseShaftsTarget = response.shafts;
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
			smoothed.responseMotion = responseMotionTarget;
			smoothed.responseImpact = responseImpactTarget;
			smoothed.responseFog = responseFogTarget;
			smoothed.responseShafts = responseShaftsTarget;
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
			// Response changes are instrument gestures, not edits to the camera cut.
			// Glide them onto the renderer so changing modes cannot dolly-jump Soma.
			smoothed.responseMotion = lerp(smoothed.responseMotion, responseMotionTarget, alpha(0.045));
			smoothed.responseImpact = lerp(smoothed.responseImpact, responseImpactTarget, alpha(0.07));
			smoothed.responseFog = lerp(smoothed.responseFog, responseFogTarget, alpha(0.04));
			smoothed.responseShafts = lerp(smoothed.responseShafts, responseShaftsTarget, alpha(0.04));
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
		const responseMotion = smoothed.responseMotion;
		const responseImpact = smoothed.responseImpact;
		const fogDensity = Math.max(
			0.032,
			Math.min(0.088, journey.fogDensity * smoothed.responseFog)
		);
		const lightShaftIntensity = Math.max(
			0.18,
			Math.min(0.8, journey.shaftIntensity * smoothed.responseShafts)
		);
		const responseShotZoom = 1 + (journey.shotZoom - 1) * responseMotion;
		const shotZoom = Math.max(0.9, Math.min(1.85, responseShotZoom));
		const closeStudy = Math.max(0, Math.min(1, journey.closeStudy * responseMotion));
		const detailFocus = Math.max(0, Math.min(1, journey.detailFocus * responseMotion));
		const zoomDelta = shotZoom - 1;
		// Combine a safe dolly with a mild optical push. Even at the closest
		// elected study the camera remains outside the organism's scene bound.
		const dollyScale = 1 / (1 + zoomDelta * 0.47);
		const fovScale =
			(1.54 + mk2SongSeed * 0.12) * (1 + zoomDelta * 0.14);

		// The camera follows a continuous path at the conductor's physical rate.
		// Harmony can gently reframe the target, but phrases and drops never add
		// accumulated offsets and impacts never shake the camera.
		const sessionTargetY = -0.05 + (mk2SongSeed - 0.5) * 0.1;
		const sessionRoll = (mk2SongSeed - 0.5) * 0.14;
		const camPosRaw = getCameraPos(
			journey.cameraPhase,
			journey.perspectiveAzimuth,
			journey.perspectiveElevation
		);
		const cameraScale = journey.cameraDistance * dollyScale;
		const camPos: [number, number, number] = [
			camPosRaw[0] * cameraScale,
			camPosRaw[1] * cameraScale,
			camPosRaw[2] * cameraScale
		];
		// Phrase/key posture now belongs to the organism only. Applying it to the
		// body, camera path, and camera target at once amplified tiny analysis
		// reversals into the old ten-degree twitch-and-return motion.
		const horizontalLength = Math.hypot(camPos[0], camPos[2]) || 1;
		const framingRightX = camPos[2] / horizontalLength;
		const framingRightZ = -camPos[0] / horizontalLength;
		const camTarget: [number, number, number] = [
			framingRightX * journey.shotFramingX,
			sessionTargetY + journey.shotFramingY,
			framingRightZ * journey.shotFramingX
		];
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
		u[33] = Math.min(1, smoothed.staccato * responseImpact);
		u[34] = smoothed.sustain;
		u[35] = journey.rotationPhase;
		u[36] = journey.backgroundFlowPhase;
		u[37] = journey.postureYaw;
		u[38] = journey.posturePitch;
		u[39] = journey.suspense;
		u[40] = journey.seedForm;
		u[41] = journey.sproutForm;
		u[42] = journey.windingForm;
		u[43] = journey.bloomForm;
		u[44] = journey.sheddingForm;
		u[45] = journey.dormancyForm;
		u[46] = journey.morphPhase;
		u[47] = journey.morphRate;
		u[48] = journey.rootMass;
		u[49] = Math.min(1, journey.rootPulse * responseImpact);
		u[50] = journey.axialStretch;
		u[51] = journey.lobeSplit;
		u[52] = journey.foldDepth;
		u[53] = journey.cavityOpen;
		u[54] = journey.surfaceRidges;
		u[55] = journey.filamentReach;
		u[56] = journey.spectralLean;
		u[57] = journey.spectralTravelPhase;
		u[58] = journey.spectralTravelRate;
		u[59] = journey.palettePhase;
		u[60] = journey.paletteWarmth;
		u[61] = journey.materialDensity;
		u[62] = journey.materialIridescence;
		u[63] = journey.materialErosion;
		u[64] = shotZoom;
		u[65] = closeStudy;
		u[66] = detailFocus;
		u[67] = journey.perspectiveAzimuth;
		u[68] = journey.perspectiveElevation;
		u[69] = journey.shotFramingX;
		u[70] = journey.shotFramingY;
		u[71] = 0;
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

		// Present (tone-map + stable dither) → swap chain
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
			aria-label="Soma audio visualizer"
			data-mk2-section={currentSection}
			data-mk2-form={currentForm}
			data-mk2-uniform-bytes={UNIFORM_BYTES}
			data-mk2-render-passes="8"
		></canvas>
		{#if errorMsg}
			<div class="pointer-events-none absolute left-6 top-16 z-30 max-w-md text-xs text-red-300/80">
				Visualizer error: {errorMsg}
			</div>
		{/if}
	</div>
{/if}
