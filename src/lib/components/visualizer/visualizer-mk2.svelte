<script lang="ts">
	// Soma (engine id mk2) — "Abyssal Bloom"
	//
	// A dark bioluminescent deep-sea organism in ink-dark water.
	//   • Hero: a raymarched translucent bell (front and far wall both shaded)
	//     with fresnel membrane light, radial canals, ctenophore comb rows,
	//     marginal photophores and organs glowing through the tissue.
	//   • Tendrils and oral arms are analytic glowing filaments that trail the
	//     swimming bell; beats launch light packets that travel from the apex
	//     down the canals and out along the tendrils. Percussion is local light,
	//     never a whole-frame flash and never whole-body motion.
	//   • The organism swims between seeded half-phrase waypoints on alternating
	//     sides of the shot (see mk2/organism.ts), leaning apex-first into travel.
	//   • Environment that belongs to the subject: depth haze, slow light shafts
	//     the organism shadows, marine snow lit by its glow for scale and
	//     parallax, distant pinnacles, and a silt floor with brine pools that
	//     mirror it and catch a pool of its light.
	//   • Lifecycle forms change anatomy: seed is compact, sprout tall, winding
	//     twists canals and coils tendrils, bloom opens a wide scalloped bell,
	//     shedding erodes the margin and releases glowing buds, dormancy sinks.
	//   • Post stack (8 passes): scene, temporal feedback (max-blend), half-res
	//     bloom prefilter, two separable blur rounds, composite with barrel lens,
	//     chromatic aberration, ACES and interleaved-gradient dither.
	//
	// Audio routing: smoothed energy drives swim strokes and tendril undulation;
	// bass/rootPulse light the organs and the floor pool; mids widen tendril
	// waves; treble sparkles photophores and plankton; beats move light packets;
	// phrase position re-drafts tendril lengths and sheds buds; key/mode choose
	// palette roles. Elapsed time is packed nowhere.

	import { onMount, onDestroy } from 'svelte';
	import {
		VISUALIZER_RESPONSE_PROFILES,
		useVisualizer,
		type VisualizerJourneySnapshot
	} from '$lib/state/visualizer.svelte';
	import type { Mk2ConductorFrame } from '$lib/visualizer/mk2/conductor';
	import {
		SOMA_QUALITY_PROFILES,
		SomaAutoQualityController,
		selectSomaQuality,
		somaBackingSize,
		somaFrameStride,
		type SomaQualityProfile,
		type SomaQualityTier
	} from '$lib/visualizer/mk2/runtime';
	import {
		SomaSwimmer,
		somaHueDelta,
		somaPaletteRoles,
		type SomaPaletteRoles,
		type SomaVec3
	} from '$lib/visualizer/mk2/organism';

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
	// Per-track identity seed: the same song grows the same organism (camera
	// identity, bell lobes, palette lean) and every song gets a different one.
	let mk2SongSeed = 0.5;
	let rendererSourceEpoch = -1;
	let rendererSyncRequested = true;
	let poseSyncRequested = true;

	let temporalResetRequested = true;
	/** Frames left during which the feedback trail is cleared (source reset, resize). */
	let feedbackResetFrames = 2;
	let currentSection = $state('intro');
	let currentForm = $state('seed');
	let currentGesture = $state('reach');
	let qualityTier = $state<SomaQualityTier>('ultra');
	let renderPixels = $state(0);
	let renderStride = $state(1);
	let measuredRefreshRate = $state(60);
	/** Organism centre in normalized screen space (-1..1), refreshed four times a second. */
	let bodyScreen = $state('0.00,0.00');
	let bodyScreenX = 0;
	let bodyScreenY = 0;
	let bodyScreenTimer = 0;

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
	// Audio smoothing — fast rails stay local (organs, packets, photophores);
	// slow rails steer swimming and the light rig.
	// ──────────────────────────────────────────────────────────────────────────
	const smoothed = {
		bass: 0,
		mid: 0,
		treble: 0,
		energy: 0,
		impact: 0,
		rootPulse: 0,
		rms: 0,
		silence: 1,
		quietFor: 0,
		beatGlow: 0,
		responseMotion: 1,
		responseImpact: 1,
		responseFog: 1,
		responseShafts: 1
	};
	const renderDetailBins = new Float32Array(64);
	const BEATS_PER_PHRASE = 32;
	let renderBeats = 0;
	let renderBpm = 120;

	function lerp(a: number, b: number, t: number) {
		return a + (b - a) * t;
	}

	function clamp(value: number, low: number, high: number) {
		return Math.min(high, Math.max(low, value));
	}

	function approach(current: number, target: number, rate: number, dt: number) {
		return current + (target - current) * (1 - Math.exp(-rate * dt));
	}

	function approachHue(current: number, target: number, rate: number, dt: number) {
		const delta = somaHueDelta(current, target);
		return (((current + delta * (1 - Math.exp(-rate * dt))) % 1) + 1) % 1;
	}

	// Analyzer events arrive at roughly 60 Hz and are not phase-locked to the
	// display. Interpolate every macro rail at render cadence, while advancing
	// unbounded phases continuously.
	const RENDER_POSE_KEYS = [
		'growth',
		'tension',
		'openness',
		'suspense',
		'seedForm',
		'sproutForm',
		'windingForm',
		'bloomForm',
		'sheddingForm',
		'dormancyForm',
		'rootMass',
		'axialStretch',
		'lobeSplit',
		'foldDepth',
		'cavityOpen',
		'surfaceRidges',
		'filamentReach',
		'spectralLean',
		'morphRate',
		'spectralTravelRate',
		'backgroundFlow',
		'materialDensity',
		'materialIridescence',
		'materialErosion',
		'shotZoom',
		'closeStudy',
		'detailFocus',
		'perspectiveAzimuth',
		'perspectiveElevation',
		'shotFramingX',
		'shotFramingY',
		'cameraDistance',
		'fogDensity',
		'shaftIntensity',
		'environmentVoid',
		'environmentCurrent',
		'environmentCavern',
		'environmentHorizon',
		'environmentCellular',
		'materialMembrane',
		'materialMineral',
		'materialVelvet',
		'materialCrystal',
		'topologyCocoon',
		'topologySpire',
		'topologyBilateral',
		'topologyTorus',
		'topologyCoral',
		'topologyShell',
		'cameraOrbit',
		'cameraProfile',
		'cameraOverhead',
		'cameraLow',
		'cameraMacro',
		'gestureReach',
		'gestureCoil',
		'gestureDivide',
		'gestureHollow',
		'gestureStillness',
		'styleRhythmicDensity'
	] as const satisfies readonly (keyof Mk2ConductorFrame)[];
	type RenderPoseKey = (typeof RENDER_POSE_KEYS)[number];
	const renderPose = Object.fromEntries(RENDER_POSE_KEYS.map((key) => [key, 0])) as Record<
		RenderPoseKey,
		number
	>;
	const CAMERA_POSE_KEYS = new Set<RenderPoseKey>([
		'shotZoom',
		'closeStudy',
		'detailFocus',
		'perspectiveAzimuth',
		'perspectiveElevation',
		'shotFramingX',
		'shotFramingY',
		'cameraDistance',
		'cameraOrbit',
		'cameraProfile',
		'cameraOverhead',
		'cameraLow',
		'cameraMacro'
	]);
	const renderPhases = {
		backgroundFlowPhase: 0,
		morphPhase: 0,
		spectralTravelPhase: 0
	};

	function updateRenderPose(journey: Readonly<Mk2ConductorFrame>, dt: number) {
		if (poseSyncRequested) {
			for (const key of RENDER_POSE_KEYS) renderPose[key] = journey[key];
			renderPhases.backgroundFlowPhase = journey.backgroundFlowPhase;
			renderPhases.morphPhase = journey.morphPhase;
			renderPhases.spectralTravelPhase = journey.spectralTravelPhase;
			poseSyncRequested = false;
			return renderPose;
		}
		for (const key of RENDER_POSE_KEYS) {
			const tau = CAMERA_POSE_KEYS.has(key) ? 0.2 : 0.13;
			const smoothing = 1 - Math.exp(-dt / tau);
			renderPose[key] = lerp(renderPose[key], journey[key], smoothing);
		}
		renderPhases.backgroundFlowPhase += renderPose.backgroundFlow * dt;
		renderPhases.morphPhase += renderPose.morphRate * dt;
		renderPhases.spectralTravelPhase += renderPose.spectralTravelRate * dt;
		return renderPose;
	}

	// ──────────────────────────────────────────────────────────────────────────
	// Camera placement is a held musical shot. Phrase rails interpolate between
	// compositions; elapsed time never orbits, breathes, or nudges the camera.
	// The organism swims through the held shot; the camera aim only follows it
	// part of the way, so it travels across the frame instead of being centred.
	// ──────────────────────────────────────────────────────────────────────────
	function getCameraPos(
		perspectiveAzimuth: number,
		perspectiveElevation: number,
		cameraOrbit: number,
		cameraProfile: number,
		cameraOverhead: number,
		cameraLow: number,
		cameraMacro: number
	): [number, number, number] {
		const seedAngle = mk2SongSeed * Math.PI * 2;
		const azimuth =
			seedAngle +
			perspectiveAzimuth +
			cameraProfile * 0.22 -
			cameraLow * 0.08;
		const baseRadius =
			(3.15 + (mk2SongSeed - 0.5) * 0.2) *
			(1 + cameraOrbit * 0.035 + cameraOverhead * 0.055 - cameraMacro * 0.025);
		const radius = baseRadius * Math.cos(perspectiveElevation * 0.82);
		const sideDrift =
			(mk2SongSeed - 0.5) * 2 * (0.1 + cameraOrbit * 0.06 + cameraProfile * 0.05);
		const altitudeBias =
			cameraOverhead * 0.6 - cameraLow * 0.45 + cameraProfile * 0.1 - cameraMacro * 0.08;
		return [
			Math.cos(azimuth) * radius + Math.cos(azimuth * 0.37 + seedAngle) * sideDrift,
			0.62 + Math.sin(perspectiveElevation) * baseRadius * 0.62 + altitudeBias,
			Math.sin(azimuth) * radius + Math.sin(azimuth * 0.41 - seedAngle) * sideDrift
		];
	}

	function dominantGesture(journey: VisualizerJourneySnapshot['mk2']): string {
		const gestures = [
			['reach', journey.gestureReach],
			['coil', journey.gestureCoil],
			['divide', journey.gestureDivide],
			['hollow', journey.gestureHollow],
			['stillness', journey.gestureStillness]
		] as const;
		let dominant: (typeof gestures)[number] = gestures[0];
		for (const gesture of gestures) if (gesture[1] > dominant[1]) dominant = gesture;
		return dominant[0];
	}

	const swimmer = new SomaSwimmer();
	const paletteRoles: SomaPaletteRoles = { base: 0.5, accent: 0.86, rim: 0.31, ink: 0.665, saturation: 0.85 };
	const renderRoles: SomaPaletteRoles = { ...paletteRoles };
	const cameraTarget: SomaVec3 = [0, -0.1, 0];

	function beatAnchor(clock: VisualizerJourneySnapshot['director']['clock']) {
		if (!Number.isFinite(clock.phraseIndex) || !Number.isFinite(clock.phrasePos)) return null;
		return clock.phraseIndex * BEATS_PER_PHRASE + clock.phrasePos * BEATS_PER_PHRASE;
	}

	function syncRendererToJourney(snapshot: VisualizerJourneySnapshot) {
		if (snapshot.sourceEpoch === rendererSourceEpoch) return;
		rendererSourceEpoch = snapshot.sourceEpoch;
		mk2SongSeed = snapshot.seed;
		currentSection = snapshot.director.section;
		renderBeats = beatAnchor(snapshot.director.clock) ?? 0;
		swimmer.reset(mk2SongSeed);
		rendererSyncRequested = true;
		poseSyncRequested = true;
		temporalResetRequested = true;
		feedbackResetFrames = 2;
		resetFrameScheduler();
	}

	// ──────────────────────────────────────────────────────────────────────────
	// Uniform layout — 96 f32s = 384 bytes, 24 rows of four. vec3 rows carry a
	// scalar in their fourth lane. The same struct is declared by every pass.
	// ──────────────────────────────────────────────────────────────────────────
	const UNIFORM_FLOATS = 96;
	const UNIFORM_BYTES = UNIFORM_FLOATS * 4;

	const UNIFORMS_WGSL = /* wgsl */ `
struct Uniforms {
	resX: f32, resY: f32, envCavern: f32, qualitySteps: f32,
	bass: f32, mid: f32, treble: f32, envCellular: f32,
	energy: f32, impact: f32, rootPulse: f32, beatGlow: f32,
	beatConveyor: f32, envHorizon: f32, contraction: f32, silence: f32,
	camPos: vec3<f32>, fovScale: f32,
	camFwd: vec3<f32>, envCurrent: f32,
	camRight: vec3<f32>, seed: f32,
	camUp: vec3<f32>, phrase: f32,
	bodyPos: vec3<f32>, bodyScale: f32,
	basisX: vec3<f32>, topoCoral: f32,
	basisY: vec3<f32>, wavePhase: f32,
	basisZ: vec3<f32>, topoSpire: f32,
	localVel: vec3<f32>, keyMode: f32,
	hueBase: f32, hueAccent: f32, hueRim: f32, saturation: f32,
	hueInk: f32, topoShell: f32, topoTorus: f32, matCrystal: f32,
	seedForm: f32, sproutForm: f32, windingForm: f32, bloomForm: f32,
	sheddingForm: f32, dormancyForm: f32, evolution: f32, matVelvet: f32,
	rootMass: f32, axialStretch: f32, lobeSplit: f32, foldDepth: f32,
	cavityOpen: f32, surfaceRidges: f32, filamentReach: f32, spectralLean: f32,
	density: f32, iridescence: f32, erosion: f32, growth: f32,
	reach: f32, coil: f32, divide: f32, hollow: f32,
	stillness: f32, tension: f32, openness: f32, suspense: f32,
	fogDensity: f32, shaftIntensity: f32, backgroundPhase: f32, rhythmicDensity: f32,
	feedbackFade: f32, feedbackZoom: f32, bloomThreshold: f32, aberration: f32,
};
`;

	const SHARED_WGSL = /* wgsl */ `
const TAU: f32 = 6.28318530718;

fn hsv(h: f32, s: f32, v: f32) -> vec3<f32> {
	let p = abs(fract(vec3<f32>(h) + vec3<f32>(0.0, 0.6666667, 0.3333333)) * 6.0 - 3.0);
	return v * mix(vec3<f32>(1.0), clamp(p - 1.0, vec3<f32>(0.0), vec3<f32>(1.0)), s);
}

fn mixHue(a: f32, b: f32, amount: f32) -> f32 {
	let delta = fract(b - a + 0.5) - 0.5;
	return fract(a + delta * amount);
}

fn ign(pixel: vec2<f32>) -> f32 {
	return fract(52.9829189 * fract(dot(pixel, vec2<f32>(0.06711056, 0.00583715))));
}
`;

	const SCENE_WGSL = /* wgsl */ `
${UNIFORMS_WGSL}
${SHARED_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> bins: array<f32, 64>;
@group(0) @binding(2) var historySampler: sampler;
@group(0) @binding(3) var historyTex: texture_2d<f32>;

const FLOOR_Y: f32 = -1.85;
const TENDRIL_SEGMENTS: i32 = 14;
const ORAL_ARMS: i32 = 4;

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
	var positions = array<vec2<f32>, 3>(
		vec2<f32>(-1.0, -1.0),
		vec2<f32>( 3.0, -1.0),
		vec2<f32>(-1.0,  3.0)
	);
	return vec4<f32>(positions[index], 0.0, 1.0);
}

// ── Hashes and noise ──────────────────────────────────────────────────────
fn h21(p: vec2<f32>) -> f32 {
	var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
	p3 = p3 + dot(p3, p3.yzx + 33.33);
	return fract((p3.x + p3.y) * p3.z);
}

fn hashLane(n: f32, lane: f32) -> f32 {
	return h21(vec2<f32>(n + u.seed * 613.0, lane * 7.31 + 19.0));
}

fn vn2(p: vec2<f32>) -> f32 {
	let i = floor(p);
	let f = fract(p);
	let w = f * f * (3.0 - 2.0 * f);
	let a = h21(i);
	let b = h21(i + vec2<f32>(1.0, 0.0));
	let c = h21(i + vec2<f32>(0.0, 1.0));
	let d = h21(i + vec2<f32>(1.0, 1.0));
	return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
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

fn sdEllipsoid(p: vec3<f32>, radii: vec3<f32>) -> f32 {
	let r = max(radii, vec3<f32>(0.004));
	let k0 = length(p / r);
	let k1 = max(length(p / (r * r)), 1e-5);
	return k0 * (k0 - 1.0) / k1;
}

fn sdCapsule(p: vec3<f32>, a: vec3<f32>, b: vec3<f32>, radius: f32) -> f32 {
	let pa = p - a;
	let ba = b - a;
	let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
	return length(pa - ba * h) - radius;
}

// ── Palette roles: water is ink, the organism is bioluminescent ───────────
fn baseCol() -> vec3<f32> { return hsv(u.hueBase, u.saturation, 1.0); }
fn accentCol() -> vec3<f32> { return hsv(u.hueAccent, u.saturation, 1.0); }
fn rimCol() -> vec3<f32> { return hsv(u.hueRim, u.saturation * 0.92, 1.0); }
fn inkCol(v: f32) -> vec3<f32> { return hsv(u.hueInk, 0.8, v); }

fn packetEnergy() -> f32 {
	return (0.45 + u.energy * 0.9 + u.beatGlow * 0.55 + u.impact * 1.5) * (1.0 - u.silence * 0.9);
}

// Light emitted at distance t is partly absorbed by the water column.
fn absorb(t: f32) -> f32 {
	return exp(-t * u.fogDensity * 1.6);
}

// ── Organism frame ────────────────────────────────────────────────────────
fn toLocal(p: vec3<f32>) -> vec3<f32> {
	let d = p - u.bodyPos;
	return vec3<f32>(dot(d, u.basisX), dot(d, u.basisY), dot(d, u.basisZ)) / u.bodyScale;
}

fn toWorld(l: vec3<f32>) -> vec3<f32> {
	return u.bodyPos + (u.basisX * l.x + u.basisY * l.y + u.basisZ * l.z) * u.bodyScale;
}

// x: bell radius, y: dome height, z: lobe/canal count, w: margin height.
fn bellShape() -> vec4<f32> {
	let radius = 0.5 + u.bloomForm * 0.17 + u.lobeSplit * 0.05 + u.rootMass * 0.04
		- u.dormancyForm * 0.12 - u.sproutForm * 0.06 - u.seedForm * 0.07 - u.topoSpire * 0.08;
	let height = 0.38 + u.sproutForm * 0.2 + u.axialStretch * 0.1 + u.topoSpire * 0.2
		+ u.seedForm * 0.05 - u.bloomForm * 0.09 - u.dormancyForm * 0.07;
	let lobes = 8.0 + 4.0 * floor(fract(u.seed * 7.31) * 3.0);
	return vec4<f32>(radius, height, lobes, -0.55 * height);
}

fn twistRate() -> f32 {
	return u.windingForm * 1.5 + u.coil * 1.1 + u.topoShell * 0.8 + u.tension * 0.25;
}

fn organismWarp(p: vec3<f32>) -> vec3<f32> {
	var q = toLocal(p);
	// CPU-integrated morph clock. It reshapes tissue from within and never
	// moves, spins or scales the whole subject; swimming owns placement.
	let evolutionPhase = u.evolution;
	let seedPhase = u.seed * TAU;
	// Swim stroke: the margin squeezes inward and the dome lengthens.
	let c = u.contraction;
	let marginZone = smoothstep(0.2, -0.45, q.y);
	let squeeze = 1.0 + c * (0.06 + marginZone * 0.2);
	q = vec3<f32>(q.x * squeeze, q.y / (1.0 + c * 0.06), q.z * squeeze);
	// Winding and coil wind the canals around the axis.
	let twisted = rot2(q.xz, q.y * twistRate());
	q = vec3<f32>(twisted.x, q.y, twisted.y);
	let drift = vec3<f32>(
		sin(q.y * 2.3 + evolutionPhase * 0.41 + seedPhase) * 0.035
			+ cos(q.z * 1.7 - evolutionPhase * 0.23) * 0.02,
		sin(q.x * 2.1 - evolutionPhase * 0.29 + seedPhase * 0.7) * 0.025,
		cos(q.y * 1.9 + evolutionPhase * 0.33 + seedPhase * 1.3) * 0.035
	);
	return q + drift * (0.6 + u.growth * 0.8 + u.sproutForm * 0.5 + u.sheddingForm * 0.6
		+ u.erosion * 0.3 - u.stillness * 0.4);
}

fn bellSDF(q0: vec3<f32>, shape: vec4<f32>) -> f32 {
	var q = q0;
	// Divide buds the bell into twin lobes side by side.
	let split = clamp(u.divide * 0.9, 0.0, 0.85);
	if (split > 0.001) { q.x = abs(q.x) - shape.x * 0.55 * split; }
	let radius = shape.x * (1.0 - split * 0.3);
	let height = shape.y * (1.0 - split * 0.15);
	// Spire sharpens the apex into a tall cone.
	let apex = max(q.y, 0.0) / height;
	let sharpen = 1.0 + u.topoSpire * apex * apex * 1.6;
	let ang = atan2(q.z, q.x);
	let margin = smoothstep(0.05 * height, -0.55 * height, q.y);
	let scallop = 1.0 + margin * (0.05 + u.bloomForm * 0.07 + u.lobeSplit * 0.03) * cos(ang * shape.z);
	let xz = q.xz * sharpen / scallop;
	let p = vec3<f32>(xz.x, q.y, xz.y);
	let outer = sdEllipsoid(p, vec3<f32>(radius, height, radius));
	let thin = 0.84 + u.hollow * 0.07 - u.density * 0.04 - u.sproutForm * 0.14 - u.seedForm * 0.1 - u.dormancyForm * 0.1;
	let inner = sdEllipsoid(
		p - vec3<f32>(0.0, -height * 0.38, 0.0),
		vec3<f32>(radius * thin, height * 0.8, radius * thin)
	);
	// A minimum wall keeps the margin from thinning into aliasing fur at grazing angles.
	var d = max(outer, -(inner + radius * 0.035)) / sharpen;
	// Torus grammar opens a siphon through the apex.
	let siphon = length(p.xz) - radius * (0.12 + u.topoTorus * 0.2);
	d = max(d, -siphon - (1.0 - u.topoTorus) * 0.4);
	// Shedding erodes gaps into the margin between lobes.
	let gaps = smoothstep(0.55, 0.95, cos(ang * shape.z * 0.5 + floor(u.phrase) * 2.4 + u.seed * 9.0));
	d = d + gaps * margin * (u.sheddingForm * 0.035 + u.erosion * 0.012);
	// Manubrium: the central stalk hanging from the cavity ceiling.
	let stalkLength = height * (0.7 + u.reach * 0.3 + u.sproutForm * 0.25);
	let stalk = sdCapsule(
		p,
		vec3<f32>(0.0, height * 0.4, 0.0),
		vec3<f32>(0.0, -stalkLength, 0.0),
		radius * (0.05 + u.rootMass * 0.025)
	);
	return smin(d, stalk, 0.025);
}

// Daughter buds released from the margin during shedding: they bud early in
// the phrase, detach, drift out and dissolve before the phrase turns.
fn budSDF(q: vec3<f32>, shape: vec4<f32>) -> f32 {
	let shed = clamp(u.sheddingForm * 1.1 + u.divide * 0.25, 0.0, 1.0);
	if (shed < 0.02) { return 10.0; }
	let phraseIndex = floor(u.phrase);
	let phrasePos = fract(u.phrase);
	let release = smoothstep(0.12, 1.0, phrasePos);
	let life = smoothstep(0.0, 0.16, phrasePos) * smoothstep(1.0, 0.8, phrasePos) * shed;
	if (life < 0.01) { return 10.0; }
	var d = 10.0;
	for (var k: i32 = 0; k < 3; k += 1) {
		let fk = f32(k);
		let a = hashLane(phraseIndex, fk + 40.0) * TAU;
		let lift = hashLane(phraseIndex, fk + 50.0);
		let dir = normalize(vec3<f32>(cos(a), -0.25 + lift * 0.6, sin(a)));
		let distance = shape.x * 0.92 + release * (0.55 + hashLane(phraseIndex, fk + 60.0) * 0.6);
		let center = dir * distance + vec3<f32>(0.0, shape.w * 0.6, 0.0);
		let size = shape.x * (0.1 + hashLane(phraseIndex, fk + 70.0) * 0.07) * life;
		d = min(d, sdEllipsoid(q - center, vec3<f32>(size, size * 0.72, size)));
	}
	return d;
}

fn chainAmount() -> f32 {
	return clamp(u.windingForm * 1.25 + u.coil * 0.4 + u.topoShell * 0.2 - 0.15, 0.0, 1.0);
}

// Winding grows a siphonophore chain: small swimming bells threaded on a stem
// below the hero bell, appearing one by one as the build winds up.
fn chainSDF(q: vec3<f32>, shape: vec4<f32>) -> f32 {
	let chain = chainAmount();
	if (chain < 0.02) { return 10.0; }
	let top = -shape.y * 0.75;
	var d = 10.0;
	for (var k: i32 = 0; k < 4; k += 1) {
		let fk = f32(k);
		let present = clamp(chain * 4.0 - fk, 0.0, 1.0);
		if (present < 0.01) { break; }
		let phi = fk * 2.1 + u.seed * 4.0;
		let size = shape.x * (0.25 - fk * 0.03) * (0.4 + present * 0.6);
		let center = vec3<f32>(
			cos(phi) * shape.x * 0.24,
			top - (fk + 0.6) * shape.x * 0.5,
			sin(phi) * shape.x * 0.24
		);
		let local = q - center;
		let outer = sdEllipsoid(local, vec3<f32>(size, size * 0.9, size));
		let inner = sdEllipsoid(local - vec3<f32>(0.0, -size * 0.45, 0.0), vec3<f32>(size * 0.72, size * 0.7, size * 0.72));
		d = min(d, max(outer, -inner) + (1.0 - present) * 0.08);
	}
	let stem = sdCapsule(q, vec3<f32>(0.0, top, 0.0), vec3<f32>(0.0, top - shape.x * 2.0 * chain, 0.0), shape.x * 0.022);
	return min(d, stem);
}

fn map(p: vec3<f32>) -> f32 {
	let bound = length(p - u.bodyPos) - u.bodyScale * 1.8;
	if (bound > 0.3) { return bound; }
	let q = organismWarp(p);
	let shape = bellShape();
	let d = min(min(bellSDF(q, shape), budSDF(q, shape)), chainSDF(q, shape));
	return d * u.bodyScale * 0.7;
}

// 4-tap tetrahedral normal estimation.
fn calcNormal(p: vec3<f32>) -> vec3<f32> {
	let e = vec2<f32>(0.0016, -0.0016) * u.bodyScale;
	let m1 = map(p + e.xyy);
	let m2 = map(p + e.yyx);
	let m3 = map(p + e.yxy);
	let m4 = map(p + e.xxx);
	let n = e.xyy * m1 + e.yyx * m2 + e.yxy * m3 + e.xxx * m4;
	let len = length(n);
	if (!(len > 1e-8 && len < 1e8)) { return vec3<f32>(0.0, 1.0, 0.0); }
	return n / len;
}

// ── Light packets: each beat launches pulses from the apex down a canal and
// out along its tendril. g is the path coordinate (0 apex, 0.3 margin, 1 tip).
fn packetField(g: f32, lane: f32) -> f32 {
	let beat = u.beatConveyor;
	let n0 = floor(beat);
	let fireChance = 0.34 + u.rhythmicDensity * 0.36 + u.energy * 0.22;
	var sum = 0.0;
	for (var k: i32 = 0; k < 3; k += 1) {
		let n = n0 - f32(k);
		let age = beat - n;
		let fire = step(hashLane(n, lane), fireChance);
		let head = age * 0.42 - hashLane(n, lane + 31.0) * 0.06;
		let x = (g - head) * 17.0;
		let comet = select(exp(x * 0.6) * 0.55 + exp(-x * x) * 0.45, exp(-x * x * 1.6), x >= 0.0);
		sum = sum + fire * comet * exp(-age * 0.6);
	}
	return sum;
}

struct Surface {
	emission: vec3<f32>,
	transmission: f32,
};

struct Glow {
	front: vec3<f32>,
	back: vec3<f32>,
};

fn shadeMembrane(p: vec3<f32>, rd: vec3<f32>) -> Surface {
	let n = calcNormal(p);
	let v = -rd;
	let ndv = abs(dot(n, v));
	let fresnel = pow(max(1.0 - ndv, 0.0), 2.6);
	let q = organismWarp(p);
	let shape = bellShape();
	let radial = max(length(q.xz), 0.04);
	let ang = atan2(q.z, q.x);
	let gy = clamp((shape.y - q.y) / max(shape.y - shape.w, 0.05), 0.0, 1.0);
	let lanes = shape.z;
	let laneCoord = ang / TAU * lanes;
	let laneRound = floor(laneCoord + 0.5);
	let lane = laneRound - lanes * floor(laneRound / lanes);
	let laneOffset = abs(laneCoord - laneRound);
	let laneDist = laneOffset * TAU / lanes * radial;
	let onBell = smoothstep(shape.w - 0.16, shape.w - 0.04, q.y);
	let canal = exp(-pow(laneDist / (0.011 + u.surfaceRidges * 0.006), 2.0)) * smoothstep(0.04, 0.2, gy) * onBell;
	let ringOffset = (q.y - shape.w) / 0.03;
	let ring = exp(-ringOffset * ringOffset);
	let packets = packetField(gy * 0.3, lane) * packetEnergy();

	// Comb rows between the canals: shimmering cilia, the ctenophore signature.
	let rowDist = abs(laneOffset - 0.5) * TAU / lanes * radial;
	let row = exp(-pow(rowDist / 0.016, 2.0)) * smoothstep(0.12, 0.3, gy) * smoothstep(0.98, 0.72, gy) * onBell;
	let cilia = 0.5 + 0.5 * sin(gy * 70.0 - u.wavePhase * 3.2 + lane * 1.3);
	let iriHue = mixHue(u.hueAccent, u.hueRim, 0.5 + 0.5 * sin(gy * 7.0 + ndv * 5.0 + lane));
	let iri = hsv(iriHue, u.saturation * 0.85, 1.0) * row * cilia
		* (0.1 + u.iridescence * 0.35 + u.matCrystal * 0.15 + u.treble * 0.25);

	// Photophores ringing the margin twinkle with the top end.
	let spotCoord = ang / TAU * lanes * 3.0;
	let spotCell = floor(spotCoord);
	let spotDelta = vec2<f32>(
		(fract(spotCoord) - 0.5) * TAU / (lanes * 3.0) * radial,
		q.y - shape.w - 0.05
	);
	let spot = onBell * exp(-dot(spotDelta, spotDelta) / 0.00035)
		* (0.2 + u.treble * 1.1 * h21(vec2<f32>(spotCell, 3.0 + floor(u.beatConveyor * 0.5))));

	// Signed spectral detail etches the tissue band by band down the dome.
	let detail = clamp(bins[u32(clamp(gy * 63.0, 0.0, 63.0))], -1.0, 1.0);
	// Organs glow through the mesoglea from inside.
	let sss = exp(-length(q - vec3<f32>(0.0, shape.y * 0.1, 0.0)) * 3.2)
		* (0.35 + u.bass * 0.5 + u.rootPulse * 0.7);

	// The manubrium is a lantern hanging inside the bell, not a dark plug.
	let stalkGlow = smoothstep(shape.x * 0.2, shape.x * 0.04, radial) * step(q.y, shape.y * 0.35);
	// Beats run down the siphonophore chain as well.
	let chainPackets = (1.0 - onBell) * packetField(0.3 + (shape.w - q.y) * 0.35, 200.0) * packetEnergy();
	let base = baseCol();
	let accent = accentCol();
	let rim = rimCol();
	var emission = mix(accent, base, 0.3) * stalkGlow * (0.3 + u.bass * 0.4 + packets * 0.8)
		+ base * fresnel * (0.5 + u.energy * 0.35 + u.openness * 0.15) * 1.05
		+ base * 0.03 * (0.8 + detail * 0.6)
		+ accent * canal * (0.14 + packets * 2.0)
		+ rim * ring * (0.3 + packets * 1.6)
		+ iri
		+ accent * spot * 0.6
		+ mix(base, accent, 0.5) * sss * 0.2
		+ mix(rim, accent, 0.5) * chainPackets * (0.4 + fresnel);
	// A cool key from the surface far above gives the bell a wet highlight.
	let keyDir = normalize(vec3<f32>(0.22, 1.0, 0.14));
	let spec = pow(max(dot(reflect(-keyDir, n), v), 0.0), 36.0);
	emission = emission + hsv(u.hueInk - 0.06, 0.35, 1.0)
		* (spec * (0.18 + u.matCrystal * 0.4) * (1.0 - u.matVelvet * 0.7) + max(dot(n, keyDir), 0.0) * 0.01)
		* (0.4 + u.shaftIntensity);
	let transmission = clamp(
		mix(0.8, 0.2, fresnel) * (1.2 - u.density * 0.5) + u.hollow * 0.12 - u.matVelvet * 0.18,
		0.1,
		0.88
	);
	let dim = (1.0 - u.silence * 0.55) * (1.0 - u.dormancyForm * 0.35);
	return Surface(emission * dim, transmission);
}

// ── Tendrils: analytic glowing filaments hanging from the margin ──────────
fn raySegment(ro: vec3<f32>, rd: vec3<f32>, a: vec3<f32>, b: vec3<f32>) -> vec3<f32> {
	let ba = b - a;
	let oa = ro - a;
	let bb = max(dot(ba, ba), 1e-8);
	let rb = dot(rd, ba);
	let ob = dot(oa, ba);
	let orr = dot(oa, rd);
	let h = clamp((ob - rb * orr) / max(bb - rb * rb, 1e-8), 0.0, 1.0);
	let t = max(rb * h - orr, 0.0);
	return vec3<f32>(length(oa + rd * t - ba * h), t, h);
}

fn tendrilLocal(
	s: f32, er: vec3<f32>, et: vec3<f32>, rootR: f32, rootY: f32, len: f32,
	waveK: f32, waveAmp: f32, flare: f32, coilAmt: f32, fi: f32
) -> vec3<f32> {
	let phase = s * len * waveK - u.wavePhase * (1.0 + fi * 0.07) + fi * 1.7;
	let lateral = sin(phase) * waveAmp * s * len;
	let radialWave = cos(phase * 0.63 + fi) * waveAmp * 0.5 * s * len;
	let spread = rootR + s * flare * len + radialWave;
	var p = er * spread + et * lateral;
	let coiled = rot2(p.xz, coilAmt * s * TAU);
	p = vec3<f32>(coiled.x, rootY - s * len, coiled.y);
	// Drag: filaments trail behind the swimming bell.
	return p - u.localVel * pow(s, 1.4) * len * 1.7;
}

fn tendrils(ro: vec3<f32>, rd: vec3<f32>, pixelAngle: f32, tSplit: f32, tFar: f32) -> Glow {
	var glow: Glow;
	let shape = bellShape();
	let lanes = shape.z;
	let denseLanes = lanes > 8.5;
	let marginal = i32(lanes + 0.5);
	let squeeze = 1.0 + u.contraction * 0.26;
	let twistAtRim = twistRate() * shape.w;
	let phraseIndex = floor(u.phrase);
	let draftBlend = smoothstep(0.86, 1.0, fract(u.phrase));
	let packetGain = packetEnergy();
	let accent = accentCol();
	let rim = rimCol();
	let reachLength = clamp(
		0.95 + u.reach * 0.5 + u.filamentReach * 0.35 + u.bloomForm * 0.25 + u.sproutForm * 0.15
			+ u.topoCoral * 0.2 - u.dormancyForm * 0.5 - u.seedForm * 0.3,
		0.35,
		1.9
	);
	let flareBase = 0.1 + u.bloomForm * 0.22 + u.openness * 0.08 - u.contraction * 0.12 - u.dormancyForm * 0.08;
	let waveAmp = 0.035 + u.mid * 0.05 + u.bloomForm * 0.025 + u.filamentReach * 0.02;
	let coilAmt = (u.windingForm * 0.9 + u.coil * 1.3 + u.topoShell * 0.5) * 0.55;
	let stalkTip = -shape.y * (0.7 + u.reach * 0.3 + u.sproutForm * 0.25) - shape.x * 2.0 * chainAmount();
	let sproutFocus = clamp(u.sproutForm * 1.1, 0.0, 0.95);
	let dashing = clamp(u.sheddingForm * 0.85 + u.erosion * 0.2, 0.0, 0.9);
	let fade = (1.0 - u.silence * 0.5) * (1.0 - u.dormancyForm * 0.3);

	for (var i: i32 = 0; i < marginal + ORAL_ARMS; i += 1) {
		let isOral = i >= marginal;
		let fi = f32(i);
		var lane = fi;
		var theta = lane / lanes * TAU - twistAtRim;
		var presence = 1.0;
		var rootR = shape.x * 0.86 / squeeze;
		var rootY = shape.w;
		var len = reachLength;
		var width = 0.0065;
		var flare = flareBase;
		if (isOral) {
			let k = f32(i - marginal);
			lane = 100.0 + k;
			theta = (k + 0.25) / f32(ORAL_ARMS) * TAU + u.seed * 3.0;
			rootR = shape.x * 0.06;
			rootY = stalkTip;
			len = reachLength * 0.55;
			width = 0.015;
			flare = flareBase * 0.4;
		} else {
			// Dense bells grow their in-between tendrils as they bloom.
			if (denseLanes && (i % 2 == 1)) {
				presence = clamp(u.bloomForm * 1.2 + u.topoCoral * 0.6 + u.reach * 0.3, 0.0, 1.0);
			}
			// Sprout keeps two long feeding tentacles, like a comb jelly.
			let primary = (i == 0) || (i == marginal / 2);
			presence = presence * mix(1.0, select(0.0, 1.0, primary), sproutFocus);
			if (primary) {
				len = len * (1.0 + u.sproutForm * 0.7);
				width = width * (1.0 + u.sproutForm * 0.6);
			}
		}
		if (presence < 0.02) { continue; }
		let draft = mix(hashLane(phraseIndex, lane + 7.0), hashLane(phraseIndex + 1.0, lane + 7.0), draftBlend);
		len = len * (0.62 + draft * 0.62);
		let waveK = 4.0 + 5.0 * mix(
			hashLane(phraseIndex, lane + 13.0),
			hashLane(phraseIndex + 1.0, lane + 13.0),
			draftBlend
		);
		let amp = waveAmp * select(1.0, 1.6, isOral);
		let er = vec3<f32>(cos(theta), 0.0, sin(theta));
		let et = vec3<f32>(-sin(theta), 0.0, cos(theta));

		// Bounding sphere: skip filaments this ray cannot come near.
		let midLocal = er * rootR + vec3<f32>(0.0, rootY - len * 0.5, 0.0) - u.localVel * len * 0.6;
		let centerW = toWorld(midLocal);
		let radiusW = (len * 0.75 + rootR * 0.3 + 0.2) * u.bodyScale;
		let oc = centerW - ro;
		let tc = dot(oc, rd);
		if (dot(oc, oc) - tc * tc > radiusW * radiusW) { continue; }

		var best = 0.0;
		var bestT = 0.0;
		var bestS = 0.0;
		var previous = toWorld(tendrilLocal(0.0, er, et, rootR, rootY, len, waveK, amp, flare, coilAmt, fi));
		for (var j: i32 = 1; j <= TENDRIL_SEGMENTS; j += 1) {
			let s = f32(j) / f32(TENDRIL_SEGMENTS);
			let current = toWorld(tendrilLocal(s, er, et, rootR, rootY, len, waveK, amp, flare, coilAmt, fi));
			let hitInfo = raySegment(ro, rd, previous, current);
			let along = (f32(j - 1) + hitInfo.z) / f32(TENDRIL_SEGMENTS);
			var wWorld = width * (1.0 - along * 0.6) * u.bodyScale;
			if (isOral) { wWorld = wWorld * (0.75 + 0.45 * sin(along * 38.0 + fi * 2.0)); }
			let footprint = hitInfo.y * pixelAngle;
			let w = max(wWorld, footprint * 0.85);
			let core = exp(-pow(hitInfo.x / w, 2.0)) * (wWorld / w);
			let halo = exp(-hitInfo.x / (wWorld * 5.0 + footprint * 2.5)) * 0.08;
			// Shedding breaks filaments into drifting fragments.
			let dash = mix(1.0, smoothstep(0.35, 0.6, 0.5 + 0.5 * sin(along * 26.0 + fi * 2.3 + u.phrase * 3.0)), dashing);
			let intensity = (core + halo) * dash;
			if (intensity > best) {
				best = intensity;
				bestT = hitInfo.y;
				bestS = along;
			}
			previous = current;
		}
		best = best * presence;
		if (best < 0.002 || bestT > tFar) { continue; }
		let g = select(0.3 + 0.7 * bestS, bestS, isOral);
		let packets = packetField(g, lane) * packetGain;
		let body = select(rim, accent, isOral) * (0.2 + 0.45 * (1.0 - bestS));
		let light = (body + mix(accent, rim, 0.3) * packets * 2.2) * best * absorb(bestT) * fade;
		if (bestT < tSplit) { glow.front = glow.front + light; } else { glow.back = glow.back + light; }
	}
	return glow;
}

// Gonads: four horseshoe arcs glowing inside the bell, drawn as filaments so
// they read as anatomy rather than a pair of eyes. Kicks light them locally.
fn organs(ro: vec3<f32>, rd: vec3<f32>, pixelAngle: f32, tSplit: f32, tFar: f32) -> Glow {
	var glow: Glow;
	let shape = bellShape();
	let accent = accentCol();
	let rim = rimCol();
	let pulse = (0.45 + u.bass * 0.6 + u.rootPulse * 1.4) * (1.0 - u.silence * 0.6) * (1.0 - u.dormancyForm * 0.4);
	let arcRadius = shape.x * 0.3;
	for (var k: i32 = 0; k < 4; k += 1) {
		let a = f32(k) * TAU * 0.25 + 0.785 + u.seed * 5.0;
		var best = 0.0;
		var bestT = 0.0;
		let ca = cos(a);
		let sa = sin(a);
		var previous = toWorld(vec3<f32>(ca * arcRadius * 0.66, shape.y * 0.3, sa * arcRadius * 0.66));
		for (var j: i32 = 1; j <= 4; j += 1) {
			let tj = f32(j) * 0.25;
			let r = arcRadius * (0.66 + tj * 0.5 + sin(tj * 3.14159) * 0.12);
			let current = toWorld(vec3<f32>(ca * r, shape.y * (0.3 - tj * 0.5), sa * r));
			let hitInfo = raySegment(ro, rd, previous, current);
			let wWorld = shape.x * 0.024 * u.bodyScale * (1.0 + u.bass * 0.3);
			let footprint = hitInfo.y * pixelAngle;
			let w = max(wWorld, footprint * 0.85);
			let intensity = exp(-pow(hitInfo.x / w, 2.0)) * (wWorld / w)
				+ exp(-hitInfo.x / (wWorld * 3.0 + footprint * 2.0)) * 0.12;
			if (intensity > best) {
				best = intensity;
				bestT = hitInfo.y;
			}
			previous = current;
		}
		if (best < 0.002 || bestT > tFar) { continue; }
		let light = mix(accent, rim, f32(k % 2) * 0.5) * best * pulse * 0.55 * absorb(bestT);
		if (bestT < tSplit) { glow.front = glow.front + light; } else { glow.back = glow.back + light; }
	}
	return glow;
}

// Marine snow on five depth layers: world-anchored, slowly sinking, lit by
// the organism when it passes. It gives the frame scale and parallax.
fn marineSnow(ro: vec3<f32>, rd: vec3<f32>, pixelAngle: f32, tSplit: f32, tFar: f32) -> Glow {
	var glow: Glow;
	let facing = max(dot(rd, u.camFwd), 0.25);
	let lightCol = mix(baseCol(), accentCol(), 0.3);
	let plankton = accentCol();
	for (var k: i32 = 0; k < 5; k += 1) {
		let fk = f32(k);
		let depth = 0.8 + fk * 1.15 + fk * fk * 0.22;
		let tk = depth / facing;
		if (tk > tFar) { continue; }
		let p = ro + rd * tk;
		let cell = 0.16 + fk * 0.05;
		let sink = u.backgroundPhase * (1.6 + fk * 0.2);
		let coord = vec2<f32>(
			dot(p, u.camRight) + sink * 0.35 * (u.envCurrent + 0.2),
			dot(p, u.camUp) + sink
		) / cell;
		let id = floor(coord);
		let h = h21(id + vec2<f32>(fk * 37.0, u.seed * 91.0));
		if (h > 0.5 + u.envCellular * 0.35) { continue; }
		let center = vec2<f32>(h21(id + 11.7), h21(id + 23.1)) * 0.7 + 0.15;
		let dist = length((fract(coord) - center) * cell);
		let rWorld = cell * (0.012 + h * 0.03);
		let footprint = tk * pixelAngle;
		let r = max(rWorld, footprint * 0.7);
		let cover = exp(-(dist * dist) / (r * r)) * (rWorld * rWorld) / (r * r);
		if (cover < 0.001) { continue; }
		let toBody = length(p - u.bodyPos);
		let lit = 0.05 + 1.4 * u.bodyScale / (1.0 + toBody * toBody * 2.5);
		let own = step(h, 0.04 + u.envCellular * 0.05) * (0.6 + u.treble * 1.4);
		let light = (lightCol * lit + plankton * own) * cover * absorb(tk) * 0.5;
		if (tk < tSplit) { glow.front = glow.front + light; } else { glow.back = glow.back + light; }
	}
	return glow;
}

// ── Environment ───────────────────────────────────────────────────────────
fn waterColor(rd: vec3<f32>) -> vec3<f32> {
	let up = rd.y;
	var col = inkCol(0.028);
	col = mix(col, inkCol(0.07), smoothstep(-0.5, 0.12, up));
	col = mix(col, hsv(u.hueInk - 0.05, 0.62, 0.17 + u.envHorizon * 0.05), smoothstep(0.1, 0.95, up));
	// Thermocline: a faint lit layer of water at the horizon.
	let layer = (up - 0.04) * 10.0;
	col = col + hsv(u.hueInk + 0.02, 0.55, 1.0) * exp(-layer * layer)
		* (0.025 + u.envHorizon * 0.05);
	// Distant pinnacles in the haze give the deep a sense of scale.
	let az = atan2(rd.z, rd.x);
	let ridge = -0.03 + vn2(vec2<f32>(az * 3.2 + u.seed * 40.0, 1.5)) * (0.05 + u.envCavern * 0.12)
		+ vn2(vec2<f32>(az * 11.0, 4.0)) * 0.018;
	let rock = smoothstep(ridge + 0.004, ridge - 0.004, up) * smoothstep(-0.3, -0.02, up);
	col = mix(col, inkCol(0.03), rock * (0.55 + u.envCavern * 0.3));
	return col;
}

fn shaftField(p: vec3<f32>) -> f32 {
	let keyDir = normalize(vec3<f32>(0.22, 1.0, 0.14));
	let proj = p.xz - keyDir.xz / keyDir.y * p.y;
	let flow = vec2<f32>(u.backgroundPhase * 0.6, u.backgroundPhase * 0.25);
	let n = vn2(proj * 0.42 + flow) * 0.7 + vn2(proj * 1.1 - flow * 1.3 + 5.0) * 0.3;
	var s = smoothstep(0.52, 0.88, n);
	s = s * clamp(exp((p.y - 2.4) * 0.42), 0.0, 1.0);
	// The organism casts a soft shadow down its own light shafts.
	let bodyProj = u.bodyPos.xz - keyDir.xz / keyDir.y * u.bodyPos.y;
	let shadowR = u.bodyScale * 0.55;
	let shadow = smoothstep(shadowR * 0.5, shadowR * 1.4, length(proj - bodyProj));
	return s * mix(1.0, shadow, step(p.y, u.bodyPos.y));
}

fn shaftInscatter(ro: vec3<f32>, rd: vec3<f32>, tEnd: f32, jitter: f32) -> vec3<f32> {
	let keyDir = normalize(vec3<f32>(0.22, 1.0, 0.14));
	let dt = tEnd / 8.0;
	var sum = 0.0;
	for (var k: i32 = 0; k < 8; k += 1) {
		let tk = (f32(k) + jitter) * dt;
		sum = sum + shaftField(ro + rd * tk) * exp(-tk * 0.1);
	}
	let forward = 0.45 + 0.55 * pow(max(dot(rd, keyDir), 0.0), 3.0);
	return hsv(u.hueInk - 0.06, 0.42, 1.0) * sum * dt * u.shaftIntensity * 0.2 * forward;
}

// Reproject a world point into last frame's feedback image.
fn sampleHistory(world: vec3<f32>) -> vec3<f32> {
	let v = world - u.camPos;
	let z = dot(v, u.camFwd);
	if (z < 0.2) { return vec3<f32>(0.0); }
	let sx = dot(v, u.camRight) / z * u.fovScale;
	let sy = dot(v, u.camUp) / z * u.fovScale;
	let uv = vec2<f32>(sx * u.resY / u.resX + 0.5, 0.5 - sy);
	let edge = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
	if (edge < 0.0) { return vec3<f32>(0.0); }
	let o = vec2<f32>(0.0025, 0.0);
	let c = textureSampleLevel(historyTex, historySampler, uv, 0.0).rgb * 0.5
		+ (textureSampleLevel(historyTex, historySampler, uv + o, 0.0).rgb
			+ textureSampleLevel(historyTex, historySampler, uv - o, 0.0).rgb) * 0.25;
	return c * smoothstep(0.0, 0.06, edge);
}

fn floorShade(ro: vec3<f32>, rd: vec3<f32>, t: f32) -> vec3<f32> {
	let p = ro + rd * t;
	let xz = p.xz;
	let silt = vn2(xz * 1.6 + vec2<f32>(u.seed * 13.0, 3.0)) * 0.55 + vn2(xz * 4.7 + 9.0) * 0.3
		+ vn2(xz * 13.0) * 0.15;
	let dune = vn2(xz * vec2<f32>(0.5, 0.9) + vec2<f32>(2.0, u.seed * 5.0));
	// The organism is the floor's light: a pool of its colour follows it.
	let toBody = u.bodyPos - p;
	let dist2 = dot(toBody, toBody);
	let facing = clamp(toBody.y * inverseSqrt(dist2 + 1e-4), 0.0, 1.0);
	let lightCol = mix(baseCol(), accentCol(), 0.35)
		* (0.8 + u.energy * 0.7 + u.rootPulse * 0.5 + u.beatGlow * 0.2)
		* (1.0 - u.silence * 0.6) * (1.0 - u.dormancyForm * 0.3);
	let bio = lightCol * (0.3 + facing * 0.7) * u.bodyScale / (1.0 + dist2 * 0.9);
	let caustic = shaftField(p) * u.shaftIntensity;
	let albedo = mix(0.5, 1.0, silt) * (0.75 + dune * 0.5);
	var col = albedo * (bio * 2.2 + hsv(u.hueInk - 0.04, 0.45, 1.0) * caustic * 0.45 + inkCol(0.05));
	// Brine pools: still, heavy water that mirrors the organism.
	let poolNoise = vn2(xz * 0.28 + vec2<f32>(u.seed * 31.0, 7.0));
	let pool = smoothstep(0.5, 0.56, poolNoise);
	let fres = 0.04 + 0.96 * pow(1.0 - abs(rd.y), 5.0);
	let reflectivity = mix(0.06, 0.5, pool) * mix(0.35, 1.0, fres);
	let reflected = vec3<f32>(rd.x, -rd.y, rd.z);
	let mirrorPoint = p + reflected * length(u.bodyPos - p);
	col = col * (1.0 - pool * 0.5) + sampleHistory(mirrorPoint) * reflectivity;
	// A faint lit lip where brine meets silt.
	let lip = smoothstep(0.47, 0.5, poolNoise) - smoothstep(0.5, 0.53, poolNoise);
	col = col + lightCol * lip * 0.08 / (1.0 + dist2 * 0.6);
	let haze = exp(-t * (u.fogDensity * 1.6 + 0.04));
	return mix(waterColor(rd), col, haze);
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let res = vec2<f32>(u.resX, u.resY);
	let uv = vec2<f32>(frag.x - 0.5 * res.x, 0.5 * res.y - frag.y) / res.y;
	let ro = u.camPos;
	let rd = normalize(uv.x * u.camRight + uv.y * u.camUp + u.camFwd * u.fovScale);
	let pixelAngle = 1.0 / (res.y * u.fovScale);
	let jitter = ign(frag.xy);

	var tFloor = 1e5;
	if (rd.y < -0.0001) { tFloor = (FLOOR_Y - ro.y) / rd.y; }
	let tLimit = min(tFloor, 18.0);

	// Primary march: the organism is the only distance field in the scene.
	var t = 0.02 + jitter * 0.02;
	var hit = false;
	var minD = 1e5;
	let steps = i32(clamp(u.qualitySteps, 16.0, 96.0));
	for (var i: i32 = 0; i < 96; i += 1) {
		if (i >= steps) { break; }
		var d = map(ro + rd * t);
		if (!(abs(d) < 1e10)) { d = 0.5; }
		minD = min(minD, d);
		if (d < 0.0011 * (1.0 + t)) { hit = true; break; }
		t = t + d;
		if (t > tLimit) { break; }
	}
	let tHit = select(1e5, t, hit);

	var front = Surface(vec3<f32>(0.0), 1.0);
	var far = Surface(vec3<f32>(0.0), 1.0);
	var tBack = 1e5;
	if (hit) {
		front = shadeMembrane(ro + rd * tHit, rd);
		// Cross the membrane, then find the far wall of the bell through it.
		var tb = tHit + 0.01 * u.bodyScale;
		for (var i: i32 = 0; i < 14; i += 1) {
			let d = map(ro + rd * tb);
			if (!(abs(d) < 1e10) || d > 0.002) { break; }
			tb = tb + max(-d, 0.006);
		}
		for (var i: i32 = 0; i < 28; i += 1) {
			let d = map(ro + rd * tb);
			if (!(abs(d) < 1e10)) { break; }
			if (d < 0.0015 * (1.0 + tb)) { tBack = tb; break; }
			tb = tb + d;
			if (tb > tHit + 3.0 * u.bodyScale) { break; }
		}
		if (tBack < 1e4) { far = shadeMembrane(ro + rd * tBack, rd); }
	}

	let tFar = tFloor;
	let tend = tendrils(ro, rd, pixelAngle, tHit, tFar);
	let organ = organs(ro, rd, pixelAngle, tHit, tFar);
	let snow = marineSnow(ro, rd, pixelAngle, tHit, tFar);
	let glowFront = tend.front + organ.front + snow.front;
	let glowBack = tend.back + organ.back + snow.back;

	var background: vec3<f32>;
	if (tFloor < 1e4) { background = floorShade(ro, rd, tFloor); } else { background = waterColor(rd); }
	let shafts = shaftInscatter(ro, rd, min(tFloor, 14.0), jitter);

	var col: vec3<f32>;
	if (hit) {
		let nearAbsorb = absorb(tHit);
		let farAbsorb = absorb(tBack);
		let behind = far.emission * farAbsorb + far.transmission * background + glowBack;
		col = glowFront + front.emission * nearAbsorb + front.transmission * behind + shafts * 0.7;
		// Water veils the subject a little with depth.
		col = col + waterColor(rd) * (1.0 - nearAbsorb) * 0.5;
	} else {
		let aura = mix(baseCol(), accentCol(), 0.25) * exp(-max(minD, 0.0) / (0.05 * u.bodyScale))
			* 0.1 * (0.6 + u.energy * 0.5) * (1.0 - u.silence * 0.6);
		col = background + glowFront + shafts + aura;
	}
	// A single non-finite pixel would be smeared into a box by the bloom blur.
	let finite = all(col == col) && all(abs(col) < vec3<f32>(1e4));
	return vec4<f32>(select(vec3<f32>(0.0), clamp(col, vec3<f32>(0.0), vec3<f32>(64.0)), finite), 1.0);
}
`;

	const FULLSCREEN_WGSL = /* wgsl */ `
struct FullscreenOut {
	@builtin(position) position: vec4<f32>,
	@location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> FullscreenOut {
	var positions = array<vec2<f32>, 3>(
		vec2<f32>(-1.0, -1.0),
		vec2<f32>( 3.0, -1.0),
		vec2<f32>(-1.0,  3.0)
	);
	let point = positions[index];
	var out: FullscreenOut;
	out.position = vec4<f32>(point, 0.0, 1.0);
	out.uv = vec2<f32>(point.x * 0.5 + 0.5, 1.0 - (point.y * 0.5 + 0.5));
	return out;
}
`;

	const POST_COMMON_WGSL = /* wgsl */ `
${UNIFORMS_WGSL}
${SHARED_WGSL}
${FULLSCREEN_WGSL}
`;

	// Temporal feedback: last frame, nudged a hair upward and outward, decays
	// and is max-blended with the new scene so the organism leaves a luminous
	// wake without accumulating to white.
	const FEEDBACK_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var sceneTex: texture_2d<f32>;
@group(0) @binding(3) var previousTex: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let centered = in.uv - 0.5;
	let previousUv = centered * u.feedbackZoom + 0.5 + vec2<f32>(0.0, 0.0006);
	let edge = min(min(previousUv.x, previousUv.y), min(1.0 - previousUv.x, 1.0 - previousUv.y));
	let border = smoothstep(0.0, 0.03, edge);
	// The trail diffuses a little every frame, so a moving bell leaves a soft
	// luminous wake instead of crisp onion-skin copies of its canals.
	let px = 1.6 / max(vec2<f32>(u.resX, u.resY), vec2<f32>(1.0));
	let previous = textureSampleLevel(previousTex, samp, previousUv, 0.0).rgb * 0.36
		+ (textureSampleLevel(previousTex, samp, previousUv + vec2<f32>(px.x, 0.0), 0.0).rgb
			+ textureSampleLevel(previousTex, samp, previousUv - vec2<f32>(px.x, 0.0), 0.0).rgb
			+ textureSampleLevel(previousTex, samp, previousUv + vec2<f32>(0.0, px.y), 0.0).rgb
			+ textureSampleLevel(previousTex, samp, previousUv - vec2<f32>(0.0, px.y), 0.0).rgb) * 0.16;
	let scene = textureSampleLevel(sceneTex, samp, in.uv, 0.0).rgb;
	return vec4<f32>(max(previous * u.feedbackFade * border, scene), 1.0);
}
`;

	// Bloom prefilter: half resolution with a soft HDR knee so only emissive
	// cores, packets and membrane edges bloom, never the water.
	const BLOOM_DOWN_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var sourceTex: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let texel = 1.0 / max(vec2<f32>(u.resX, u.resY), vec2<f32>(1.0));
	var color = textureSampleLevel(sourceTex, samp, in.uv + vec2<f32>(-1.0, -1.0) * texel, 0.0).rgb;
	color = color + textureSampleLevel(sourceTex, samp, in.uv + vec2<f32>( 1.0, -1.0) * texel, 0.0).rgb;
	color = color + textureSampleLevel(sourceTex, samp, in.uv + vec2<f32>(-1.0,  1.0) * texel, 0.0).rgb;
	color = color + textureSampleLevel(sourceTex, samp, in.uv + vec2<f32>( 1.0,  1.0) * texel, 0.0).rgb;
	color = color * 0.25;
	let bright = max(color.r, max(color.g, color.b));
	let knee = max(0.0, bright - u.bloomThreshold);
	return vec4<f32>(color * (knee / max(1e-4, bright)), 1.0);
}
`;

	function blurShader(directionX: number, directionY: number) {
		return /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var sourceTex: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let texel = 3.2 / max(vec2<f32>(u.resX, u.resY), vec2<f32>(1.0));
	let direction = vec2<f32>(${directionX.toFixed(1)}, ${directionY.toFixed(1)}) * texel;
	var color = textureSampleLevel(sourceTex, samp, in.uv, 0.0).rgb * 0.227027;
	color = color + (textureSampleLevel(sourceTex, samp, in.uv + direction, 0.0).rgb
		+ textureSampleLevel(sourceTex, samp, in.uv - direction, 0.0).rgb) * 0.1945946;
	color = color + (textureSampleLevel(sourceTex, samp, in.uv + direction * 2.0, 0.0).rgb
		+ textureSampleLevel(sourceTex, samp, in.uv - direction * 2.0, 0.0).rgb) * 0.1216216;
	color = color + (textureSampleLevel(sourceTex, samp, in.uv + direction * 3.0, 0.0).rgb
		+ textureSampleLevel(sourceTex, samp, in.uv - direction * 3.0, 0.0).rgb) * 0.054054;
	color = color + (textureSampleLevel(sourceTex, samp, in.uv + direction * 4.0, 0.0).rgb
		+ textureSampleLevel(sourceTex, samp, in.uv - direction * 4.0, 0.0).rgb) * 0.016216;
	return vec4<f32>(color, 1.0);
}
`;
	}

	const BLUR_H_WGSL = blurShader(1, 0);
	const BLUR_V_WGSL = blurShader(0, 1);

	// Composite: barrel lens with chromatic aberration that grows toward the
	// edges and flares on impacts, bloom as an accent, vignette, ACES, a gentle
	// S-curve that keeps the ink tones, and interleaved-gradient dither.
	const COMPOSITE_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var feedbackTex: texture_2d<f32>;
@group(0) @binding(3) var bloomTex: texture_2d<f32>;

fn aces(color: vec3<f32>) -> vec3<f32> {
	let a = 2.51;
	let b = 0.03;
	let c = 2.43;
	let d = 0.59;
	let e = 0.14;
	return clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let resolution = vec2<f32>(u.resX, u.resY);
	let centered = in.uv - 0.5;
	let r2 = dot(centered, centered);
	let warped = 0.5 + centered * (1.0 + r2 * 0.045);
	let caAmount = (0.0009 + r2 * 0.0075) * u.aberration;
	let direction = normalize(centered + vec2<f32>(1e-4, 1e-4));
	let scene = vec3<f32>(
		textureSampleLevel(feedbackTex, samp, warped + direction * caAmount, 0.0).r,
		textureSampleLevel(feedbackTex, samp, warped, 0.0).g,
		textureSampleLevel(feedbackTex, samp, warped - direction * caAmount, 0.0).b
	);
	let bloom = textureSampleLevel(bloomTex, samp, warped, 0.0).rgb;
	let aspect = resolution.x / max(resolution.y, 1.0);
	let distance = length(centered * vec2<f32>(aspect, 1.0));
	let vignette = 1.0 - smoothstep(0.38, 1.05, distance);
	var color = (scene + bloom * 0.9) * (0.6 + vignette * 0.4);
	color = aces(color * 1.05);
	color = mix(color, color * color * (3.0 - 2.0 * color), 0.18);
	color = color + (ign(in.uv * resolution) - 0.5) * (1.3 / 255.0);
	return vec4<f32>(color, 1.0);
}
`;

	const BIN_COUNT = 64;
	const BINS_BYTES = BIN_COUNT * 4;

	type SomaTargets = {
		scene: GPUTexture;
		sceneView: GPUTextureView;
		/** Ping-pong HDR history for the temporal feedback trail. */
		feedback: [GPUTexture, GPUTexture];
		feedbackViews: [GPUTextureView, GPUTextureView];
		/** Half-resolution bloom chain: [0] prefilter/final, [1] horizontal pass. */
		bloom: [GPUTexture, GPUTexture];
		bloomViews: [GPUTextureView, GPUTextureView];
		width: number;
		height: number;
	};

	type SomaBindGroups = {
		/** Indexed by the parity of the history frame the scene reads. */
		scene: [GPUBindGroup, GPUBindGroup];
		feedback: [GPUBindGroup, GPUBindGroup];
		/** Indexed by the parity of the frame just written. */
		bloomDown: [GPUBindGroup, GPUBindGroup];
		blurH: GPUBindGroup;
		blurV: GPUBindGroup;
		composite: [GPUBindGroup, GPUBindGroup];
	};

	type GPU = {
		device: GPUDevice;
		context: GPUCanvasContext;
		format: GPUTextureFormat;
		sampler: GPUSampler;
		uniformBuf: GPUBuffer;
		uniformData: Float32Array;
		// Spectrum storage sampled directly by the raymarched membrane.
		binsBuf: GPUBuffer;
		pipelines: {
			scene: GPURenderPipeline;
			feedback: GPURenderPipeline;
			bloomDown: GPURenderPipeline;
			blurH: GPURenderPipeline;
			blurV: GPURenderPipeline;
			composite: GPURenderPipeline;
		};
		targets: SomaTargets | null;
		bindGroups: SomaBindGroups | null;
		parity: 0 | 1;
	};

	let gpu: GPU | null = null;
	let qualityProfile: SomaQualityProfile = SOMA_QUALITY_PROFILES.ultra;
	const autoQuality = new SomaAutoQualityController(qualityProfile.tier);
	let autoQualityCeiling: SomaQualityTier | null = null;
	let schedulerTickAt = 0;
	let refreshIntervalMs = 1000 / 60;
	let activeFrameStride = 1;
	let framesUntilRender = 0;
	let lastRenderedAt = 0;

	function resetFrameScheduler() {
		schedulerTickAt = 0;
		framesUntilRender = 0;
		lastRenderedAt = 0;
	}

	function observeDisplayCadence(tickElapsedMs: number) {
		if (tickElapsedMs < 1000 / 360 || tickElapsedMs > 1000 / 24) return;
		// Converge quickly downward when discovering a high-refresh panel, then
		// ignore obvious multi-vsync hitches so one missed RAF cannot halve the
		// estimated refresh rate and reshuffle the presentation cadence.
		if (tickElapsedMs < refreshIntervalMs * 0.8) {
			refreshIntervalMs = lerp(refreshIntervalMs, tickElapsedMs, 0.38);
		} else if (tickElapsedMs <= refreshIntervalMs * 1.35) {
			refreshIntervalMs = lerp(refreshIntervalMs, tickElapsedMs, 0.08);
		}
		const nextRefreshRate = Math.round(1000 / refreshIntervalMs);
		if (nextRefreshRate !== measuredRefreshRate) measuredRefreshRate = nextRefreshRate;
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
			resetFrameScheduler();
			temporalResetRequested = true;
		}
		return qualityProfile;
	}

	function buildTargets(device: GPUDevice, w: number, h: number): SomaTargets {
		const hdr = (label: string, width: number, height: number) =>
			device.createTexture({
				label,
				size: { width: Math.max(1, width), height: Math.max(1, height) },
				format: 'rgba16float',
				usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
			});
		const scene = hdr('Soma scene', w, h);
		const feedback: [GPUTexture, GPUTexture] = [
			hdr('Soma feedback A', w, h),
			hdr('Soma feedback B', w, h)
		];
		const bloomWidth = Math.max(1, Math.floor(w / 2));
		const bloomHeight = Math.max(1, Math.floor(h / 2));
		const bloom: [GPUTexture, GPUTexture] = [
			hdr('Soma bloom A', bloomWidth, bloomHeight),
			hdr('Soma bloom B', bloomWidth, bloomHeight)
		];
		return {
			scene,
			sceneView: scene.createView(),
			feedback,
			feedbackViews: [feedback[0].createView(), feedback[1].createView()],
			bloom,
			bloomViews: [bloom[0].createView(), bloom[1].createView()],
			width: w,
			height: h
		};
	}

	function buildBindGroups(g: GPU): SomaBindGroups | null {
		if (!g.targets) return null;
		const { device, pipelines, uniformBuf, sampler, targets, binsBuf } = g;
		const uniform = { binding: 0, resource: { buffer: uniformBuf } };
		const samplerEntry = { binding: 1, resource: sampler };
		const bind = (pipeline: GPURenderPipeline, label: string, views: GPUTextureView[]) =>
			device.createBindGroup({
				label,
				layout: pipeline.getBindGroupLayout(0),
				entries: [
					uniform,
					samplerEntry,
					...views.map((view, index) => ({ binding: 2 + index, resource: view }))
				]
			});
		const sceneBind = (history: GPUTextureView, label: string) =>
			device.createBindGroup({
				label,
				layout: pipelines.scene.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: uniformBuf } },
					{ binding: 1, resource: { buffer: binsBuf } },
					{ binding: 2, resource: sampler },
					{ binding: 3, resource: history }
				]
			});
		return {
			scene: [
				sceneBind(targets.feedbackViews[0], 'Soma scene reads A'),
				sceneBind(targets.feedbackViews[1], 'Soma scene reads B')
			],
			feedback: [
				bind(pipelines.feedback, 'Soma feedback reads A', [targets.sceneView, targets.feedbackViews[0]]),
				bind(pipelines.feedback, 'Soma feedback reads B', [targets.sceneView, targets.feedbackViews[1]])
			],
			bloomDown: [
				bind(pipelines.bloomDown, 'Soma bloom prefilter A', [targets.feedbackViews[0]]),
				bind(pipelines.bloomDown, 'Soma bloom prefilter B', [targets.feedbackViews[1]])
			],
			blurH: bind(pipelines.blurH, 'Soma bloom blur H', [targets.bloomViews[0]]),
			blurV: bind(pipelines.blurV, 'Soma bloom blur V', [targets.bloomViews[1]]),
			composite: [
				bind(pipelines.composite, 'Soma composite A', [targets.feedbackViews[0], targets.bloomViews[0]]),
				bind(pipelines.composite, 'Soma composite B', [targets.feedbackViews[1], targets.bloomViews[0]])
			]
		};
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
		let uniformBuf: GPUBuffer | null = null;
		let binsBuf: GPUBuffer | null = null;
		try {
			context.configure({ device, format, alphaMode: 'opaque' });

			const shaderModule = async (label: string, code: string) => {
				const module = device.createShaderModule({ label, code });
				const info = await module.getCompilationInfo?.();
				const errors =
					info?.messages.filter((message) => message.type === 'error').slice(0, 4) ?? [];
				if (errors.length > 0) {
					const details = errors
						.map((message) => {
							const line = message.lineNum ? `:${message.lineNum}:${message.linePos}` : '';
							return `${label}${line} ${message.message}`;
						})
						.join(' | ');
					throw new Error(`Soma shader failed to compile: ${details}`);
				}
				return module;
			};

			const mkPipeline = async (label: string, code: string, target: GPUTextureFormat) => {
				const module = await shaderModule(label, code);
				return device.createRenderPipelineAsync({
					label,
					layout: 'auto',
					vertex: { module, entryPoint: 'vs_main' },
					fragment: { module, entryPoint: 'fs_main', targets: [{ format: target }] },
					primitive: { topology: 'triangle-list' }
				});
			};

			const hdr: GPUTextureFormat = 'rgba16float';
			const [scene, feedback, bloomDown, blurH, blurV, composite] = await Promise.all([
				mkPipeline('Soma abyss scene', SCENE_WGSL, hdr),
				mkPipeline('Soma feedback', FEEDBACK_WGSL, hdr),
				mkPipeline('Soma bloom prefilter', BLOOM_DOWN_WGSL, hdr),
				mkPipeline('Soma bloom blur H', BLUR_H_WGSL, hdr),
				mkPipeline('Soma bloom blur V', BLUR_V_WGSL, hdr),
				mkPipeline('Soma composite', COMPOSITE_WGSL, format)
			]);

			uniformBuf = device.createBuffer({
				size: UNIFORM_BYTES,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
			});
			binsBuf = device.createBuffer({
				size: BINS_BYTES,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
			});

			return {
				device,
				context,
				format,
				sampler: device.createSampler({
					magFilter: 'linear',
					minFilter: 'linear',
					addressModeU: 'clamp-to-edge',
					addressModeV: 'clamp-to-edge'
				}),
				uniformBuf,
				uniformData: new Float32Array(UNIFORM_FLOATS),
				binsBuf,
				pipelines: { scene, feedback, bloomDown, blurH, blurV, composite },
				targets: null,
				bindGroups: null,
				parity: 0
			};
		} catch (error) {
			uniformBuf?.destroy();
			binsBuf?.destroy();
			try {
				context.unconfigure();
			} catch {
				// A failed configure may also make unconfigure unavailable.
			}
			device.destroy?.();
			throw error;
		}
	}

	function discardTargets(g: GPU) {
		if (g.targets) {
			g.targets.scene.destroy();
			for (const texture of g.targets.feedback) texture.destroy();
			for (const texture of g.targets.bloom) texture.destroy();
		}
		g.targets = null;
		g.bindGroups = null;
		g.parity = 0;
	}

	function ensureTargets(g: GPU, w: number, h: number) {
		if (g.targets && g.targets.width === w && g.targets.height === h) return;
		discardTargets(g);
		g.targets = buildTargets(g.device, w, h);
		g.bindGroups = buildBindGroups(g);
		// Fresh history: never warp a stale or differently-sized trail.
		feedbackResetFrames = 2;
	}

	function destroyGpuResources(g: GPU) {
		try {
			discardTargets(g);
			g.uniformBuf.destroy();
			g.binsBuf.destroy();
			try {
				g.context.unconfigure();
			} catch {
				// The device may already be lost.
			}
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

	function normalize3(v: SomaVec3): SomaVec3 {
		const length = Math.hypot(v[0], v[1], v[2]) || 1;
		v[0] /= length;
		v[1] /= length;
		v[2] /= length;
		return v;
	}

	function cross3(a: Readonly<SomaVec3>, b: Readonly<SomaVec3>): SomaVec3 {
		return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
	}

	function dot3(a: Readonly<SomaVec3>, b: Readonly<SomaVec3>) {
		return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	}

	function loop(frameNow = performance.now()) {
		if (!running) return;
		raf = requestAnimationFrame(loop);
		if (!canvas || !gpu) return;

		if (!schedulerTickAt) {
			schedulerTickAt = frameNow;
		} else {
			const tickElapsed = Math.max(0, frameNow - schedulerTickAt);
			schedulerTickAt = frameNow;
			observeDisplayCadence(tickElapsed);
		}
		const nextFrameStride = somaFrameStride(refreshIntervalMs, qualityProfile.frameRate);
		if (nextFrameStride !== activeFrameStride) {
			activeFrameStride = nextFrameStride;
			renderStride = nextFrameStride;
			framesUntilRender = 0;
		}
		if (framesUntilRender > 0) {
			framesUntilRender--;
			return;
		}
		framesUntilRender = activeFrameStride - 1;

		// This is the actual time between rendered frames, independent of the
		// scheduler's fractional budget, so smoothing remains time-correct on
		// 60/75/90/120/144 Hz displays and after an occasional missed frame.
		const hadPreviousRender = lastRenderedAt !== 0;
		const elapsedMs = hadPreviousRender
			? Math.max(0, frameNow - lastRenderedAt)
			: refreshIntervalMs * activeFrameStride;
		lastRenderedAt = frameNow;
		const frameDt = Math.min(1, Math.max(0.001, elapsedMs / 1000));
		const motionDt = Math.min(frameDt, 0.1);

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
		// source's feedback history.
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
				`Soma could not prepare its WebGPU render targets: ${detail}. Switch to another visualizer and back to retry; if it repeats, restart Mewsik or update the graphics driver.`
			);
			return;
		}
		const targets = gpu.targets;
		const bindGroups = gpu.bindGroups;
		if (!bindGroups || !targets) return;

		const directed = shared.director;
		const spectrum = shared.spectrum;
		const journey = shared.mk2;
		const snapAim = poseSyncRequested;
		const pose = updateRenderPose(journey, frameDt);
		currentSection = directed.section;
		currentForm = dominantLifecycleForm(journey);
		currentGesture = dominantGesture(journey);

		const response = VISUALIZER_RESPONSE_PROFILES.mk2[vis.response];
		somaPaletteRoles(directed.palette, directed.context.keyMode, paletteRoles);

		// Silence: an absent or near-silent analyzer slowly dims the organism.
		const rmsTarget = clamp(feat?.rms ?? 0, 0, 1);
		if (!feat || rmsTarget < 0.009) smoothed.quietFor += frameDt;
		else smoothed.quietFor = 0;
		const silent = smoothed.quietFor > 0.45 ? 1 : 0;

		if (rendererSyncRequested) {
			smoothed.bass = spectrum.bass;
			smoothed.mid = spectrum.mid;
			smoothed.treble = spectrum.treble;
			smoothed.energy = journey.macroEnergy;
			smoothed.impact = 0;
			smoothed.rootPulse = 0;
			smoothed.rms = rmsTarget;
			smoothed.silence = feat ? 0 : 1;
			smoothed.beatGlow = 0;
			smoothed.responseMotion = response.motion;
			smoothed.responseImpact = response.impact;
			smoothed.responseFog = response.fog;
			smoothed.responseShafts = response.shafts;
			Object.assign(renderRoles, paletteRoles);
			for (let index = 0; index < BIN_COUNT; index += 1) {
				renderDetailBins[index] = spectrum.detailBins[index] ?? 0;
			}
			rendererSyncRequested = false;
		} else {
			smoothed.bass = approach(smoothed.bass, spectrum.bass, 7, frameDt);
			smoothed.mid = approach(smoothed.mid, spectrum.mid, 4, frameDt);
			smoothed.treble = approach(smoothed.treble, spectrum.treble, 9, frameDt);
			smoothed.energy = approach(smoothed.energy, journey.macroEnergy, 1.2, frameDt);
			smoothed.impact = approach(smoothed.impact, journey.impact, 18, frameDt);
			smoothed.rootPulse = approach(smoothed.rootPulse, journey.rootPulse, 16, frameDt);
			smoothed.rms = approach(smoothed.rms, rmsTarget, rmsTarget > smoothed.rms ? 17 : 6, frameDt);
			smoothed.silence = approach(smoothed.silence, silent, silent ? 3 : 10, frameDt);
			// Response changes are instrument gestures: glide them in.
			smoothed.responseMotion = approach(smoothed.responseMotion, response.motion, 2.7, frameDt);
			smoothed.responseImpact = approach(smoothed.responseImpact, response.impact, 4.2, frameDt);
			smoothed.responseFog = approach(smoothed.responseFog, response.fog, 2.4, frameDt);
			smoothed.responseShafts = approach(smoothed.responseShafts, response.shafts, 2.4, frameDt);
			renderRoles.base = approachHue(renderRoles.base, paletteRoles.base, 1.6, frameDt);
			renderRoles.accent = approachHue(renderRoles.accent, paletteRoles.accent, 1.6, frameDt);
			renderRoles.rim = approachHue(renderRoles.rim, paletteRoles.rim, 1.6, frameDt);
			renderRoles.ink = approachHue(renderRoles.ink, paletteRoles.ink, 0.8, frameDt);
			renderRoles.saturation = approach(renderRoles.saturation, paletteRoles.saturation, 1.6, frameDt);
			const detailMix = 1 - Math.exp(-frameDt / 0.06);
			for (let index = 0; index < BIN_COUNT; index += 1) {
				renderDetailBins[index] +=
					((spectrum.detailBins[index] ?? 0) - renderDetailBins[index]) * detailMix;
			}
		}

		// Song-time beat conveyor: integrated from tempo, gently pulled to the
		// director's phrase anchor so seeks snap and live drift never accumulates.
		const clock = directed.clock;
		const bpmTarget = clamp(clock.tempoBpm || 0, 0, 220);
		renderBpm = approach(renderBpm, bpmTarget >= 30 ? bpmTarget : 120, 2, frameDt);
		if (feat && smoothed.silence < 0.5) renderBeats += (motionDt * renderBpm) / 60;
		const anchor = beatAnchor(clock);
		if (feat && anchor !== null) {
			const diff = anchor - renderBeats;
			if (Math.abs(diff) > BEATS_PER_PHRASE * 0.75) renderBeats = anchor;
			else renderBeats += diff * (1 - Math.exp(-motionDt / 0.45));
		}
		smoothed.beatGlow = approach(
			smoothed.beatGlow,
			feat ? Math.exp(-clamp(clock.beatPhase, 0, 1) * 5) : 0,
			30,
			frameDt
		);

		const responseMotion = smoothed.responseMotion;
		const responseImpact = smoothed.responseImpact;
		const energy = clamp(smoothed.energy * 0.8 + smoothed.rms * 0.2, 0, 1);
		const impact = clamp(smoothed.impact * responseImpact, 0, 1);
		const fogDensity = clamp(pose.fogDensity * smoothed.responseFog, 0.03, 0.1);
		const shaftIntensity = clamp(pose.shaftIntensity * smoothed.responseShafts, 0.15, 0.85);

		// ── Held camera shot (phrase rails), as before.
		const shotZoom = clamp(1 + (pose.shotZoom - 1) * responseMotion, 0.9, 1.72);
		const closeStudy = clamp(pose.closeStudy * responseMotion, 0, 1);
		const detailFocus = clamp(pose.detailFocus * responseMotion, 0, 1);
		const zoomDelta = shotZoom - 1;
		let cameraOrbit = Math.pow(Math.max(0, pose.cameraOrbit), 1.75);
		let cameraProfile = Math.pow(Math.max(0, pose.cameraProfile), 1.75);
		let cameraOverhead = Math.pow(Math.max(0, pose.cameraOverhead), 1.75);
		let cameraLow = Math.pow(Math.max(0, pose.cameraLow), 1.75);
		let cameraMacro = Math.pow(Math.max(0, pose.cameraMacro), 1.75);
		const cameraWeightSum = Math.max(
			0.0001,
			cameraOrbit + cameraProfile + cameraOverhead + cameraLow + cameraMacro
		);
		cameraOrbit /= cameraWeightSum;
		cameraProfile /= cameraWeightSum;
		cameraOverhead /= cameraWeightSum;
		cameraLow /= cameraWeightSum;
		cameraMacro /= cameraWeightSum;
		const macroStudyRamp = clamp((closeStudy - 0.34) / 0.5, 0, 1);
		const intentionalMacro = clamp(cameraMacro * macroStudyRamp * (0.74 + detailFocus * 0.26), 0, 1);
		const effectiveZoomDelta = zoomDelta * (0.5 + intentionalMacro * 0.5);
		const dollyScale = 1 / (1 + effectiveZoomDelta * 0.3);
		const shotLens =
			cameraOrbit * 0.98 +
			cameraProfile * 1.06 +
			cameraOverhead * 1.0 +
			cameraLow * 0.94 +
			cameraMacro * 1.24;
		const fovScale = (shotLens + mk2SongSeed * 0.08) * (1 + effectiveZoomDelta * 0.08);

		const camPosRaw = getCameraPos(
			pose.perspectiveAzimuth,
			pose.perspectiveElevation,
			cameraOrbit,
			cameraProfile,
			cameraOverhead,
			cameraLow,
			cameraMacro
		);
		const cameraScale = pose.cameraDistance * dollyScale;
		const camPos: SomaVec3 = [
			camPosRaw[0] * cameraScale,
			Math.max(-1.35, camPosRaw[1] * cameraScale),
			camPosRaw[2] * cameraScale
		];
		const horizontal = Math.hypot(camPos[0], camPos[2]) || 1;
		const forwardH: SomaVec3 = [-camPos[0] / horizontal, 0, -camPos[2] / horizontal];
		const rightH: SomaVec3 = [-forwardH[2], 0, forwardH[0]];

		// ── Swim: the organism travels between seeded half-phrase waypoints.
		const divide = clamp(pose.gestureDivide + pose.topologyBilateral * 0.35, 0, 1);
		swimmer.update({
			dt: motionDt,
			beats: renderBeats,
			energy,
			motion: responseMotion,
			reach: pose.gestureReach,
			stillness: pose.gestureStillness,
			bloom: pose.bloomForm,
			dormancy: pose.dormancyForm,
			openness: pose.openness,
			silence: smoothed.silence,
			right: rightH,
			forward: forwardH
		});
		const bodyPos = swimmer.position;
		const bodyScale = clamp(
			0.9 + pose.growth * 0.22 + pose.bloomForm * 0.08 - pose.dormancyForm * 0.12 -
				pose.seedForm * 0.08 - pose.topologyCocoon * 0.05,
			0.7,
			1.2
		);

		// The aim only follows the organism part of the way, so it crosses the
		// frame; close studies follow more tightly to keep it in shot.
		const follow = 0.14 + closeStudy * 0.45;
		const framing = 1 - closeStudy * 0.34;
		const aim: SomaVec3 = [
			bodyPos[0] * follow + rightH[0] * pose.shotFramingX * framing,
			-0.12 + (bodyPos[1] + 0.12) * follow * 0.8 + pose.shotFramingY * framing,
			bodyPos[2] * follow + rightH[2] * pose.shotFramingX * framing
		];
		const aimFollow = snapAim ? 1 : 1 - Math.exp(-motionDt / 0.5);
		for (let axis = 0; axis < 3; axis += 1) {
			cameraTarget[axis] += (aim[axis] - cameraTarget[axis]) * aimFollow;
		}
		const fwd = normalize3([
			cameraTarget[0] - camPos[0],
			cameraTarget[1] - camPos[1],
			cameraTarget[2] - camPos[2]
		]);
		const right = normalize3(cross3(fwd, [0, 1, 0]));
		const sessionRoll = (mk2SongSeed - 0.5) * 0.12;
		const baseUp = cross3(right, fwd);
		const cr = Math.cos(sessionRoll);
		const sr = Math.sin(sessionRoll);
		const camRight: SomaVec3 = [
			right[0] * cr + baseUp[0] * sr,
			right[1] * cr + baseUp[1] * sr,
			right[2] * cr + baseUp[2] * sr
		];
		const camUp: SomaVec3 = [
			baseUp[0] * cr - right[0] * sr,
			baseUp[1] * cr - right[1] * sr,
			baseUp[2] * cr - right[2] * sr
		];

		// Organism frame: Y is the swim axis; X is the camera-horizontal right
		// projected onto the plane perpendicular to it.
		const basisY: SomaVec3 = [swimmer.axis[0], swimmer.axis[1], swimmer.axis[2]];
		const along = dot3(rightH, basisY);
		const basisX = normalize3([
			rightH[0] - basisY[0] * along,
			rightH[1] - basisY[1] * along,
			rightH[2] - basisY[2] * along
		]);
		const basisZ = cross3(basisX, basisY);
		const velocity = swimmer.velocity;
		const localVel: SomaVec3 = [
			dot3(velocity, basisX) / bodyScale,
			dot3(velocity, basisY) / bodyScale,
			dot3(velocity, basisZ) / bodyScale
		];

		{
			const v: SomaVec3 = [bodyPos[0] - camPos[0], bodyPos[1] - camPos[1], bodyPos[2] - camPos[2]];
			const depth = Math.max(0.1, dot3(v, fwd));
			bodyScreenX = (dot3(v, camRight) / depth) * fovScale / (0.5 * (w / h));
			bodyScreenY = (dot3(v, camUp) / depth) * fovScale / 0.5;
			bodyScreenTimer -= frameDt;
			if (bodyScreenTimer <= 0) {
				bodyScreenTimer = 0.25;
				bodyScreen = `${bodyScreenX.toFixed(2)},${bodyScreenY.toFixed(2)}`;
			}
		}

		// ── Post: trails shorten on impacts and in silence; bloom knee drops with
		// energy so drops glow while verses stay graphic.
		const feedbackFade =
			feedbackResetFrames > 0
				? 0
				: clamp((0.83 + energy * 0.06 - impact * 0.1) * (1 - smoothed.silence * 0.3), 0.4, 0.92);
		if (feedbackResetFrames > 0) feedbackResetFrames -= 1;
		const feedbackZoom = 1 - (0.0012 + smoothed.bass * 0.0018) * responseMotion;
		const bloomThreshold = 0.72 - energy * 0.16;
		const aberration = 1 + impact * 1.6;
		const keyMode =
			directed.context.keyMode === 'major' ? 1 : directed.context.keyMode === 'minor' ? -1 : 0;
		const phrase = renderBeats / BEATS_PER_PHRASE;
		const environmentVoid = clamp(pose.environmentVoid, 0, 1);

		const u = gpu.uniformData;
		u[0] = w;
		u[1] = h;
		u[2] = pose.environmentCavern;
		u[3] = qualityProfile.raymarchSteps;
		u[4] = smoothed.bass;
		u[5] = smoothed.mid;
		u[6] = smoothed.treble;
		u[7] = clamp(pose.environmentCellular * (1 - environmentVoid * 0.5), 0, 1);
		u[8] = energy;
		u[9] = impact;
		u[10] = clamp(smoothed.rootPulse * responseImpact * 0.8, 0, 1);
		u[11] = smoothed.beatGlow;
		u[12] = renderBeats;
		u[13] = pose.environmentHorizon;
		u[14] = swimmer.stroke * responseMotion;
		u[15] = smoothed.silence;
		u[16] = camPos[0];
		u[17] = camPos[1];
		u[18] = camPos[2];
		u[19] = fovScale;
		u[20] = fwd[0];
		u[21] = fwd[1];
		u[22] = fwd[2];
		u[23] = pose.environmentCurrent;
		u[24] = camRight[0];
		u[25] = camRight[1];
		u[26] = camRight[2];
		u[27] = mk2SongSeed;
		u[28] = camUp[0];
		u[29] = camUp[1];
		u[30] = camUp[2];
		u[31] = phrase;
		u[32] = bodyPos[0];
		u[33] = bodyPos[1];
		u[34] = bodyPos[2];
		u[35] = bodyScale;
		u[36] = basisX[0];
		u[37] = basisX[1];
		u[38] = basisX[2];
		u[39] = pose.topologyCoral;
		u[40] = basisY[0];
		u[41] = basisY[1];
		u[42] = basisY[2];
		u[43] = swimmer.wavePhase;
		u[44] = basisZ[0];
		u[45] = basisZ[1];
		u[46] = basisZ[2];
		u[47] = pose.topologySpire;
		u[48] = localVel[0];
		u[49] = localVel[1];
		u[50] = localVel[2];
		u[51] = keyMode;
		u[52] = renderRoles.base;
		u[53] = renderRoles.accent;
		u[54] = renderRoles.rim;
		u[55] = renderRoles.saturation;
		u[56] = renderRoles.ink;
		u[57] = pose.topologyShell;
		u[58] = pose.topologyTorus;
		u[59] = pose.materialCrystal;
		u[60] = pose.seedForm;
		u[61] = pose.sproutForm;
		u[62] = pose.windingForm;
		u[63] = pose.bloomForm;
		u[64] = pose.sheddingForm;
		u[65] = pose.dormancyForm;
		u[66] = renderPhases.morphPhase * 0.85 + renderPhases.spectralTravelPhase * 0.073;
		u[67] = clamp(pose.materialVelvet + pose.materialMineral * 0.5, 0, 1);
		u[68] = pose.rootMass;
		u[69] = pose.axialStretch;
		u[70] = pose.lobeSplit;
		u[71] = pose.foldDepth;
		u[72] = pose.cavityOpen;
		u[73] = pose.surfaceRidges;
		u[74] = pose.filamentReach;
		u[75] = pose.spectralLean;
		u[76] = pose.materialDensity;
		u[77] = pose.materialIridescence;
		u[78] = pose.materialErosion;
		u[79] = pose.growth;
		u[80] = pose.gestureReach;
		u[81] = pose.gestureCoil;
		u[82] = divide;
		u[83] = clamp(pose.gestureHollow + pose.materialMembrane * 0.25, 0, 1);
		u[84] = pose.gestureStillness;
		u[85] = pose.tension;
		u[86] = pose.openness;
		u[87] = pose.suspense;
		u[88] = fogDensity;
		u[89] = shaftIntensity;
		u[90] = renderPhases.backgroundFlowPhase;
		u[91] = pose.styleRhythmicDensity;
		u[92] = feedbackFade;
		u[93] = feedbackZoom;
		u[94] = bloomThreshold;
		u[95] = aberration;
		gpu.device.queue.writeBuffer(gpu.uniformBuf, 0, u.buffer, u.byteOffset, u.byteLength);
		gpu.device.queue.writeBuffer(
			gpu.binsBuf,
			0,
			renderDetailBins.buffer,
			renderDetailBins.byteOffset,
			renderDetailBins.byteLength
		);

		const submittingGpu = gpu;
		const submittingGeneration = initGeneration;
		try {
			const encoder = submittingGpu.device.createCommandEncoder({ label: 'Soma frame' });
			const previous = submittingGpu.parity;
			const next: 0 | 1 = previous === 0 ? 1 : 0;
			const fullscreen = (
				label: string,
				view: GPUTextureView,
				pipeline: GPURenderPipeline,
				bindGroup: GPUBindGroup
			) => {
				const pass = encoder.beginRenderPass({
					label,
					colorAttachments: [
						{ view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }
					]
				});
				pass.setPipeline(pipeline);
				pass.setBindGroup(0, bindGroup);
				pass.draw(3);
				pass.end();
			};
			// 1. scene (reads last frame's feedback for brine-pool reflections)
			fullscreen('Soma abyss', targets.sceneView, submittingGpu.pipelines.scene, bindGroups.scene[previous]);
			// 2. scene + feedback[previous] -> feedback[next]
			fullscreen(
				'Soma feedback',
				targets.feedbackViews[next],
				submittingGpu.pipelines.feedback,
				bindGroups.feedback[previous]
			);
			// 3. feedback[next] -> bloom[0] (half res, thresholded)
			fullscreen(
				'Soma bloom prefilter',
				targets.bloomViews[0],
				submittingGpu.pipelines.bloomDown,
				bindGroups.bloomDown[next]
			);
			// 4-7. two separable blur rounds
			for (let iteration = 0; iteration < 2; iteration += 1) {
				fullscreen('Soma bloom blur H', targets.bloomViews[1], submittingGpu.pipelines.blurH, bindGroups.blurH);
				fullscreen('Soma bloom blur V', targets.bloomViews[0], submittingGpu.pipelines.blurV, bindGroups.blurV);
			}
			// 8. composite -> swap chain
			fullscreen(
				'Soma present',
				submittingGpu.context.getCurrentTexture().createView(),
				submittingGpu.pipelines.composite,
				bindGroups.composite[next]
			);
			submittingGpu.device.queue.submit([encoder.finish()]);
			submittingGpu.parity = next;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			failGpuDevice(
				submittingGpu,
				submittingGeneration,
				`Soma could not encode or submit WebGPU work: ${detail}. Switch to another visualizer and back to retry; if it repeats, restart Mewsik or update the graphics driver.`
			);
			return;
		}
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
				temporalResetRequested = true;
				void g.device.lost.then((info) => {
					const reason = info.reason === 'destroyed' ? 'destroyed unexpectedly' : 'lost';
					const detail = info.message.trim();
					failGpuDevice(
						g,
						generation,
						`Soma's WebGPU device was ${reason}${detail ? `: ${detail}` : ''}. Switch to another visualizer and back to retry; if it repeats, restart Mewsik or update the graphics driver.`
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
			style="background: radial-gradient(circle at 50% 40%, #0a0b22 0%, #04040f 50%, #000 80%);"
			aria-hidden="true"
		></div>
		<canvas
			bind:this={canvas}
			class="relative z-10 h-full w-full transition-opacity duration-300"
			class:opacity-0={!gpuReady}
			aria-label="Soma audio visualizer"
			data-mk2-section={currentSection}
			data-mk2-form={currentForm}
			data-mk2-gesture={currentGesture}
			data-mk2-uniform-bytes={UNIFORM_BYTES}
			data-mk2-render-passes="8"
			data-soma-ready={String(gpuReady)}
			data-soma-body-screen={bodyScreen}
			data-soma-quality={qualityTier}
			data-soma-render-pixels={renderPixels}
			data-soma-max-pixels={SOMA_QUALITY_PROFILES[qualityTier].maxPixels}
			data-soma-frame-rate={SOMA_QUALITY_PROFILES[qualityTier].frameRate}
			data-soma-frame-stride={renderStride}
			data-soma-refresh-rate={measuredRefreshRate}
			data-soma-raymarch-steps={SOMA_QUALITY_PROFILES[qualityTier].raymarchSteps}
		></canvas>
		{#if errorMsg}
			<div class="pointer-events-none absolute left-6 top-16 z-30 max-w-md text-xs text-red-300/80">
				Visualizer error: {errorMsg}
			</div>
		{/if}
	</div>
{/if}
