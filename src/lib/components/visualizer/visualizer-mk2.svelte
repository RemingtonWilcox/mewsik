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
	// Future iterations: real circle-of-confusion DOF and Mandelbox / hybrid IFS
	// variants per song seed.

	import { onMount, onDestroy } from 'svelte';
	import {
		VISUALIZER_RESPONSE_PROFILES,
		useVisualizer,
		type VisualizerJourneySnapshot
	} from '$lib/state/visualizer.svelte';
	import { mk2ContinuousPaletteBlend } from '$lib/visualizer/mk2/conductor';
	import {
		SOMA_QUALITY_PROFILES,
		SomaAutoQualityController,
		selectSomaQuality,
		somaBackingSize,
		type SomaQualityProfile,
		type SomaQualityTier
	} from '$lib/visualizer/mk2/runtime';

	const vis = useVisualizer();

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
	let qualityTier = $state<SomaQualityTier>('ultra');
	let renderPixels = $state(0);

	function dominantLifecycleForm(journey: VisualizerJourneySnapshot['mk2']): string {
		const topologies = [
			['cocoon', journey.topologyCocoon],
			['spire', journey.topologySpire],
			['bilateral', journey.topologyBilateral],
			['torus', journey.topologyTorus],
			['coral', journey.topologyCoral],
			['shell', journey.topologyShell]
		] as const;
		if (topologies.every((topology) => Number.isFinite(topology[1]))) {
			let dominantTopology: (typeof topologies)[number] = topologies[0];
			for (const topology of topologies) {
				if (topology[1] > dominantTopology[1]) dominantTopology = topology;
			}
			return dominantTopology[0];
		}
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
	// Five continuously blended shot families. The conductor holds phrase-scale
	// weights, so a profile, overhead, low hero, or anatomical macro is a real
	// perspective—not a tiny offset on the same orbit.
	// ──────────────────────────────────────────────────────────────────────────
	function getCameraPos(
		cameraPhase: number,
		perspectiveAzimuth: number,
		perspectiveElevation: number,
		orbitWeight: number,
		profileWeight: number,
		overheadWeight: number,
		lowWeight: number,
		macroWeight: number
	): [number, number, number] {
		const seedAngle = mk2SongSeed * Math.PI * 2;
		const azimuth =
			seedAngle + cameraPhase * (0.38 + mk2SongSeed * 0.09) + perspectiveAzimuth;
		const baseRadius =
			3.58 + Math.sin(cameraPhase * 0.173 + seedAngle * 0.7) * 0.28 +
			Math.sin(cameraPhase * 0.071 - seedAngle) * 0.14;
		const radius = baseRadius * Math.cos(perspectiveElevation * 0.82);
		const sideDrift = Math.sin(cameraPhase * 0.119 + seedAngle * 1.3) * 0.18;
		const orbit: [number, number, number] = [
			Math.cos(azimuth) * radius + Math.cos(azimuth * 0.37 + seedAngle) * sideDrift,
			0.92 +
				Math.sin(cameraPhase * 0.227 + seedAngle * 0.4) * 0.74 +
				Math.sin(perspectiveElevation) * baseRadius * 0.86,
			Math.sin(azimuth) * radius + Math.sin(azimuth * 0.41 - seedAngle) * sideDrift
		];
		const profileAngle = seedAngle + Math.PI * 0.5 + perspectiveAzimuth * 1.35;
		const profile: [number, number, number] = [
			Math.cos(profileAngle) * 3.25,
			0.20 + Math.sin(cameraPhase * 0.11 + seedAngle) * 0.34,
			Math.sin(profileAngle) * 3.25
		];
		const overheadAngle = seedAngle * 0.7 + cameraPhase * 0.12;
		const overhead: [number, number, number] = [
			Math.cos(overheadAngle) * 1.12,
			4.15 + Math.sin(perspectiveElevation) * 0.42,
			Math.sin(overheadAngle) * 1.12
		];
		const lowAngle = seedAngle - cameraPhase * 0.16 + perspectiveAzimuth;
		const low: [number, number, number] = [
			Math.cos(lowAngle) * 3.72,
			-0.54 + Math.sin(cameraPhase * 0.14) * 0.18,
			Math.sin(lowAngle) * 3.72
		];
		const macroAngle = seedAngle + cameraPhase * 0.09 + perspectiveAzimuth * 1.6;
		const macro: [number, number, number] = [
			Math.cos(macroAngle) * 2.42,
			0.42 + Math.sin(perspectiveElevation) * 0.72,
			Math.sin(macroAngle) * 2.42
		];
		const total = Math.max(
			0.0001,
			orbitWeight + profileWeight + overheadWeight + lowWeight + macroWeight
		);
		const blended = [0, 1, 2].map((axis) =>
			(orbit[axis] * orbitWeight +
				profile[axis] * profileWeight +
				overhead[axis] * overheadWeight +
				low[axis] * lowWeight +
				macro[axis] * macroWeight) /
			total
		) as [number, number, number];
		// Cartesian shot blends can cancel when two valid cameras face each other.
		// Preserve their blended direction but restore a safe, weighted radius so a
		// crossfade can never pass through the organism.
		let blendedLength = Math.hypot(blended[0], blended[1], blended[2]);
		if (blendedLength < 0.2) {
			blended[0] = orbit[0];
			blended[1] = orbit[1];
			blended[2] = orbit[2];
			blendedLength = Math.hypot(...blended);
		}
		const desiredRadius =
			(Math.hypot(...orbit) * orbitWeight +
				3.28 * profileWeight +
				4.3 * overheadWeight +
				3.76 * lowWeight +
				2.58 * macroWeight) /
			total;
		const safeRadius = Math.max(2.55, desiredRadius);
		const radiusScale = safeRadius / Math.max(blendedLength, 0.0001);
		return [
			blended[0] * radiusScale,
			blended[1] * radiusScale,
			blended[2] * radiusScale
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
	// Uniform layout — 92 f32s = 368 bytes (multiple of 16 ✓)
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
	// 71    quality raymarch steps
	// 72-77 persistent Soma topology DNA: cocoon / spire / bilateral / torus / coral / shell
	// 78-82 environment DNA: void / current / cavern / horizon / cellular
	// 83-86 material DNA: membrane / mineral / velvet / crystal
	// 87-88 secondary palette family / continuous family blend
	// 89    render-detail budget (quality tier normalized)
	// 90-91 alignment / future grammar
	const UNIFORM_FLOATS = 92;
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
	qualitySteps: f32,
	topologyCocoon: f32,
	topologySpire: f32,
	topologyBilateral: f32,
	topologyTorus: f32,
	topologyCoral: f32,
	topologyShell: f32,
	environmentVoid: f32,
	environmentCurrent: f32,
	environmentCavern: f32,
	environmentHorizon: f32,
	environmentCellular: f32,
	materialMembrane: f32,
	materialMineral: f32,
	materialVelvet: f32,
	materialCrystal: f32,
	paletteFamilyB: f32,
	paletteFamilyBlend: f32,
	renderDetail: f32,
	_pad2: f32,
	_pad3: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	var pos = array<vec2<f32>, 6>(
		vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
		vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0)
	);
	return vec4<f32>(pos[idx], 0.0, 1.0);
}

// ═══════════════════════════════════════════════════════════════════════════
// 7-stop palette LUT — eight coordinated colour worlds. Soma keeps a stable
// primary family, then slowly migrates toward a music-derived secondary world;
// this preserves track identity without trapping a whole song in one pastel.
//   0 dusk        photographic — deep navy → plum → burnt orange → cream → teal
//   1 aurora      cool — blacks → indigos → cyans → mint → bright magenta cap
//   2 synthwave   neon — black → hot magenta → cyan → electric purple
//   3 volcanic    warm — black → ember red → orange → bright yellow → bone white
//   4 bioluminous UV → cyan → green → chartreuse on near-black field
//   5 oil-on-water iridescent — petrol blues → magenta → gold → mint shifts
//   6 obsidian mineral — graphite → oxidized copper → brass → bone
//   7 verdant deep sea — black kelp → moss → coral → cold daylight
// ═══════════════════════════════════════════════════════════════════════════
fn paletteFamily(t: f32, family: i32) -> vec3<f32> {
	let s = fract(t);
	let x = s * 7.0;
	let i = i32(floor(x));
	let f = smoothstep(0.0, 1.0, x - floor(x));
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
	} else if (family == 6) {
		// obsidian mineral
		stops = array<vec3<f32>, 7>(
			vec3<f32>(0.008, 0.010, 0.014),
			vec3<f32>(0.055, 0.065, 0.072),
			vec3<f32>(0.060, 0.250, 0.235),
			vec3<f32>(0.520, 0.290, 0.110),
			vec3<f32>(0.840, 0.650, 0.270),
			vec3<f32>(0.740, 0.710, 0.610),
			vec3<f32>(0.120, 0.150, 0.160)
		);
	} else if (family == 7) {
		// verdant deep sea
		stops = array<vec3<f32>, 7>(
			vec3<f32>(0.005, 0.018, 0.016),
			vec3<f32>(0.018, 0.095, 0.070),
			vec3<f32>(0.120, 0.360, 0.160),
			vec3<f32>(0.680, 0.320, 0.180),
			vec3<f32>(0.940, 0.620, 0.360),
			vec3<f32>(0.500, 0.800, 0.700),
			vec3<f32>(0.050, 0.210, 0.250)
		);
	}
	let a = stops[(i % 7 + 7) % 7];
	let b = stops[((i + 1) % 7 + 7) % 7];
	return mix(a, b, f);
}

fn hsvToRgb(h: f32, s: f32, v: f32) -> vec3<f32> {
	let p = abs(fract(vec3<f32>(h) + vec3<f32>(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
	return v * mix(vec3<f32>(1.0), clamp(p - 1.0, vec3<f32>(0.0), vec3<f32>(1.0)), s);
}

fn palette7(t: f32) -> vec3<f32> {
	let primary = paletteFamily(t, i32(u.paletteFamily));
	let secondary = paletteFamily(t + u.paletteWarmth * 0.035, i32(u.paletteFamilyB));
	let familyBlend = clamp(u.paletteFamilyBlend, 0.0, 0.62);
	let blended = mix(primary, secondary, familyBlend);
	let luma = dot(blended, vec3<f32>(0.2126, 0.7152, 0.0722));
	// Complementary family migration happens in RGB for speed; restore chroma so
	// orange + blue becomes iridescent pigment instead of grey/lavender paste.
	return clamp(
		mix(vec3<f32>(luma), blended, 1.12 + familyBlend * 0.24),
		vec3<f32>(0.0),
		vec3<f32>(1.0)
	);
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

fn sdTorusY(p: vec3<f32>, majorRadius: f32, minorRadius: f32) -> f32 {
	let radial = length(p.xz) - majorRadius;
	return length(vec2<f32>(radial, p.y)) - minorRadius;
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
	// Sharpen the normalized grammar perceptually. The conductor still crossfades
	// smoothly, but one anatomy leads instead of six equally averaging to a blob.
	let spireDNA = pow(max(u.topologySpire, 0.0), 1.8);
	let bilateralDNA = pow(max(u.topologyBilateral, 0.0), 1.8);
	let torusDNA = pow(max(u.topologyTorus, 0.0), 1.8);
	let coralDNA = pow(max(u.topologyCoral, 0.0), 1.8);
	let shellDNA = pow(max(u.topologyShell, 0.0), 1.8);
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
	let globalYaw = u.journeyPhase * 0.34 + u.postureYaw * 0.72
		+ sin(u.morphPhase * 0.37) * 0.055
		+ (bilateralDNA - torusDNA) * 0.32;
	let yawed = rot2(q.xz, globalYaw);
	q.x = yawed.x;
	q.z = yawed.y;
	let pitched = rot2(
		q.yz,
		u.posturePitch * 1.15 + shellDNA * 0.46 - coralDNA * 0.16
	);
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

	// Soma DNA owns the main axes. Section lifecycle may develop that anatomy,
	// but it can no longer force every verse into a column and every chorus wide.
	let stretchY = max(0.52,
		0.76 + spireDNA * 1.05 + coralDNA * 0.22
		+ u.axialStretch * (0.18 + spireDNA * 0.28)
		- torusDNA * 0.38 - bilateralDNA * 0.08
		- u.dormancyForm * 0.12);
	let stretchX = max(0.64,
		0.76 + bilateralDNA * 0.72 + torusDNA * 0.34
		+ coralDNA * 0.30 + u.lobeSplit * 0.15
		- spireDNA * 0.22 + u.bloomForm * 0.08);
	let stretchZ = max(0.64,
		0.78 + torusDNA * 0.42 + shellDNA * 0.35
		+ coralDNA * 0.19 + u.lobeSplit * 0.12 + u.rootMass * 0.06
		- bilateralDNA * 0.12);
	q.x = q.x / stretchX;
	q.y = q.y / stretchY;
	q.z = q.z / stretchZ;

	// Sprout grows as one visibly biased shoot instead of a uniformly stretched
	// orb. Winding then pulls the cross-section inward before applying its twist;
	// bloom releases that stored pressure laterally, while dormancy settles flat.
	let sproutBend = (u.sproutForm * 0.34 + spireDNA * 0.92)
		* (0.08 + u.axialStretch * 0.08);
	q.x = q.x - sin(q.y * 1.18 + tSlow * 0.23) * sproutBend
		- q.y * q.y * u.sproutForm * 0.045;
	let windingCompression = 1.0
		+ (u.windingForm * 0.42 + shellDNA * 0.68) * (0.10 + u.foldDepth * 0.18);
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
	let outerBound = length(p) - 2.18;
	if (outerBound > 0.35) {
		return outerBound * 0.62;
	}
	let q = organismWarp(p);

	// Six cheap macro anatomies form persistent Soma DNA. Their normalized
	// conductor weights can crossfade over phrases, but unlike the old lifecycle
	// deformation they have genuinely different topology and negative space.
	let cocoonRadii = vec3<f32>(
		0.58 + u.rootMass * 0.07 + u.bloomForm * 0.04,
		0.64 + u.axialStretch * 0.08 - u.dormancyForm * 0.07,
		0.56 + u.lobeSplit * 0.06 + u.dormancyForm * 0.06
	);
	let cocoon = sdEllipsoid(q, cocoonRadii);
	// Spire is an articulated, leaning anatomy rather than the old single tall
	// ellipsoid. Three overlapping masses create a readable waist and changing
	// profile while remaining thick enough to raymarch cleanly at every tier.
	let spireDrift = sin(u.morphPhase * 0.19 + u.paletteFamily) * 0.10
		+ u.spectralLean * 0.13;
	let spireRoot = sdEllipsoid(
		q - vec3<f32>(-spireDrift * 0.22, -0.31, 0.035),
		vec3<f32>(0.43 + u.rootMass * 0.055, 0.49, 0.43)
	);
	let spireStem = sdEllipsoid(
		q - vec3<f32>(spireDrift, 0.24, -0.055),
		vec3<f32>(0.31 + u.foldDepth * 0.035, 0.54, 0.34)
	);
	let spireCrown = sdEllipsoid(
		q - vec3<f32>(-spireDrift * 0.72, 0.72, 0.075),
		vec3<f32>(0.245 + u.surfaceRidges * 0.025, 0.31, 0.285)
	);
	var spire = smin(spireRoot, spireStem, 0.11);
	spire = smin(spire, spireCrown, 0.085);
	let bilateralLeft = sdEllipsoid(
		q - vec3<f32>(-0.31, 0.02 + u.spectralLean * 0.05, 0.03),
		vec3<f32>(0.43, 0.58 + u.foldDepth * 0.08, 0.46)
	);
	let bilateralRight = sdEllipsoid(
		q - vec3<f32>(0.31, -0.03 - u.spectralLean * 0.05, -0.03),
		vec3<f32>(0.43, 0.56 + u.foldDepth * 0.08, 0.46)
	);
	let bilateral = smin(bilateralLeft, bilateralRight, 0.09 + u.lobeSplit * 0.11);
	var torusQ = q;
	let torusTilt = rot2(torusQ.yz, 0.28 + u.spectralLean * 0.22);
	torusQ.y = torusTilt.x;
	torusQ.z = torusTilt.y;
	let torus = sdTorusY(
		torusQ,
		0.44 + u.rootMass * 0.06 + u.lobeSplit * 0.05,
		0.19 + u.materialDensity * 0.055
	);
	let coralCore = sdEllipsoid(q, vec3<f32>(0.48, 0.55, 0.47));
	let shellOuter = sdEllipsoid(q, vec3<f32>(0.68, 0.58, 0.62));
	let shellInner = sdEllipsoid(
		q - vec3<f32>(0.12 + u.spectralLean * 0.06, 0.05, 0.02),
		vec3<f32>(0.48, 0.39, 0.43)
	);
	var shell = smax(shellOuter, -shellInner, 0.055);
	let shellMouth = sdCapsule(
		q,
		vec3<f32>(0.18, 0.05, -0.62),
		vec3<f32>(0.42, 0.08, 0.72),
		0.17 + u.cavityOpen * 0.08
	);
	shell = smax(shell, -shellMouth, 0.045);

	// Macro topology must read as one coherent anatomy. A soft linear blend between
	// incompatible signed-distance fields (especially torus + coral) can create
	// isolated zero-crossings that look like floating coins. Phrase transitions are
	// already slow, so a stronger perceptual election stays smooth while removing
	// those accidental satellite surfaces.
	let cocoonW = pow(max(u.topologyCocoon, 0.0), 6.0);
	let spireW = pow(max(u.topologySpire, 0.0), 6.0);
	let bilateralW = pow(max(u.topologyBilateral, 0.0), 6.0);
	let torusW = pow(max(u.topologyTorus, 0.0), 6.0);
	let coralW = pow(max(u.topologyCoral, 0.0), 6.0);
	let shellW = pow(max(u.topologyShell, 0.0), 6.0);
	let topologyWeight = max(
		cocoonW + spireW + bilateralW + torusW + coralW + shellW,
		0.0001
	);
	// Interpolate topology as a connected anatomical union, not an arithmetic
	// average of unrelated distance fields. Averaging a shell, torus, and core near
	// equal weights creates extra zero-crossings (floating islands). Relative
	// activations instead let secondary anatomies grow out of the dominant body;
	// negative space emerges cleanly once torus or shell actually wins the phrase.
	let maxTopology = max(
		max(max(u.topologyCocoon, u.topologySpire), max(u.topologyBilateral, u.topologyTorus)),
		max(u.topologyCoral, u.topologyShell)
	);
	let safeMaxTopology = max(maxTopology, 0.0001);
	let cocoonA = smoothstep(0.36, 0.82, u.topologyCocoon / safeMaxTopology);
	let spireA = smoothstep(0.36, 0.82, u.topologySpire / safeMaxTopology);
	let bilateralA = smoothstep(0.36, 0.82, u.topologyBilateral / safeMaxTopology);
	let torusA = smoothstep(0.36, 0.82, u.topologyTorus / safeMaxTopology);
	let coralA = smoothstep(0.36, 0.82, u.topologyCoral / safeMaxTopology);
	let shellA = smoothstep(0.36, 0.82, u.topologyShell / safeMaxTopology);
	let inactiveOffset = 0.72;
	var macroBody = cocoon + (1.0 - cocoonA) * inactiveOffset;
	macroBody = smin(macroBody, spire + (1.0 - spireA) * inactiveOffset, 0.075);
	macroBody = smin(macroBody, bilateral + (1.0 - bilateralA) * inactiveOffset, 0.075);
	macroBody = smin(macroBody, torus + (1.0 - torusA) * inactiveOffset, 0.070);
	macroBody = smin(macroBody, coralCore + (1.0 - coralA) * inactiveOffset, 0.080);
	macroBody = smin(macroBody, shell + (1.0 - shellA) * inactiveOffset, 0.065);

	// The Mandelbulb is now a bounded anatomical texture, not the universal
	// silhouette. Hero shots keep a clean macro edge; elected detail studies reveal
	// deeper fractal cuts without generating dust-sized spikes at normal distance.
	let bodyScale = 1.32 + u.topologyCocoon * 0.12 + u.topologyShell * 0.08
		- u.topologyCoral * 0.06;
	var fractalIterations = 4;
	if (u.renderDetail > 0.45 && u.detailFocus > 0.44) { fractalIterations = 5; }
	if (u.renderDetail > 0.82 && u.closeStudy > 0.58 && u.detailFocus > 0.66) {
		fractalIterations = 6;
	}
	let fractal = mandelbulbDE(
		q * bodyScale,
		clamp(u.mandelbulbPower + tension * 0.16 + u.foldDepth * 0.15, 5.2, 7.4),
		fractalIterations
	) / bodyScale;
	let electedDetailStudy = smoothstep(0.34, 0.78, u.closeStudy)
		* smoothstep(0.42, 0.86, u.detailFocus);
	let fractalReveal = clamp(
		electedDetailStudy * (
			0.10 + u.topologyCoral * 0.20 + u.topologyShell * 0.12
				+ u.windingForm * 0.06
		),
		0.0,
		0.30
	);
	let fractalOffset = clamp(fractal - macroBody - 0.012, -0.044, 0.044);
	var body = macroBody + fractalOffset * fractalReveal;
	let reliefSeed = vec3<f32>(
		u.paletteFamily * 1.73 + 4.1,
		u.paletteFamily * 2.31 + 9.7,
		u.paletteFamily * 3.17 + 15.3
	);
	let anatomicalRelief = vn3(
		q * (2.7 + u.materialMineral * 1.25 + u.materialVelvet * 0.45)
			+ reliefSeed + vec3<f32>(u.morphPhase * 0.008)
	) - 0.5;
	body = body + anatomicalRelief * (
		0.010 + u.materialMineral * 0.020 + u.materialVelvet * 0.011
			+ u.surfaceRidges * u.renderDetail * 0.008
	);

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
	let rootTopologyGate = clamp(
		(cocoonW + spireW + bilateralW * 0.38 + coralW * 0.56 + shellW * 0.14)
			/ topologyWeight,
		0.0,
		1.0
	);
	let gatedRootLobe = rootLobe + (1.0 - rootTopologyGate) * 0.46;
	body = smin(body, gatedRootLobe, 0.075 + u.rootMass * 0.030);

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

		let coralGate = smoothstep(0.18, 0.42, u.topologyCoral);
		let bilateralGate = smoothstep(0.20, 0.42, u.topologyBilateral);
		let spireGate = smoothstep(0.20, 0.42, u.topologySpire);
		var topologyGate = coralGate;
		if (i < 2) { topologyGate = max(topologyGate, bilateralGate * 0.86); }
		if (i == 0) { topologyGate = max(topologyGate, spireGate * 0.92); }
		let lifecycleDevelopment = clamp(
			u.sproutForm * sproutGate
				+ u.windingForm * windingGate * 0.72
				+ u.bloomForm * bloomGate,
			0.0,
			1.0
		);
		// Topology selects where a limb may grow; the lifecycle decides whether it
		// has actually developed. Seed/dormant bodies therefore cannot show only the
		// occluded tips of far-side coral branches as detached floating ovals.
		let presence = clamp(
			topologyGate * (0.18 + lifecycleDevelopment * 0.92 + u.filamentReach * 0.06),
			0.0,
			1.0
		);
		let laneVariation = 0.90 + f32(i) * 0.055 + lanePolarity * u.spectralLean * 0.08;
		let reach = (
			0.46 + u.axialStretch * 0.18 + u.lobeSplit * 0.24
			+ u.topologyCoral * 0.38 + u.topologySpire * 0.18
			+ u.bloomForm * 0.12 + u.filamentReach * 0.08 - u.windingForm * 0.05
		) * laneVariation;
		let a = direction * (0.14 + u.windingForm * 0.13);
		var b = direction * reach;
		b.y = b.y + sin(u.morphPhase * 0.73 + f32(i) * 1.9) * (0.025 + u.foldDepth * 0.07);
		b.x = b.x + u.spectralLean * lanePolarity * (0.035 + u.lobeSplit * 0.055);
		// Never shrink a whole limb by adding an SDF offset: midway through that
		// transition only the terminal bud survived, creating detached coin shapes.
		// The condition is uniform for the draw and changes only on phrase-scale DNA.
		if (presence > 0.44) {
			let visibility = smoothstep(0.44, 0.68, presence);
			let branchRadius = (0.118 + u.rootMass * 0.026 + u.lobeSplit * 0.044
				+ u.topologyCoral * 0.056 + u.bloomForm * 0.026)
				* (0.78 + visibility * 0.22);
			let branch = sdCapsule(q, a, b, branchRadius);
			// A generous anatomical fillet keeps a branch that curves around the far
			// side from reading as a detached coin when only its tip is in silhouette.
			body = smin(body, branch, 0.105 + visibility * 0.055);
		}
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
	let cavityGate = smoothstep(
		0.08,
		0.74,
		max(u.cavityOpen, u.topologyShell * 0.88 + u.topologyTorus * 0.48)
	);
	body = smax(body, -tunnel - (1.0 - cavityGate) * 0.46, 0.052);
	let pocket = length(cavityQ - vec3<f32>(0.34, 0.29, 0.18))
		- (0.11 + u.cavityOpen * 0.21);
	body = smax(body, -pocket - (1.0 - u.sheddingForm) * 0.36, 0.044);

	// True Mandelbulb detail, lifecycle anatomy, and hit-time pore material now
	// provide all fine structure. Removing procedural SDF corrugation prevents
	// bright grazing light from turning tiny ridges into another stripe pattern
	// and saves several trigonometric operations on every map evaluation.
	// Non-uniform topology warps are not exact distance fields. A conservative
	// safety factor prevents a march from leaping across thin shell/coral edges.
	return body * 0.54;
}

// 4-tap tetrahedral normal estimation.
fn calcNormal(p: vec3<f32>) -> vec3<f32> {
	let macroFocus = clamp(u.closeStudy * u.detailFocus, 0.0, 1.0);
	let pixelFootprint = 0.82 / max(u.resolutionY, 1.0);
	let normalEpsilon = max(
		pixelFootprint * mix(1.45, 0.85, u.renderDetail),
		mix(0.0019, 0.00082, macroFocus * u.renderDetail)
	);
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
	let voidRaw = pow(max(u.environmentVoid, 0.0), 1.8);
	let currentRaw = pow(max(u.environmentCurrent, 0.0), 1.8);
	let cavernRaw = pow(max(u.environmentCavern, 0.0), 1.8);
	let horizonRaw = pow(max(u.environmentHorizon, 0.0), 1.8);
	let cellularRaw = pow(max(u.environmentCellular, 0.0), 1.8);
	let environmentWeight = max(
		voidRaw + currentRaw + cavernRaw + horizonRaw + cellularRaw,
		0.0001
	);
	let voidW = voidRaw / environmentWeight;
	let currentW = currentRaw / environmentWeight;
	let cavernW = cavernRaw / environmentWeight;
	let horizonW = horizonRaw / environmentWeight;
	let cellularW = cellularRaw / environmentWeight;
	let horizon = palette7(baseT + 0.03) * (
		0.025 + currentW * 0.036 + horizonW * 0.048 + cellularW * 0.024
			+ growth * 0.005 - voidW * 0.006
	);
	let zenith = palette7(baseT + 0.70 + u.materialErosion * 0.08)
		* (0.004 + cavernW * 0.004 + cellularW * 0.003);
	var bg = mix(horizon, zenith, smoothstep(0.0, 1.0, upT));

	let camPos = vec3<f32>(u.camPosX, u.camPosY, u.camPosZ);
	let camFwd = safeNormalize(
		vec3<f32>(u.camFwdX, u.camFwdY, u.camFwdZ),
		vec3<f32>(0.0, 0.0, -1.0)
	);
	let worldP = camPos + rd * 8.0;

	// Environment DNA is real world-space structure, not another fullscreen
	// texture stack. Cavern strata and cellular membranes move with the camera;
	// horizon and void remain deliberately quieter counterpoints.
	let cavernNoise = vn3(worldP * vec3<f32>(0.18, 0.28, 0.18)
		+ vec3<f32>(u.backgroundPhase * 0.018, 0.0, 0.0));
	let cavernStrata = smoothstep(
		0.52,
		0.84,
		0.5 + 0.5 * cos(length(worldP.xz) * 0.72 + worldP.y * 0.34 + cavernNoise * 2.1)
	);
	let horizonBand = exp(-abs(rd.y + 0.08 + u.perspectiveElevation * 0.08) * 12.0);
	let cellularPhase = sin(worldP.x * 0.72 + u.backgroundPhase * 0.11)
		* sin(worldP.y * 0.61 - u.morphPhase * 0.07)
		* sin(worldP.z * 0.67 + u.spectralTravelPhase * 0.09);
	let cellularMembrane = smoothstep(0.20, 0.72, abs(cellularPhase));
	bg = bg
		+ palette7(baseT + 0.43) * cavernStrata * cavernW * 0.095
		+ palette7(baseT + 0.19) * horizonBand * horizonW * (0.078 + growth * 0.018)
		+ palette7(baseT + 0.62) * cellularMembrane * cellularW * 0.068;
	bg = bg * (
		1.0 - cavernW * (1.0 - cavernStrata) * 0.34
			- cellularW * (1.0 - cellularMembrane) * 0.16
	);
	bg = bg * (1.0 - voidW * 0.28);
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
	bg = bg * (1.0 - current * currentW * (0.055 + tension * 0.025));
	bg = bg + currentCol * current * (0.14 + currentW * 0.86 + cellularW * 0.16) * (
		0.041 + u.rms * 0.025 + growth * 0.024 + u.sproutForm * 0.009
			+ u.bloomForm * 0.047 + u.sheddingForm * 0.026
			+ atmosphereTransfer * 0.021 + u.suspense * 0.010
	);

	// Preserve a quiet pocket behind the subject. The current remains visible at
	// the periphery and through negative-space openings without becoming a halo.
	let heroFocus = pow(clamp(dot(rd, camFwd), 0.0, 1.0), 18.0);
	bg = bg * (1.0 - heroFocus * (0.24 + tension * 0.05 + u.dormancyForm * 0.08));
	let backgroundLuma = max(
		dot(bg, vec3<f32>(0.2126, 0.7152, 0.0722)),
		0.0001
	);
	let backgroundCeiling = 0.16 + horizonW * 0.035 + cellularW * 0.018;
	bg = bg * min(1.0, backgroundCeiling / backgroundLuma);

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
	let MAX_STEPS = 72;
	let MAX_DIST = 10.0;
	let macroFocus = clamp(u.closeStudy * u.detailFocus, 0.0, 1.0);
	let EPS_NEAR = mix(0.0017, 0.00072, macroFocus * u.renderDetail);
	let EPS_FAR  = mix(0.0052, 0.0028, macroFocus * u.renderDetail);

	var transmittance = 1.0;
	var scattered = vec3<f32>(0.0);
	// Jitter is sub-pixel now. The old 0.04 world-unit offset was more than half
	// a branch radius and visibly shattered edges into a 4x4 pixel pattern.
	var t = 0.05 + dither(frag.xy) * 0.0035;
	var previousT = t;
	var previousD = 1.0;

	for (var i: i32 = 0; i < MAX_STEPS; i = i + 1) {
		if (i >= i32(clamp(u.qualitySteps, 1.0, f32(MAX_STEPS)))) { break; }
		if (i >= 64 && (u.closeStudy < 0.55 || u.detailFocus < 0.55)) { break; }
		if (t > MAX_DIST) { break; }
		var p = camPos + rd * t;
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
			// Three bounded refinements recover a stable surface after conservative
			// marching. This runs only once per hit pixel, not throughout the ray.
			var hitLo = previousT;
			var hitHi = t;
			if (previousD > EPS && hitHi > hitLo + 0.00001) {
				for (var refine: i32 = 0; refine < 3; refine = refine + 1) {
					let candidate = mix(hitLo, hitHi, 0.5);
					var candidateD = map(camPos + rd * candidate);
					if (!(abs(candidateD) < 1e10)) { candidateD = EPS; }
					if (candidateD > EPS * 0.45) {
						hitLo = candidate;
					} else {
						hitHi = candidate;
					}
				}
				t = hitHi;
				p = camPos + rd * t;
			}
			let geometryNormal = calcNormal(p);
			let view = -rd;
			// AO and the key/fill rig carry depth. A secondary SDF shadow march over
			// non-uniform topology warps produced the saw-tooth terminator reported as
			// pixel hair, so Soma deliberately avoids that unstable second trace.
			let shadow = 1.0;

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
			let familyOffset = vec3<f32>(
				u.paletteFamily * 7.13 + 2.7,
				u.paletteFamily * 3.71 + 11.9,
				u.paletteFamily * 5.37 + 19.1
			);
			let surfaceNoise = vn3(
				surfQ * (3.8 + u.materialErosion * 2.0 + u.detailFocus * u.renderDetail * 1.8)
					+ familyOffset + vec3<f32>(u.morphPhase * 0.012)
			);
			let anatomicalNoise = vn3(
				surfQ * (2.15 + u.materialMineral * 0.72 + u.materialCrystal * 0.44)
					+ familyOffset * 0.43 + vec3<f32>(u.morphPhase * 0.004)
			);
			// One hit-time octave gives broad cocoon lobes actual skin. Its spatial
			// scale stays fixed while audio changes contrast/roughness, so pores breathe
			// without crawling or rescaling. This never runs inside the raymarch, SDF
			// normal, shadow, or AO loops.
			let microScale = mix(8.0, 11.5, u.renderDetail * u.detailFocus);
			let microP = surfQ * microScale + familyOffset * 1.71
				- vec3<f32>(u.morphPhase * 0.019);
			let microNoise = vn3(microP);
			// Keep lighting in the SDF/world frame. The material octave affects pigment
			// and a restrained normal relief under real light. Three decorrelated
			// world-space samples create pores/facets without a projected texture layer.
			let materialScale = 3.25 + u.materialMineral * 1.15
				+ u.materialCrystal * 0.72 + u.renderDetail * 0.55;
			let materialP = surfQ * materialScale + familyOffset * 1.31;
			let materialVector = vec3<f32>(
				surfaceNoise - 0.5,
				vn3(materialP.yzx + vec3<f32>(7.3, 13.1, 2.9)) - 0.5,
				vn3(materialP.zxy + vec3<f32>(19.7, 3.7, 11.3)) - 0.5
			);
			let tangentRelief = materialVector
				- geometryNormal * dot(materialVector, geometryNormal);
			let reliefStrength = (
				0.040 + u.materialMineral * 0.13 + u.materialCrystal * 0.10
					+ u.materialVelvet * 0.045 + u.surfaceRidges * 0.050
			) * u.renderDetail;
			var n = safeNormalize(geometryNormal + tangentRelief * reliefStrength, geometryNormal);
			let quantizedNormal = safeNormalize(
				sign(n) * floor(abs(n) * 12.0 + 0.5) / 12.0,
				n
			);
			n = safeNormalize(
				mix(n, quantizedNormal, u.materialCrystal * u.detailFocus * 0.12),
				n
			);
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
				+ (surfaceNoise - 0.5) * (0.28 + u.materialErosion * 0.08)
				+ (anatomicalNoise - 0.5) * (0.22 + u.materialMineral * 0.08)
				+ (microNoise - 0.5) * (0.018 + u.surfaceRidges * 0.025)
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
			let materialTerritory = anatomicalNoise * 0.62 + surfaceNoise * 0.38;
			let broadPigment = smoothstep(0.18, 0.82, materialTerritory);
			let pigmentGrain = clamp(
				0.56 + broadPigment * (0.72 + u.materialMineral * 0.08)
					+ (microNoise - 0.5) * (0.07 + u.surfaceRidges * 0.05),
				0.52,
				1.38
			);
			// Pale palette stops retain their hue, but are pulled back into a deeper
			// lifecycle pigment before lighting. White can remain a highlight, not a body.
			var baseCol = mix(rawBaseCol, pigmentAnchor, paleRecovery) * pigmentGrain;
			let anatomicalAccent = (0.20 + anatomicalNoise * 0.58)
				* (0.10 + u.materialMineral * 0.30 + u.materialCrystal * 0.24);
			let accentPigment = palette7(
				palT + 0.30 + anatomicalNoise * 0.13 + skinCurrent * 0.012
			) * 0.60;
			baseCol = mix(baseCol, accentPigment, anatomicalAccent * 0.62);
			let anchorPrimary = paletteFamily(surfacePalette + 0.31, i32(u.paletteFamily));
			let anchorSecondary = paletteFamily(surfacePalette + 0.47, i32(u.paletteFamilyB));
			let anchorPrimaryChroma = max(
				anchorPrimary.r,
				max(anchorPrimary.g, anchorPrimary.b)
			) - min(anchorPrimary.r, min(anchorPrimary.g, anchorPrimary.b));
			let anchorSecondaryChroma = max(
				anchorSecondary.r,
				max(anchorSecondary.g, anchorSecondary.b)
			) - min(anchorSecondary.r, min(anchorSecondary.g, anchorSecondary.b));
			let selectedAnchor = select(
				anchorPrimary,
				anchorSecondary,
				anchorSecondaryChroma > anchorPrimaryChroma
			);
			let selectedAnchorLuma = dot(
				selectedAnchor,
				vec3<f32>(0.2126, 0.7152, 0.0722)
			);
			let stopAnchor = clamp(
				mix(vec3<f32>(selectedAnchorLuma), selectedAnchor, 1.34),
				vec3<f32>(0.0),
				vec3<f32>(1.0)
			) * 0.48;
			let harmonicAnchor = hsvToRgb(
				fract(surfacePalette + u.paletteWarmth * 0.045 + u.paletteFamily * 0.071),
				0.78,
				0.34
			);
			let chromaticAnchor = mix(stopAnchor, harmonicAnchor, 0.68);
			let initialBaseChroma = max(baseCol.r, max(baseCol.g, baseCol.b))
				- min(baseCol.r, min(baseCol.g, baseCol.b));
			baseCol = mix(
				baseCol,
				chromaticAnchor,
				0.36 + (1.0 - smoothstep(0.08, 0.24, initialBaseChroma)) * 0.50
			);
			// Broad, world-space pigment territories remain visible after palette
			// recovery. They supply real material scale without FFT stripes, dust-sized
			// flecks, or a projected texture layer.
			let materialTone = mix(0.42, 1.46, broadPigment);
			let deepMaterialPigment = palette7(
				surfacePalette + 0.14 + anatomicalNoise * 0.34 + surfaceNoise * 0.18
			) * 0.38;
			baseCol = mix(
				baseCol * materialTone,
				deepMaterialPigment,
				(1.0 - broadPigment) * (
					0.14 + u.materialMineral * 0.18 + u.materialVelvet * 0.14
						+ u.materialCrystal * 0.08
				)
			);
			let pigmentLuma = dot(baseCol, vec3<f32>(0.2126, 0.7152, 0.0722));
			baseCol = clamp(
				mix(vec3<f32>(pigmentLuma), baseCol, 1.14),
				vec3<f32>(0.0),
				vec3<f32>(1.0)
			);
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
			let membraneDNA = pow(max(u.materialMembrane, 0.0), 1.65);
			let mineralDNA = pow(max(u.materialMineral, 0.0), 1.65);
			let velvetDNA = pow(max(u.materialVelvet, 0.0), 1.65);
			let crystalDNA = pow(max(u.materialCrystal, 0.0), 1.65);
			let waxRaw = membraneDNA * (0.72 + u.seedForm * 0.38)
				+ velvetDNA * 0.18 + u.dormancyForm * 0.12;
			let wetRaw = membraneDNA * (0.32 + u.sproutForm * 0.46);
			let tautRaw = mineralDNA * (0.72 + u.windingForm * 0.42);
			let crystalRaw = crystalDNA * (0.76 + u.bloomForm * 0.38);
			let porousRaw = velvetDNA * (0.84 + u.sheddingForm * 0.42)
				+ mineralDNA * u.materialErosion * 0.16;
			let materialWeight = max(waxRaw + wetRaw + tautRaw + crystalRaw + porousRaw, 0.0001);
			let wax = waxRaw / materialWeight;
			let wet = wetRaw / materialWeight;
			let taut = tautRaw / materialWeight;
			let crystal = crystalRaw / materialWeight;
			let porous = porousRaw / materialWeight;
			let ridgeRelief = (surfaceNoise - 0.5) * (0.28 + u.surfaceRidges * 0.28)
				+ (microNoise - 0.5) * (0.065 + u.surfaceRidges * 0.10)
				+ skinCurrent * u.surfaceRidges * 0.015;
			let iridescentShift = u.materialIridescence * (1.0 - cosNV)
				* (0.10 + surfaceNoise * 0.045)
				+ skinCurrent * u.materialIridescence * 0.009;

			let roughness = clamp(
				wax * 0.56 + wet * 0.24 + taut * 0.35 + crystal * 0.22 + porous * 0.80
					+ pore * porous * 0.08
					- u.treble * (wet + crystal) * 0.025 - ridgeRelief * 0.12,
				0.09,
				0.92
			);
			let specStrength = wax * 0.14 + wet * 0.40 + taut * 0.28
				+ crystal * 0.42 + porous * 0.06;
			let diffuseStrength = wax * 0.92 + wet * 0.66 + taut * 0.72
				+ crystal * 0.66 + porous * 0.90;
			let detailShade = clamp(
				0.96 + ridgeRelief - pore * porous * 0.22,
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
			let rimFresnel = pow(1.0 - cosNV, 4.4);
			let direct = keyTint * (0.075 + cosNL * 0.925) * shadow * keyStrength;
			let fill = fillTint * cosNF * fillStrength;
			let ambient = ambientTint * (0.23 + max(n.y, 0.0) * 0.19) * (0.74 + ao * 0.26);
			// AO still carves the fractal, but it can no longer erase all pigment and
			// leave only a pale rim/specular shell behind.
			let bodyAo = 0.24 + ao * 0.76;
			let diffuse = baseCol * (direct + fill + ambient)
				* bodyAo * detailShade * diffuseStrength * mix(0.90, 1.06, density);

			let specPow = mix(52.0, 10.0, roughness);
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
			let reflectionStrength = wet * 0.22 + taut * 0.08 + crystal * 0.28 + wax * 0.03;
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
			var surfaceCol = (diffuse + specularCol + rim + bodyFill) * impactGain + crevice;
			// A pigment-first exposure ceiling keeps white as a small highlight. It is
			// chroma-preserving: the whole RGB vector is scaled instead of clamped.
			var surfaceLuma = max(
				dot(surfaceCol, vec3<f32>(0.2126, 0.7152, 0.0722)),
				0.0001
			);
			let surfaceChroma = max(surfaceCol.r, max(surfaceCol.g, surfaceCol.b))
				- min(surfaceCol.r, min(surfaceCol.g, surfaceCol.b));
			let lowChromaRecovery = (1.0 - smoothstep(0.07, 0.22, surfaceChroma))
				* smoothstep(0.20, 0.58, surfaceLuma);
			let recoveryPigment = mix(deepPigment, chromaticAnchor, 0.72);
			surfaceCol = mix(
				surfaceCol,
				recoveryPigment * (0.58 + density * 0.30),
				lowChromaRecovery * 0.88
			);
			// Reassert broad material territories after highlight recovery so a pale
			// rescue cannot flatten mineral plates, velvet mottling, or membrane color
			// into one uniform pastel. This field is evaluated in organism space and
			// remains multiplied by the real key light.
			let litMaterialTone = mix(0.58, 1.30, broadPigment);
			let litMaterialPigment = palette7(
				surfacePalette + 0.12 + broadPigment * 0.46 + anatomicalNoise * 0.12
			) * (0.19 + cosNL * 0.15 + bodyAo * 0.08);
			surfaceCol = mix(
				surfaceCol * litMaterialTone,
				litMaterialPigment,
				(1.0 - broadPigment) * (
					0.09 + mineralDNA * 0.16 + velvetDNA * 0.12 + crystalDNA * 0.08
				)
			);
			let litPigmentLuma = dot(surfaceCol, vec3<f32>(0.2126, 0.7152, 0.0722));
			surfaceCol = max(
				mix(vec3<f32>(litPigmentLuma), surfaceCol, 1.16),
				vec3<f32>(0.0)
			);
			surfaceLuma = max(
				dot(surfaceCol, vec3<f32>(0.2126, 0.7152, 0.0722)),
				0.0001
			);
			let lightingShoulder = 0.115 + crystal * 0.020 + wet * 0.015 + u.rootPulse * 0.009;
			let compressedLuma = lightingShoulder * (1.0 - exp(-surfaceLuma / lightingShoulder));
			surfaceCol = surfaceCol * (compressedLuma / surfaceLuma);
			surfaceCol = surfaceCol + specularCol * 0.022 + rim * 0.014;
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
		previousT = t;
		previousD = d;
		let stepSize = select(
			max(d * 0.52, 0.0085),
			max(d * 0.72, 0.035),
			d > 0.32
		);
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
	let current = scene + bloom * 0.32;
	// A trace of continuity softens raymarch shimmer without holding an old
	// lighting arrangement over a new perspective.
	let blended = mix(current, prev, 0.025);
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
	let texel = 1.0 / vec2<f32>(textureDimensions(compositeTex));
	let center = textureSample(compositeTex, samp, uv).rgb;
	let crossBlur = (
		textureSample(compositeTex, samp, uv + vec2<f32>(texel.x, 0.0)).rgb
		+ textureSample(compositeTex, samp, uv - vec2<f32>(texel.x, 0.0)).rgb
		+ textureSample(compositeTex, samp, uv + vec2<f32>(0.0, texel.y)).rgb
		+ textureSample(compositeTex, samp, uv - vec2<f32>(0.0, texel.y)).rgb
	) * 0.25;
	// Mild contrast-adaptive-style reconstruction restores definition after the
	// quality scaler without ringing the already bright fractal highlights.
	var col = max(center + (center - crossBlur) * 0.10, vec3<f32>(0.0));

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

	type GPU = {
		device: GPUDevice;
		context: GPUCanvasContext;
		format: GPUTextureFormat;
		sampler: GPUSampler;
		uniformBuf: GPUBuffer;
		uniformData: Float32Array;
		bloomParamBuf: GPUBuffer;
		bloomParamData: Float32Array;
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
	let qualityProfile: SomaQualityProfile = SOMA_QUALITY_PROFILES.ultra;
	const autoQuality = new SomaAutoQualityController(qualityProfile.tier);
	let autoQualityCeiling: SomaQualityTier | null = null;
	let targetFrameMs = 1000 / qualityProfile.frameRate;
	let schedulerTickAt = 0;
	let renderBudgetMs = targetFrameMs;
	let lastRenderedAt = 0;

	function resetFrameScheduler() {
		schedulerTickAt = 0;
		renderBudgetMs = targetFrameMs;
		lastRenderedAt = 0;
	}

	function updateQualityProfile(elapsedMs: number | null): SomaQualityProfile {
		if (!canvas) return qualityProfile;
		const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
		const initial = selectSomaQuality(
			canvas.clientWidth,
			canvas.clientHeight,
			window.devicePixelRatio || 1,
			navigator.hardwareConcurrency,
			deviceMemory
		);
		let sampleMs = elapsedMs;
		if (autoQualityCeiling === null) {
			autoQuality.reset(initial.tier);
			autoQualityCeiling = initial.tier;
			sampleMs = null;
		} else if (initial.tier !== autoQualityCeiling) {
			autoQuality.setCeiling(initial.tier);
			autoQualityCeiling = initial.tier;
			// A viewport workload change is not a performance sample. In particular,
			// resizing must not combine with an almost-finished downgrade vote.
			sampleMs = null;
		}
		if (sampleMs !== null && document.visibilityState === 'visible') {
			autoQuality.observeFrame(sampleMs);
		}

		const active = autoQuality.profile;
		if (active.tier !== qualityProfile.tier) {
			qualityProfile = active;
			qualityTier = active.tier;
			targetFrameMs = 1000 / active.frameRate;
			resetFrameScheduler();
			temporalResetRequested = true;
		}
		return qualityProfile;
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
		const { device, pipelines, uniformBuf, bloomParamBuf, sampler, targets } = g;
		const scene = device.createBindGroup({
			layout: pipelines.scene.getBindGroupLayout(0),
			entries: [{ binding: 0, resource: { buffer: uniformBuf } }]
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

		return {
			device,
			context,
			format,
			sampler,
			uniformBuf,
			uniformData: new Float32Array(UNIFORM_FLOATS),
			bloomParamBuf,
			bloomParamData: new Float32Array(BLOOM_PARAM_FLOATS),
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
		if (!canvas) return;
		if (!gpu) {
			const diagnosticJourney = vis.getJourney(frameNow);
			currentSection = diagnosticJourney.director.section;
			currentForm = dominantLifecycleForm(diagnosticJourney.mk2);
			return;
		}

		if (!schedulerTickAt) {
			schedulerTickAt = frameNow;
			renderBudgetMs = targetFrameMs;
		} else {
			const tickElapsed = Math.max(0, frameNow - schedulerTickAt);
			schedulerTickAt = frameNow;
			// Accumulate refresh intervals instead of phase-adjusting the previous
			// render timestamp. Keep only a small catch-up budget so a stalled or
			// backgrounded window renders one current frame, never an obsolete burst.
			renderBudgetMs = Math.min(targetFrameMs * 4, renderBudgetMs + tickElapsed);
		}
		if (renderBudgetMs + 0.25 < targetFrameMs) return;
		// Carry fractional refresh time forward. Subtract first to avoid a value
		// microscopically below one interval wrapping to an almost-full budget.
		let remainderMs = renderBudgetMs - targetFrameMs;
		if (remainderMs >= targetFrameMs) remainderMs %= targetFrameMs;
		renderBudgetMs = Math.max(0, remainderMs);

		// This is the actual time between rendered frames, independent of the
		// scheduler's fractional budget, so smoothing remains time-correct on
		// 60/75/90/120/144 Hz displays and after an occasional missed frame.
		const hadPreviousRender = lastRenderedAt !== 0;
		const elapsedMs = hadPreviousRender
			? Math.max(0, frameNow - lastRenderedAt)
			: targetFrameMs;
		lastRenderedAt = frameNow;
		const frameDt = Math.min(1, Math.max(0.001, elapsedMs / 1000));

		const activeQuality = updateQualityProfile(hadPreviousRender ? elapsedMs : null);
		const { width: w, height: h } = somaBackingSize(
			canvas.clientWidth,
			canvas.clientHeight,
			window.devicePixelRatio || 1,
			activeQuality
		);
		const nextRenderPixels = w * h;
		if (renderPixels !== nextRenderPixels) renderPixels = nextRenderPixels;
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}

		// Bind the current source epoch before preserving or recreating temporal
		// targets. A track switch must never present one frame of the previous
		// source's composite history.
		const feat = vis.getLatest(frameNow);
		const shared = vis.getJourney(frameNow);
		const time = shared.timelineSeconds;
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
			5.25,
			Math.min(
				7.35,
				5.55 +
					journey.topologyCoral * 1.0 +
					journey.topologyShell * 0.52 +
					journey.topologyBilateral * 0.2 +
					journey.topologyBias * 0.35 +
					smoothed.mid * 0.12
			)
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
		let cameraOrbit = Math.pow(Math.max(0, journey.cameraOrbit), 1.75);
		let cameraProfile = Math.pow(Math.max(0, journey.cameraProfile), 1.75);
		let cameraOverhead = Math.pow(Math.max(0, journey.cameraOverhead), 1.75);
		let cameraLow = Math.pow(Math.max(0, journey.cameraLow), 1.75);
		let cameraMacro = Math.pow(Math.max(0, journey.cameraMacro), 1.75);
		const cameraWeightSum = Math.max(
			0.0001,
			cameraOrbit + cameraProfile + cameraOverhead + cameraLow + cameraMacro
		);
		cameraOrbit /= cameraWeightSum;
		cameraProfile /= cameraWeightSum;
		cameraOverhead /= cameraWeightSum;
		cameraLow /= cameraWeightSum;
		cameraMacro /= cameraWeightSum;
		// Combine a safe dolly with a mild optical push. Even at the closest
		// elected study the camera remains outside the organism's scene bound.
		const dollyScale = 1 / (1 + zoomDelta * 0.47);
		const shotLens =
			cameraOrbit * 1.54 +
			cameraProfile * 1.7 +
			cameraOverhead * 1.82 +
			cameraLow * 1.46 +
			cameraMacro * 1.94;
		const macroStudyRamp = Math.max(0, Math.min(1, (closeStudy - 0.32) / 0.46));
		const intentionalMacro = Math.max(
			0,
			Math.min(1, cameraMacro * macroStudyRamp * (0.72 + detailFocus * 0.28))
		);
		const spireDNA = Math.pow(Math.max(0, journey.topologySpire), 1.8);
		const coralDNA = Math.pow(Math.max(0, journey.topologyCoral), 1.8);
		const requestedFovScale =
			(shotLens + mk2SongSeed * 0.08) * (1 + zoomDelta * 0.12);
		// Ordinary hero shots always fit the elected anatomy. A genuinely elected
		// close study progressively releases this optical pullback, preserving the
		// occasional frame-filling material view without making it a genre default.
		const fovScale =
			requestedFovScale /
			(1 +
				(spireDNA * 0.42 + coralDNA * (0.12 + journey.filamentReach * 0.08)) *
					(1 - intentionalMacro));

		// The camera follows a continuous path at the conductor's physical rate.
		// Harmony can gently reframe the target, but phrases and drops never add
		// accumulated offsets and impacts never shake the camera.
		const sessionTargetY =
			-0.05 +
			(mk2SongSeed - 0.5) * 0.1 +
			journey.topologySpire * (0.04 - journey.rootMass * 0.13) -
			journey.topologyTorus * 0.1;
		const sessionRoll =
			(mk2SongSeed - 0.5) * 0.18 +
			cameraProfile * 0.1 -
			cameraLow * 0.08;
		const camPosRaw = getCameraPos(
			journey.cameraPhase,
			journey.perspectiveAzimuth,
			journey.perspectiveElevation,
			cameraOrbit,
			cameraProfile,
			cameraOverhead,
			cameraLow,
			cameraMacro
		);
		const requestedCameraScale = journey.cameraDistance * dollyScale;
		const rawCameraRadius = Math.hypot(camPosRaw[0], camPosRaw[1], camPosRaw[2]) || 1;
		const bilateralDNA = Math.pow(Math.max(0, journey.topologyBilateral), 1.8);
		const subjectHalfExtent =
			0.82 +
			spireDNA * (1.65 + journey.axialStretch * 0.50 + journey.rootMass * 0.18) +
			coralDNA * (0.55 + journey.filamentReach * 0.40) +
			bilateralDNA * 0.15;
		// uv.y spans only -0.5..0.5, so fitting a projected radius takes roughly
		// 2 * lensScale * radius. Keep a small compositional margin as well.
		const heroFitDistance = Math.max(3.2, subjectHalfExtent * fovScale * 2.45);
		const macroFitDistance = 2.68 + spireDNA * 0.38 + coralDNA * 0.16;
		const minimumCameraDistance = lerp(heroFitDistance, macroFitDistance, intentionalMacro);
		// getCameraPos() restores a safe radius before the dolly. Re-apply the guard
		// after every scale so zoom can never put the camera inside the ~2.53 scene
		// envelope, and use topology extents to keep non-macro subjects in frame.
		const cameraScale = Math.max(
			requestedCameraScale,
			minimumCameraDistance / rawCameraRadius
		);
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
		// A stable primary world preserves identity. Long-horizon mix character
		// chooses its complementary world, so bass-heavy, bright/noisy, crystalline,
		// and tonal recordings stop converging on the same blue/purple treatment.
		const primaryPaletteFamily = Math.min(7, Math.floor(mk2SongSeed * 8));
		let secondaryPaletteFamily = 6;
		if (journey.styleLowHighTilt < -0.18) secondaryPaletteFamily = 3;
		else if (journey.materialCrystal > 0.38) secondaryPaletteFamily = 5;
		else if (journey.stylePercussiveness > 0.58) secondaryPaletteFamily = 2;
		else if (journey.styleTonality > 0.64) secondaryPaletteFamily = 7;
		else if (journey.styleLowHighTilt > 0.24) secondaryPaletteFamily = 4;
		if (secondaryPaletteFamily === primaryPaletteFamily) {
			secondaryPaletteFamily = (secondaryPaletteFamily + 3) % 8;
		}
		u[32] = primaryPaletteFamily;
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
		u[71] = qualityProfile.raymarchSteps;
		u[72] = journey.topologyCocoon;
		u[73] = journey.topologySpire;
		u[74] = journey.topologyBilateral;
		u[75] = journey.topologyTorus;
		u[76] = journey.topologyCoral;
		u[77] = journey.topologyShell;
		u[78] = journey.environmentVoid;
		u[79] = journey.environmentCurrent;
		u[80] = journey.environmentCavern;
		u[81] = journey.environmentHorizon;
		u[82] = journey.environmentCellular;
		u[83] = journey.materialMembrane;
		u[84] = journey.materialMineral;
		u[85] = journey.materialVelvet;
		u[86] = journey.materialCrystal;
		u[87] = secondaryPaletteFamily;
		u[88] = Math.min(
			0.62,
			0.22 +
				Math.abs(journey.styleLowHighTilt) * 0.12 +
				journey.environmentHorizon * 0.12 +
				journey.environmentCellular * 0.1 +
				journey.materialCrystal * 0.14 +
				(Math.sin(journey.backgroundFlowPhase * 0.18 + mk2SongSeed * Math.PI * 2) * 0.5 +
					0.5) *
					0.12
		);
		u[89] = qualityProfile.tier === 'ultra' ? 1 : qualityProfile.tier === 'balanced' ? 0.62 : 0.28;
		u[90] = 0;
		u[91] = 0;
		gpu.device.queue.writeBuffer(gpu.uniformBuf, 0, u.buffer, u.byteOffset, u.byteLength);

		// ── Pack bloom params for five passes (3 down + 2 up).
		// Each slice is 256-byte aligned (WebGPU minimum dynamic uniform alignment).
		const bloomThreshold = 1.34; // reserve bloom for real highlights, not pale bodies
		const bloomIntensity = 0.22; // restrained contribution per upsample
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
			data-soma-quality={qualityTier}
			data-soma-ready={gpuReady}
			data-soma-render-pixels={renderPixels}
			data-soma-max-pixels={SOMA_QUALITY_PROFILES[qualityTier].maxPixels}
			data-soma-frame-rate={SOMA_QUALITY_PROFILES[qualityTier].frameRate}
			data-soma-raymarch-steps={SOMA_QUALITY_PROFILES[qualityTier].raymarchSteps}
		></canvas>
		{#if errorMsg}
			<div class="pointer-events-none absolute left-6 top-16 z-30 max-w-md text-xs text-red-300/80">
				Visualizer error: {errorMsg}
			</div>
		{/if}
	</div>
{/if}
