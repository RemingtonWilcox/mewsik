<script lang="ts">
	// Mark III — "Field Choir" MVP
	//
	// Architectural pivot from mk1/mk2: instead of rendering ONE thing (kaleido
	// field / Mandelbulb hero), this builds a GPU-compute particle system —
	// 200K particles advected by a divergence-free curl-noise vector field,
	// rendered as instanced additive billboards. There is no central subject;
	// the visual emerges from how the particles flow.
	//
	// Why this breaks the plateau:
	//   • An SDF describes one continuous manifold — eye sees "one thing."
	//   • A particle cloud has no single subject — eye sees flow, swarm, life.
	//   • Curl noise is divergence-free → particles swirl coherently without
	//     compressing into "knots" or expanding into "voids." That's the
	//     "cohesive motion" pro VJs always have.
	//
	// MVP scope (this iteration):
	//   • Init compute → seed 200K particles in a sphere with random velocity.
	//   • Sim compute → curl-noise advection + audio-driven force injection.
	//   • Render → vertex pulling from storage buffer, instanced 2-tri billboards,
	//     additive blend, color from velocity magnitude + palette LUT.
	//   • Composite → ACES + grain.
	//
	// Deferred to later iterations: real Stam fluid field, instanced mesh
	// "petals" sampling the field, volumetric haze background, depth-aware
	// composite, all 12 audio routes wired.

	import { onMount, onDestroy } from 'svelte';
	import { useVisualizer } from '$lib/state/visualizer.svelte';
	import { usePlayer } from '$lib/state/player.svelte';
	import { createVisualDirector } from '$lib/visualizer/visual-director';
	import { stringHash01 } from '$lib/visualizer/director/util';

	const vis = useVisualizer();
	const player = usePlayer();
	const director = createVisualDirector();
	let { showHud = false } = $props<{ showHud?: boolean }>();

	let canvas = $state<HTMLCanvasElement | null>(null);
	let errorMsg = $state<string | null>(null);
	let raf = 0;
	let unsub: (() => void) | null = null;
	let running = false;

	// Per-TRACK identity seed: same song → same field character (curl-noise
	// scale, hue offset); different song → different world.
	let mk3TrackSeed = Math.random();
	let mk3TrackKey: string | null = null;
	// Drop burst envelope — spikes to 1 when a drop section lands, decays over
	// ~1.5s. Drives a radial impulse + spawn bloom + point-size pop so the
	// field visibly DETONATES on the drop instead of merely getting denser.
	let dropBurst = 0;
	let lastSectionMk3 = '';

	$effect(() => {
		const key = player.state.current_recording_id ?? player.state.current_source_url;
		if (key === mk3TrackKey) return;
		mk3TrackKey = key;
		if (!key) return;
		mk3TrackSeed = stringHash01(key);
		dropBurst = 0;
		lastSectionMk3 = '';
	});

	// Particle count — start at 100K for safety on integrated GPUs, can crank
	// later. Each particle is 32 bytes (pos vec3 + life + vel vec3 + seed).
	const PARTICLE_COUNT = 70000;
	const PARTICLE_STRIDE = 32;
	const PARTICLE_BUF_BYTES = PARTICLE_COUNT * PARTICLE_STRIDE;

	const smoothed = {
		bass: 0,
		mid: 0,
		treble: 0,
		centroidSlow: 0.5,
		rmsSlow: 0,
		flash: 0
	};

	function lerp(a: number, b: number, t: number) {
		return a + (b - a) * t;
	}
	function smoothstepJs(a: number, b: number, x: number) {
		const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
		return t * t * (3 - 2 * t);
	}

	// ──────────────────────────────────────────────────────────────────────────
	// State machine — calm / rising / peak / releasing. Each state defines a
	// FLOW ARCHETYPE (the particle dynamics fundamentally differ per state).
	// Detected via RMS+onset history over 8s rolling buffer.
	//
	// Plus a "silence gate": when audio has been silent for >0.5s, override
	// state and force everything toward zero motion. Kills the "embedded
	// metronome" feel — visual actually still when audio is still.
	// ──────────────────────────────────────────────────────────────────────────
	type SongState = 'calm' | 'rising' | 'peak' | 'releasing';
	type FlowArchetype = {
		flowStrength: number; // curl noise gain
		swirlStrength: number; // tangential vortex
		radialForce: number; // outward (+) / inward (−)
		damping: number; // velocity decay per step
		palOffset: number; // palette LUT position
		pointSize: number; // billboard size base
		camDistMul: number; // camera distance scale
		camSpeedMul: number; // camera traversal speed scale
	};
	const SILENCE_MOOD: FlowArchetype = {
		flowStrength: 0.05, // almost stopped
		swirlStrength: 0.0,
		radialForce: 0.0,
		damping: 0.995, // drag particles to rest
		palOffset: 0.02,
		pointSize: 0.006,
		camDistMul: 1.2,
		camSpeedMul: 0.0 // camera frozen
	};
	const STATE_ARCHETYPES: Record<SongState, FlowArchetype> = {
		calm: {
			flowStrength: 0.55,
			swirlStrength: 0.08,
			radialForce: -0.05,
			damping: 0.988,
			palOffset: 0.05,
			pointSize: 0.009,
			camDistMul: 1.25,
			camSpeedMul: 0.55
		},
		rising: {
			flowStrength: 1.15,
			swirlStrength: 0.55,
			radialForce: 0.15,
			damping: 0.978,
			palOffset: 0.42,
			pointSize: 0.012,
			camDistMul: 1.0,
			camSpeedMul: 1.1
		},
		peak: {
			flowStrength: 1.6,
			swirlStrength: 0.25,
			radialForce: 0.95,
			damping: 0.96,
			palOffset: 0.58,
			pointSize: 0.016,
			camDistMul: 0.82,
			camSpeedMul: 1.7
		},
		releasing: {
			flowStrength: 0.7,
			swirlStrength: 0.12,
			radialForce: -0.5,
			damping: 0.984,
			palOffset: 0.85,
			pointSize: 0.010,
			camDistMul: 1.15,
			camSpeedMul: 0.7
		}
	};

	let songState = $state<SongState>('calm');
	let stateEnterTime = 0;
	let previousMood: FlowArchetype = STATE_ARCHETYPES.calm;
	let isSilent = $state(false);
	let topologyName = $state('tube');
	let silenceStart = 0;
	const TOPOLOGY_NAMES = ['organism', 'tunnel', 'lattice', 'ribbon'];

	// 8-second rolling RMS + onset buffers @ ~60 Hz
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

	// ──────────────────────────────────────────────────────────────────────────
	// Init compute shader — seed each particle in a unit-sphere shell with a
	// small tangential velocity. Runs once per (re)init.
	// ──────────────────────────────────────────────────────────────────────────
	const INIT_WGSL = /* wgsl */ `
struct Particle {
	pos: vec3<f32>,
	life: f32,
	vel: vec3<f32>,
	seed: f32,
};

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;

fn hash13(p: vec3<f32>) -> f32 {
	var q = fract(p * vec3<f32>(0.1031, 0.1030, 0.0973));
	q = q + dot(q, q.yzx + 33.33);
	return fract((q.x + q.y) * q.z);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= arrayLength(&particles)) { return; }
	let fi = f32(i);
	let h1 = hash13(vec3<f32>(fi * 0.137, 13.7, fi * 0.091));
	let h2 = hash13(vec3<f32>(fi * 0.213, 27.3, fi * 0.157));
	let h3 = hash13(vec3<f32>(fi * 0.371, 41.9, fi * 0.229));
	let h4 = hash13(vec3<f32>(fi * 0.519, 53.2, fi * 0.311));
	// Distribute particles in an ELONGATED VOLUME along +Z, so a camera flying
	// forward traverses through density rather than orbiting an object.
	// X/Y small (±3) for "tube" feel; Z large (0..32) so there's depth ahead.
	let pos = vec3<f32>(
		(h1 - 0.5) * 6.0,
		(h2 - 0.5) * 6.0,
		h3 * 32.0
	);
	particles[i].pos = pos;
	particles[i].life = h4; // 0..1 age — randomized so deaths/births don't sync
	particles[i].vel = vec3<f32>(0.0, 0.0, 0.0);
	particles[i].seed = h2;
}
`;

	// ──────────────────────────────────────────────────────────────────────────
	// Sim compute shader — divergence-free curl noise. For each particle:
	//   F = (fbm(p+o1), fbm(p+o2), fbm(p+o3))
	//   v = curl(F)  (via finite differences)
	// Curl of any scalar potential field is divergence-free, so particle
	// density stays roughly constant — no compression/voids.
	// ──────────────────────────────────────────────────────────────────────────
	const SIM_WGSL = /* wgsl */ `
struct Particle {
	pos: vec3<f32>,
	life: f32,
	vel: vec3<f32>,
	seed: f32,
};

struct SimParams {
	dt: f32,
	time: f32,
	bass: f32,
	mid: f32,
	treble: f32,
	rms: f32,
	flowScale: f32,
	flowStrength: f32,
	damping: f32,
	radialPull: f32,
	swirlStrength: f32,
	radialForce: f32,
	// Recycling — particles behind cam.z - tailDist respawn at cam.z + headDist
	camZ: f32,
	tailDist: f32,
	headDist: f32,
	spawnSpread: f32, // xy radius of new-spawn distribution
	topology: f32,    // 0=tube, 1=helix, 2=lattice, 3=ribbon
	chromaKey: f32,
	phrase: f32,
	_pad0: f32,
};

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> p: SimParams;

fn hash13(q: vec3<f32>) -> f32 {
	var r = fract(q * vec3<f32>(0.1031, 0.1030, 0.0973));
	r = r + dot(r, r.yzx + 33.33);
	return fract((r.x + r.y) * r.z);
}

fn noise3(p: vec3<f32>) -> f32 {
	let i = floor(p);
	let f = fract(p);
	let u = f * f * (3.0 - 2.0 * f);
	let n000 = hash13(i + vec3<f32>(0.0, 0.0, 0.0));
	let n100 = hash13(i + vec3<f32>(1.0, 0.0, 0.0));
	let n010 = hash13(i + vec3<f32>(0.0, 1.0, 0.0));
	let n110 = hash13(i + vec3<f32>(1.0, 1.0, 0.0));
	let n001 = hash13(i + vec3<f32>(0.0, 0.0, 1.0));
	let n101 = hash13(i + vec3<f32>(1.0, 0.0, 1.0));
	let n011 = hash13(i + vec3<f32>(0.0, 1.0, 1.0));
	let n111 = hash13(i + vec3<f32>(1.0, 1.0, 1.0));
	let x00 = mix(n000, n100, u.x);
	let x10 = mix(n010, n110, u.x);
	let x01 = mix(n001, n101, u.x);
	let x11 = mix(n011, n111, u.x);
	return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

// 2-octave fbm — fast enough at 100K×3-axis×6-samples per frame.
fn fbm2(p: vec3<f32>) -> f32 {
	return noise3(p) * 0.6 + noise3(p * 2.07 + vec3<f32>(13.0, 7.0, 19.0)) * 0.3;
}

fn potential(q: vec3<f32>, t: f32) -> vec3<f32> {
	let pt = q + vec3<f32>(t * 0.1, t * 0.07, t * 0.13);
	return vec3<f32>(
		fbm2(pt),
		fbm2(pt + vec3<f32>(31.7, 11.3, 47.1)),
		fbm2(pt + vec3<f32>(73.5, 91.2, 17.9))
	);
}

fn curl(q: vec3<f32>, t: f32) -> vec3<f32> {
	let h = 0.08;
	let dxp = potential(q + vec3<f32>(h, 0.0, 0.0), t);
	let dxn = potential(q - vec3<f32>(h, 0.0, 0.0), t);
	let dyp = potential(q + vec3<f32>(0.0, h, 0.0), t);
	let dyn = potential(q - vec3<f32>(0.0, h, 0.0), t);
	let dzp = potential(q + vec3<f32>(0.0, 0.0, h), t);
	let dzn = potential(q - vec3<f32>(0.0, 0.0, h), t);
	let inv = 1.0 / (2.0 * h);
	return vec3<f32>(
		(dyp.z - dyn.z) * inv - (dzp.y - dzn.y) * inv,
		(dzp.x - dzn.x) * inv - (dxp.z - dxn.z) * inv,
		(dxp.y - dxn.y) * inv - (dyp.x - dyn.x) * inv
	);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= arrayLength(&particles)) { return; }
	var part = particles[i];

	// Sample curl noise at scaled position (still 3D, just at different scale).
	let q = part.pos * p.flowScale + part.seed * 7.3;
	let force = curl(q, p.time) * p.flowStrength;

	// Local axis system relative to particle's POSITION FROM CAMERA — gives
	// "swirl around camera path" feel instead of "swirl around origin."
	let relPos = vec3<f32>(part.pos.x, part.pos.y, part.pos.z - p.camZ);
	let radial = normalize(relPos + vec3<f32>(1e-4, 0.0, 0.0));
	let tangent = cross(radial, vec3<f32>(0.0, 0.0, 1.0));
	let archetypeForce = tangent * p.swirlStrength + radial * p.radialForce;
	let audioKick = radial * p.bass * 0.35 + tangent * p.mid * 0.20;

	// Song-scale spatial grammar. This is the variety layer: particles do not
	// crossfade between visualizers; one living field is gently re-attracted into
	// different formations as phrase/chroma drift over time.
	var topologyForce = vec3<f32>(0.0);
	let phase = p.phrase * 6.2831853 + p.chromaKey * 0.29;
	if (p.topology > 0.5 && p.topology < 1.5) {
		// Helix / double-strand molecular tunnel.
		let strand = floor(part.seed * 3.0);
		let angle = relPos.z * (0.46 + p.mid * 0.18) + phase + strand * 2.0943951;
		let radius = 1.15 + p.bass * 1.35 + part.seed * 0.65;
		let topoTarget = vec2<f32>(cos(angle), sin(angle)) * radius;
		topologyForce = vec3<f32>(topoTarget - part.pos.xy, 0.0) * (0.55 + p.rms * 0.55);
	} else if (p.topology >= 1.5 && p.topology < 2.5) {
		// Lattice / cathedral dust: particles bias toward moving grid struts.
		let cell = 1.35 + p.chromaKey * 0.035;
		let gx = round((part.pos.x + sin(relPos.z * 0.18 + phase) * 0.35) / cell) * cell;
		let gy = round((part.pos.y + cos(relPos.z * 0.15 + phase) * 0.35) / cell) * cell;
		let dx = abs(part.pos.x - gx);
		let dy = abs(part.pos.y - gy);
		let topoTarget = select(vec2<f32>(part.pos.x, gy), vec2<f32>(gx, part.pos.y), dx < dy);
		topologyForce = vec3<f32>(topoTarget - part.pos.xy, 0.0) * (0.42 + p.mid * 0.45);
	} else if (p.topology >= 2.5) {
		// Ribbon / sheet organism: a slow flexible membrane through the tunnel.
		let waveY = sin(relPos.z * 0.34 + phase) * (1.0 + p.mid * 1.2)
			+ sin(part.pos.x * 1.65 + phase * 0.7) * 0.45;
		let waveX = sin(relPos.z * 0.19 + part.seed * 6.2831853 + phase) * (1.3 + p.bass);
		topologyForce = vec3<f32>(waveX - part.pos.x, waveY - part.pos.y, 0.0) * 0.45;
	}

	// Soft pull back to tube center (xy=0) so particles don't escape laterally.
	let lateralD = length(part.pos.xy);
	let pull = -vec3<f32>(part.pos.x, part.pos.y, 0.0)
		* (max(0.0, lateralD - 3.5) * p.radialPull);

	// Integrate
	part.vel = part.vel * p.damping + (force + archetypeForce + audioKick + topologyForce + pull) * p.dt;
	part.pos = part.pos + part.vel * p.dt;
	part.life = part.life + p.dt * (0.05 + p.treble * 0.10);
	if (part.life > 1.0) { part.life = part.life - 1.0; }

	// ── Recycle: when particle is too far behind camera (or way ahead),
	// respawn it ahead of camera with fresh random position. "Molecule by
	// molecule frame by frame" — the field is continuously regenerated.
	if (part.pos.z < p.camZ - p.tailDist || part.pos.z > p.camZ + p.headDist * 2.0) {
		let h1 = hash13(vec3<f32>(f32(i) * 0.137, p.time * 31.1, f32(i) * 0.091));
		let h2 = hash13(vec3<f32>(f32(i) * 0.213, p.time * 17.3, f32(i) * 0.157));
		let h3 = hash13(vec3<f32>(f32(i) * 0.371, p.time * 7.7, f32(i) * 0.229));
		part.pos = vec3<f32>(
			(h1 - 0.5) * 2.0 * p.spawnSpread,
			(h2 - 0.5) * 2.0 * p.spawnSpread,
			p.camZ + h3 * p.headDist + 1.5
		);
		if (p.topology > 0.5 && p.topology < 1.5) {
			let angle = (p.camZ + h3 * p.headDist) * 0.46 + phase + floor(h2 * 3.0) * 2.0943951;
			let radius = 1.2 + h1 * 1.2 + p.bass;
			part.pos.x = cos(angle) * radius;
			part.pos.y = sin(angle) * radius;
		} else if (p.topology >= 1.5 && p.topology < 2.5) {
			let cell = 1.35 + p.chromaKey * 0.035;
			if (h1 < 0.5) {
				part.pos.x = round(part.pos.x / cell) * cell;
			} else {
				part.pos.y = round(part.pos.y / cell) * cell;
			}
		} else if (p.topology >= 2.5) {
			part.pos.x = sin(part.pos.z * 0.19 + h2 * 6.2831853 + phase) * (1.3 + p.bass);
			part.pos.y = sin(part.pos.z * 0.34 + phase) * (1.0 + p.mid);
		}
		part.vel = vec3<f32>(0.0, 0.0, 0.0);
		part.life = 0.0; // birth
		part.seed = h2; // reseed species so recycled particles vary
	}

	particles[i] = part;
}
`;

	// ──────────────────────────────────────────────────────────────────────────
	// Render — vertex pulling from particle storage buffer. Each instance is
	// a 2-triangle billboard facing the camera. Color from velocity magnitude
	// + palette LUT. Additive blend into HDR target.
	// ──────────────────────────────────────────────────────────────────────────
	const RENDER_WGSL = /* wgsl */ `
struct Particle {
	pos: vec3<f32>,
	life: f32,
	vel: vec3<f32>,
	seed: f32,
};

struct ViewParams {
	viewProj0: vec4<f32>,
	viewProj1: vec4<f32>,
	viewProj2: vec4<f32>,
	viewProj3: vec4<f32>,
	camRight: vec3<f32>,
	pointSize: f32,
	camUp: vec3<f32>,
	paletteOffset: f32,
	bass: f32,
	mid: f32,
	treble: f32,
	flash: f32,
};

@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<uniform> v: ViewParams;

struct VsOut {
	@builtin(position) pos: vec4<f32>,
	@location(0) uvLocal: vec2<f32>,
	@location(1) velMag: f32,
	@location(2) seed: f32,
	@location(3) life: f32,
	@location(4) viewDepth: f32,
};

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

// 5 particle species — selected by hashing the per-particle seed.
// Each species has its own size scale, palette offset bias, and brightness
// behavior, so the cloud reads as a swarm of *different things* not a
// uniform fog.
//   0: sparkle — tiny, bright, short-lived feel via velMag-driven brightness
//   1: streak  — narrow long, velocity-stretched
//   2: nebulous — large, soft, dimmer base
//   3: fast-mover — small, velocity-amplified
//   4: slow-glow — medium, steady warm brightness
struct Species {
	sizeMul: f32,
	stretchMul: f32, // billboard stretch along velocity direction
	brightnessMul: f32,
	palBias: f32,
};
fn pickSpecies(seed: f32) -> Species {
	let idx = i32(floor(seed * 5.0)) % 5;
	if (idx == 0) { return Species(0.42, 0.0, 1.15, 0.30); }
	if (idx == 1) { return Species(0.70, 2.1, 0.82, 0.55); }
	if (idx == 2) { return Species(1.25, 0.2, 0.38, 0.15); }
	if (idx == 3) { return Species(0.55, 1.1, 0.92, 0.70); }
	return Species(0.82, 0.35, 0.65, 0.85);
}

@vertex
fn vs_main(
	@builtin(vertex_index) vIdx: u32,
	@builtin(instance_index) iIdx: u32
) -> VsOut {
	let part = particles[iIdx];
	let sp = pickSpecies(part.seed);
	// 2-triangle quad in local space
	var corners = array<vec2<f32>, 6>(
		vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
		vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0)
	);
	let c = corners[vIdx];
	let velMag = length(part.vel);
	let velDir = part.vel / max(velMag, 1e-3);
	// Per-species billboard. Streak species stretch along velocity in world space.
	let size = v.pointSize * sp.sizeMul * (1.0 + velMag * 0.4);
	let stretchAxis = v.camRight * dot(velDir, v.camRight) + v.camUp * dot(velDir, v.camUp);
	let stretch = stretchAxis * c.x * size * sp.stretchMul;
	let worldPos = part.pos + (v.camRight * c.x + v.camUp * c.y) * size + stretch;
	// viewProj is row-major in the uniform
	let vp = mat4x4<f32>(
		v.viewProj0,
		v.viewProj1,
		v.viewProj2,
		v.viewProj3
	);
	let clip = vp * vec4<f32>(worldPos, 1.0);
	var out: VsOut;
	out.pos = clip;
	out.uvLocal = c;
	out.velMag = velMag;
	out.seed = part.seed;
	out.life = part.life;
	out.viewDepth = clip.w;
	return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
	let sp = pickSpecies(in.seed);
	if (fract(in.seed * 17.37) < 0.12) { discard; }
	let d = length(in.uvLocal);
	let depthGate = smoothstep(1.4, 8.0, in.viewDepth) * (1.0 - smoothstep(30.0, 58.0, in.viewDepth));
	let lifeGate = smoothstep(0.03, 0.16, in.life) * (1.0 - smoothstep(0.84, 1.0, in.life));
	let motionGate = 0.32 + smoothstep(0.04, 0.52, in.velMag) * 0.68;
	// Soft particle with lifecycle/depth gating. This leaves negative space and
	// makes the cloud read as authored formations instead of screen-filling dust.
	let audioGate = 0.42 + v.bass * 0.24 + v.mid * 0.16 + v.treble * 0.08;
	let alpha = exp(-d * d * 5.6) * depthGate * lifeGate * motionGate * audioGate * 1.18;
	if (alpha < 0.0035) { discard; }
	// Palette: species injects its own bias so each class sits in a different
	// palette zone — variety reads as different "kinds" of particles.
	let palT = v.paletteOffset + sp.palBias + in.seed * 0.35 + in.velMag * 0.15 + in.life * 0.25;
	let col = palette7(palT) * (0.82 + in.velMag * 1.35) * sp.brightnessMul * (0.95 + v.flash * 0.35);
	return vec4<f32>(col * alpha * 1.65, alpha * 0.95);
}
`;

	// ──────────────────────────────────────────────────────────────────────────
	// Sky / atmospheric background — renders ONCE per frame to sceneTex BEFORE
	// particles. Fills the void with depth-feeling FBM noise + palette gradient
	// + slow drift, so the fish-eye corners of the particle cloud aren't bordered
	// by hard black. Audio-modulated brightness so it breathes with the music.
	// ──────────────────────────────────────────────────────────────────────────
	const SKY_WGSL = /* wgsl */ `
struct SkyParams {
	resX: f32,
	resY: f32,
	time: f32,
	paletteOffset: f32,
	rms: f32,
	bass: f32,
	cloudPhase: f32, // long-arc drift phase
	intensity: f32,  // overall sky intensity (state-driven)
};

@group(0) @binding(0) var<uniform> p: SkyParams;

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

fn hash21(q: vec2<f32>) -> f32 {
	return fract(sin(dot(q, vec2<f32>(127.1, 311.7))) * 43758.5453);
}
fn noise2(q: vec2<f32>) -> f32 {
	let i = floor(q);
	let f = fract(q);
	let u = f * f * (3.0 - 2.0 * f);
	let a = hash21(i);
	let b = hash21(i + vec2<f32>(1.0, 0.0));
	let c = hash21(i + vec2<f32>(0.0, 1.0));
	let d = hash21(i + vec2<f32>(1.0, 1.0));
	return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn fbm(q: vec2<f32>) -> f32 {
	var v = 0.0;
	var a = 0.5;
	var p = q;
	for (var i: i32 = 0; i < 5; i = i + 1) {
		v = v + a * noise2(p);
		p = p * 2.07 + vec2<f32>(13.0, 7.0);
		a = a * 0.5;
	}
	return v;
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let res = vec2<f32>(p.resX, p.resY);
	let uv = (frag.xy - 0.5 * res) / res.y;

	// Two atmospheric layers at different scales drift in opposite directions
	// at very slow speeds (cloudPhase advances ~0.01/sec) so the sky reads
	// as alive but doesn't fight the particles for attention.
	let layer1 = fbm(uv * 1.3 + vec2<f32>(p.cloudPhase * 0.5, p.cloudPhase * 0.3));
	let layer2 = fbm(uv * 2.5 - vec2<f32>(p.cloudPhase * 0.3, -p.cloudPhase * 0.4) + 50.0);
	let cloud = smoothstep(0.25, 0.85, layer1 * 0.7 + layer2 * 0.3);

	// Radial gradient — deeper toward center where particles live, brighter
	// in the outer "atmosphere" so the corners read as ambient depth.
	let r = length(uv);
	let radialT = smoothstep(0.0, 1.6, r);

	// Two-tone palette sample: deep at center, atmospheric at edge.
	let deepCol = palette7(p.paletteOffset);
	let atmoCol = palette7(p.paletteOffset + 0.45);
	let baseCol = mix(deepCol * 0.16, atmoCol * 0.24, radialT);
	// Cloud contribution adds soft highlights modulated by audio.
	let cloudCol = palette7(p.paletteOffset + 0.6) * cloud * (0.045 + p.rms * 0.12 + p.bass * 0.07);

	let col = (baseCol + cloudCol) * p.intensity;
	return vec4<f32>(col, 1.0);
}
`;

	// ──────────────────────────────────────────────────────────────────────────
	// Composite — read HDR particle target, ACES tonemap + grain + dither.
	// ──────────────────────────────────────────────────────────────────────────
	const COMPOSITE_WGSL = /* wgsl */ `
struct PostParams {
	resX: f32,
	resY: f32,
	time: f32,
	flash: f32,
	treble: f32,
	_pad0: f32,
	_pad1: f32,
	_pad2: f32,
};

@group(0) @binding(0) var<uniform> p: PostParams;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var sceneTex: texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	var pos = array<vec2<f32>, 6>(
		vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
		vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0)
	);
	return vec4<f32>(pos[idx], 0.0, 1.0);
}

fn aces(x: vec3<f32>) -> vec3<f32> {
	let a = 2.51;
	let b = 0.03;
	let c = 2.43;
	let d = 0.59;
	let e = 0.14;
	return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn hash13(q: vec3<f32>) -> f32 {
	var r = fract(q * vec3<f32>(0.1031, 0.1030, 0.0973));
	r = r + dot(r, r.yzx + 33.33);
	return fract((r.x + r.y) * r.z);
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let res = vec2<f32>(p.resX, p.resY);
	let uv = frag.xy / res;
	let centered = uv - 0.5;
	let r2 = dot(centered, centered);
	let caAmt = (0.0010 + r2 * 0.005) * (1.0 + p.flash * 0.8);
	let dir = normalize(centered + vec2<f32>(1e-4, 1e-4));
	let r = textureSample(sceneTex, samp, uv + dir * caAmt).r;
	let g = textureSample(sceneTex, samp, uv).g;
	let b = textureSample(sceneTex, samp, uv - dir * caAmt).b;
	var col = vec3<f32>(r, g, b);
	col = aces(col);
	col = max((col - 0.30) * 1.06 + 0.30, vec3<f32>(0.0));
	let grain = (hash13(vec3<f32>(frag.xy, p.time * 7.31)) - 0.5);
	col = col + vec3<f32>(grain) * (0.020 + p.treble * 0.015);
	let h = fract(sin(dot(frag.xy, vec2<f32>(12.9898, 78.233)) + p.time) * 43758.5453);
	col = col + (h - 0.5) / 255.0;
	// Vignette
	let vig = smoothstep(1.2, 0.45, length(centered) * 1.35);
	col = col * (0.75 + 0.25 * vig);
	return vec4<f32>(col, 1.0);
}
`;

	// Matrix helpers — column-major, mat4 stored as 16 floats.
	function mat4Mul(a: number[], b: number[]): number[] {
		const r = new Array(16).fill(0);
		for (let col = 0; col < 4; col++) {
			for (let row = 0; row < 4; row++) {
				for (let k = 0; k < 4; k++) {
					r[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
				}
			}
		}
		return r;
	}

	function perspective(fovY: number, aspect: number, n: number, f: number): number[] {
		const t = 1 / Math.tan(fovY / 2);
		// Column-major perspective (z mapped to 0..1 like WebGPU)
		return [
			t / aspect, 0, 0, 0,
			0, t, 0, 0,
			0, 0, f / (n - f), -1,
			0, 0, (n * f) / (n - f), 0
		];
	}

	function lookAt(eye: [number, number, number], at: [number, number, number], up: [number, number, number]): number[] {
		const fx = at[0] - eye[0],
			fy = at[1] - eye[1],
			fz = at[2] - eye[2];
		const fLen = Math.hypot(fx, fy, fz) || 1;
		const fnx = fx / fLen,
			fny = fy / fLen,
			fnz = fz / fLen;
		// s = f × up
		const sx = fny * up[2] - fnz * up[1];
		const sy = fnz * up[0] - fnx * up[2];
		const sz = fnx * up[1] - fny * up[0];
		const sLen = Math.hypot(sx, sy, sz) || 1;
		const snx = sx / sLen,
			sny = sy / sLen,
			snz = sz / sLen;
		// u = s × f
		const ux = sny * fnz - snz * fny;
		const uy = snz * fnx - snx * fnz;
		const uz = snx * fny - sny * fnx;
		// Column-major view matrix
		return [
			snx, ux, -fnx, 0,
			sny, uy, -fny, 0,
			snz, uz, -fnz, 0,
			-(snx * eye[0] + sny * eye[1] + snz * eye[2]),
			-(ux * eye[0] + uy * eye[1] + uz * eye[2]),
			fnx * eye[0] + fny * eye[1] + fnz * eye[2],
			1
		];
	}

	type GPU = {
		device: GPUDevice;
		context: GPUCanvasContext;
		format: GPUTextureFormat;
		sampler: GPUSampler;
		particleBuf: GPUBuffer;
		simParamBuf: GPUBuffer;
		viewParamBuf: GPUBuffer;
		postParamBuf: GPUBuffer;
		skyParamBuf: GPUBuffer;
		pipelines: {
			init: GPUComputePipeline;
			sim: GPUComputePipeline;
			sky: GPURenderPipeline;
			render: GPURenderPipeline;
			composite: GPURenderPipeline;
		};
		bgs: {
			init: GPUBindGroup;
			sim: GPUBindGroup;
			sky: GPUBindGroup;
			render: GPUBindGroup;
			composite: GPUBindGroup;
		};
		targets: {
			scene: GPUTexture;
			sceneView: GPUTextureView;
			depthTex: GPUTexture;
			depthView: GPUTextureView;
			width: number;
			height: number;
		} | null;
		initialized: boolean;
	};

	let gpu: GPU | null = null;
	const t0 = performance.now();
	let lastTime = 0;
	let camPhase = 0;

	function buildTargets(device: GPUDevice, w: number, h: number) {
		const hdr: GPUTextureFormat = 'rgba16float';
		const scene = device.createTexture({
			size: { width: Math.max(1, w), height: Math.max(1, h) },
			format: hdr,
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
		});
		const depthTex = device.createTexture({
			size: { width: Math.max(1, w), height: Math.max(1, h) },
			format: 'depth24plus',
			usage: GPUTextureUsage.RENDER_ATTACHMENT
		});
		return {
			scene,
			sceneView: scene.createView(),
			depthTex,
			depthView: depthTex.createView(),
			width: w,
			height: h
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
			errorMsg = 'WebGPU canvas context unavailable.';
			return null;
		}
		const format = gpuApi.getPreferredCanvasFormat() as GPUTextureFormat;
		context.configure({ device, format, alphaMode: 'opaque' });

		const hdr: GPUTextureFormat = 'rgba16float';

		// Particle storage buffer
		const particleBuf = device.createBuffer({
			size: PARTICLE_BUF_BYTES,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});
		// Sim params: 20 f32s = 80 bytes.
		const simParamBuf = device.createBuffer({
			size: 80,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
		// View params: viewProj 4 vec4 + camRight vec3 + pointSize + camUp vec3 + palette + 4 floats
		// 16 + 4 + 4 + 4 = 28 f32s, round to 32 = 128 bytes
		const viewParamBuf = device.createBuffer({
			size: 128,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
		// Post params: 8 f32s = 32 bytes
		const postParamBuf = device.createBuffer({
			size: 32,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
		// Sky params: 8 f32s = 32 bytes
		const skyParamBuf = device.createBuffer({
			size: 32,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});

		// Compute pipelines
		const initModule = device.createShaderModule({ code: INIT_WGSL });
		const initPipeline = device.createComputePipeline({
			layout: 'auto',
			compute: { module: initModule, entryPoint: 'cs_main' }
		});
		const simModule = device.createShaderModule({ code: SIM_WGSL });
		const simPipeline = device.createComputePipeline({
			layout: 'auto',
			compute: { module: simModule, entryPoint: 'cs_main' }
		});

		// Render pipeline — additive blend, no depth write (z-test off so particles
		// can overlap freely).
		const renderModule = device.createShaderModule({ code: RENDER_WGSL });
		const renderPipeline = device.createRenderPipeline({
			layout: 'auto',
			vertex: { module: renderModule, entryPoint: 'vs_main' },
			fragment: {
				module: renderModule,
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
			primitive: { topology: 'triangle-list' },
			depthStencil: {
				format: 'depth24plus',
				depthWriteEnabled: false,
				depthCompare: 'always'
			}
		});

		// Sky pipeline — writes to HDR sceneTex BEFORE particles, no blend.
		const skyModule = device.createShaderModule({ code: SKY_WGSL });
		const skyPipeline = device.createRenderPipeline({
			layout: 'auto',
			vertex: { module: skyModule, entryPoint: 'vs_main' },
			fragment: {
				module: skyModule,
				entryPoint: 'fs_main',
				targets: [{ format: hdr }]
			},
			primitive: { topology: 'triangle-list' }
		});

		// Composite pipeline
		const compModule = device.createShaderModule({ code: COMPOSITE_WGSL });
		const compPipeline = device.createRenderPipeline({
			layout: 'auto',
			vertex: { module: compModule, entryPoint: 'vs_main' },
			fragment: {
				module: compModule,
				entryPoint: 'fs_main',
				targets: [{ format }]
			},
			primitive: { topology: 'triangle-list' }
		});

		const sampler = device.createSampler({
			magFilter: 'linear',
			minFilter: 'linear',
			addressModeU: 'clamp-to-edge',
			addressModeV: 'clamp-to-edge'
		});

		// Bind groups
		const initBG = device.createBindGroup({
			layout: initPipeline.getBindGroupLayout(0),
			entries: [{ binding: 0, resource: { buffer: particleBuf } }]
		});
		const simBG = device.createBindGroup({
			layout: simPipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: particleBuf } },
				{ binding: 1, resource: { buffer: simParamBuf } }
			]
		});
		const renderBG = device.createBindGroup({
			layout: renderPipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: particleBuf } },
				{ binding: 1, resource: { buffer: viewParamBuf } }
			]
		});
		const skyBG = device.createBindGroup({
			layout: skyPipeline.getBindGroupLayout(0),
			entries: [{ binding: 0, resource: { buffer: skyParamBuf } }]
		});
		// Composite needs sceneTex — that requires targets; we'll bind it lazily.
		const compBG = device.createBindGroup({
			layout: compPipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: postParamBuf } },
				{ binding: 1, resource: sampler },
				// We need a real texture here — placeholder for now, rebuilt later.
				{ binding: 2, resource: device.createTexture({ size: { width: 1, height: 1 }, format: hdr, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT }).createView() }
			]
		});

		return {
			device,
			context,
			format,
			sampler,
			particleBuf,
			simParamBuf,
			viewParamBuf,
			postParamBuf,
			skyParamBuf,
			pipelines: {
				init: initPipeline,
				sim: simPipeline,
				sky: skyPipeline,
				render: renderPipeline,
				composite: compPipeline
			},
			bgs: { init: initBG, sim: simBG, sky: skyBG, render: renderBG, composite: compBG },
			targets: null,
			initialized: false
		};
	}

	function ensureTargets(g: GPU, w: number, h: number) {
		if (g.targets && g.targets.width === w && g.targets.height === h) return;
		if (g.targets) {
			g.targets.scene.destroy();
			g.targets.depthTex.destroy();
		}
		g.targets = buildTargets(g.device, w, h);
		// Rebuild composite bind group to point at the new sceneTex.
		g.bgs.composite = g.device.createBindGroup({
			layout: g.pipelines.composite.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: g.postParamBuf } },
				{ binding: 1, resource: g.sampler },
				{ binding: 2, resource: g.targets.sceneView }
			]
		});
	}

	function teardownGpu() {
		if (!gpu) return;
		try {
			if (gpu.targets) {
				gpu.targets.scene.destroy();
				gpu.targets.depthTex.destroy();
			}
			gpu.particleBuf.destroy();
			gpu.simParamBuf.destroy();
			gpu.viewParamBuf.destroy();
			gpu.postParamBuf.destroy();
			gpu.skyParamBuf.destroy();
			gpu.device.destroy?.();
		} catch {}
		gpu = null;
	}

	function loop() {
		if (!running || !canvas || !gpu) {
			if (running) raf = requestAnimationFrame(loop);
			return;
		}
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
		const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		ensureTargets(gpu, w, h);
		if (!gpu.targets) {
			raf = requestAnimationFrame(loop);
			return;
		}

		const time = (performance.now() - t0) / 1000;
		const dt = Math.min(0.05, time - lastTime);
		lastTime = time;

		const feat = vis.latest;
		const directed = director.update(feat, time);
		smoothed.bass = lerp(smoothed.bass, feat?.bass ?? 0, 0.25);
		smoothed.mid = lerp(smoothed.mid, feat?.mid ?? 0, 0.18);
		smoothed.treble = lerp(smoothed.treble, feat?.treble ?? 0, 0.32);
		smoothed.centroidSlow = lerp(smoothed.centroidSlow, feat?.centroid ?? 0.5, 0.015);
		smoothed.rmsSlow = lerp(smoothed.rmsSlow, feat?.rms ?? 0, 0.02);
		if (feat?.onset) smoothed.flash = 1;
		smoothed.flash *= 0.88;

		// ── Silence gate: detect sustained silence (RMS < 0.02 for >0.5s).
		// When silent, override everything to SILENCE_MOOD so motion actually stops.
		const rawRms = feat?.rms ?? 0;
		if (directed.silence) {
			if (!isSilent) silenceStart = time;
			isSilent = true;
		} else {
			silenceStart = time;
			isSilent = false;
		}

		// ── State machine — only runs when NOT silent. Feeds history, computes
		// window stats, transitions on detected events.
		pushHist(rawRms, feat?.onset ? 1 : 0);
		const WS = 120; // ~2s
		const rmsNow = avgWindow(rmsHist, 0, WS);
		const rmsAgo = avgWindow(rmsHist, WS * 2, WS);
		const onsetNow = avgWindow(onsetHist, 0, WS) * WS;
		const onsetAgo = avgWindow(onsetHist, WS * 2, WS) * WS;
		const rmsDelta = rmsNow - rmsAgo;
		const onsetRatio = onsetNow / Math.max(1, onsetAgo);
		const timeInState = time - stateEnterTime;
		const transitionTo = (next: SongState) => {
			if (next !== songState) {
				previousMood = { ...STATE_ARCHETYPES[songState] };
				songState = next;
				stateEnterTime = time;
			}
		};
		if (!isSilent) {
			switch (songState) {
				case 'calm':
					if (timeInState > 2.5 && rmsDelta > 0.03 && onsetRatio > 1.3) {
						transitionTo('rising');
					}
					break;
				case 'rising':
					if (rmsNow > 0.32 || (rmsDelta > 0.08 && onsetRatio > 2.0)) {
						transitionTo('peak');
					} else if (timeInState > 12 && rmsDelta < 0) {
						transitionTo('releasing');
					}
					break;
				case 'peak':
					if (timeInState > 3 && rmsDelta < -0.04) {
						transitionTo('releasing');
					}
					break;
				case 'releasing':
					if (rmsNow < 0.10 && timeInState > 2) {
						transitionTo('calm');
					} else if (rmsDelta > 0.05 && timeInState > 3) {
						transitionTo('rising');
					}
					break;
			}
		}

		// LERP from previous mood snapshot → target mood, over 4s. When silent,
		// target is SILENCE_MOOD (motion winds down).
		const target = isSilent ? SILENCE_MOOD : STATE_ARCHETYPES[songState];
		const transT = isSilent
			? smoothstepJs(0, 1, Math.min(1, (time - silenceStart) / 1.5))
			: smoothstepJs(0, 1, Math.min(1, timeInState / 4.0));
		let flowStrength = lerp(previousMood.flowStrength, target.flowStrength, transT);
		let swirlStrength = lerp(previousMood.swirlStrength, target.swirlStrength, transT);
		let radialForce = lerp(previousMood.radialForce, target.radialForce, transT);
		const dampingState = lerp(previousMood.damping, target.damping, transT);
		let palOffsetState = lerp(previousMood.palOffset, target.palOffset, transT);
		let pointSizeState = lerp(previousMood.pointSize, target.pointSize, transT);
		const camDistMul = lerp(previousMood.camDistMul, target.camDistMul, transT);
		const camSpeedMul = lerp(previousMood.camSpeedMul, target.camSpeedMul, transT);
		// Tonnetz-aware palette (V2) — base + accent hues weighted by phrase position
		// so harmonically-related sections share a palette neighborhood. Read
		// defensively so older director frames or hot-reload races don't crash.
		const phrasePosMk3 = directed.clock?.phrasePos ?? directed.phrase ?? 0;
		const baseHueMk3 = directed.palette?.baseHue ?? directed.paletteBase ?? 0;
		const accentHueMk3 = directed.palette?.accentHue ?? directed.paletteAccent ?? 0;
		const phraseW = 0.5 + 0.5 * Math.sin(phrasePosMk3 * Math.PI * 2);
		const v2Hue = baseHueMk3 * (1 - 0.25 * phraseW) + accentHueMk3 * 0.25 * phraseW;
		palOffsetState = lerp(palOffsetState, v2Hue, 0.65);

		// Drop anticipation accelerates the flow before the drop lands; post-drop
		// decay holds the energy ~1s into the chorus. Downbeat flag spikes flow
		// briefly on each bar's first beat — the visual "lands the one."
		const antic3 = directed.drop?.anticipation ?? 0;
		const postDrop3 = directed.drop?.postDropDecay ?? 0;
		const downbeatKick = directed.clock?.downbeatFlag ? 0.35 : 0;

		// Drop detonation: section entry into 'drop' (beat-exact with the
		// visual score) spikes the burst envelope; chorus entry gets a softer
		// pop. Decays over ~1.5s at 60fps.
		const sec3 = directed.section;
		if (sec3 !== lastSectionMk3) {
			if (sec3 === 'drop') {
				dropBurst = 1;
				smoothed.flash = Math.min(1, smoothed.flash + 0.8);
			} else if (sec3 === 'chorus') {
				dropBurst = Math.max(dropBurst, 0.55);
			}
			lastSectionMk3 = sec3;
		}
		dropBurst *= 0.972;

		flowStrength *= 0.72 + directed.motion * 0.42 + antic3 * 0.55 + postDrop3 * 0.30 + downbeatKick;
		pointSizeState *= 0.82 + directed.density * 0.24 + postDrop3 * 0.18;

		// Long-arc drift — slow LFOs at 30/45/70-second periods so even steady
		// states are never truly static. Three independent sin waves nudge
		// palette, flow strength, swirl bias, and particle size. Range deliberately
		// small (≤15% of state baseline) so drift augments rather than overrides.
		if (!isSilent) {
			const driftA = Math.sin((time * 2 * Math.PI) / 45);
			const driftB = Math.sin((time * 2 * Math.PI) / 30 + 1.5);
			const driftC = Math.sin((time * 2 * Math.PI) / 70 + 3.1);
			palOffsetState += driftA * 0.08 + driftC * 0.04;
			flowStrength *= 1 + driftB * 0.18;
			swirlStrength += driftC * 0.15;
			radialForce += driftA * 0.12;
			pointSizeState *= 1 + driftA * 0.10;
		}

		// Spatial grammar changes slowly and deterministically from song features.
		// Chroma pushes tracks into different formation families; phrase time
		// rotates the family every ~28s. The compute shader handles the morph.
		const chromaKey = feat?.chroma_key ?? 0;
		const phrase = directed.phrase;
		const topology = isSilent ? 0 : directed.motifIndex;
		topologyName = directed.motif ?? TOPOLOGY_NAMES[topology] ?? 'organism';

		// ── Camera: FLY FORWARD through the elongated particle volume.
		// Forward speed gated by state (silent → 0) so the camera actually
		// stops when audio stops. Wobble + roll for hand-held cinematic feel.
		const forwardSpeed = camSpeedMul * (1.6 + smoothed.bass * 0.8 + smoothed.rmsSlow * 0.6);
		camPhase += dt * forwardSpeed; // camPhase is now total forward distance
		const camZ = camPhase;
		const camWobbleX = Math.sin(time * 0.18) * 0.16 + Math.sin(time * 0.11 + 1.7) * 0.10;
		const camWobbleY = 0.08 + Math.sin(time * 0.13) * 0.14;
		const eye: [number, number, number] = [camWobbleX, camWobbleY, camZ];
		// Look ahead with slight lateral lead so the camera "anticipates" the path.
		const lookLead = 4.0;
		const lookDriftX = Math.sin(time * 0.07 + 2.1) * 0.18;
		const lookDriftY = Math.sin(time * 0.05) * 0.12;
		const at: [number, number, number] = [
			eye[0] + lookDriftX,
			eye[1] + lookDriftY,
			camZ + lookLead
		];
		// Subtle roll around forward axis — gives a "flying" cinematic feel.
		const rollAngle = Math.sin(time * 0.09) * 0.08;
		const upWorld: [number, number, number] = [
			Math.sin(rollAngle),
			Math.cos(rollAngle),
			0
		];
		const view = lookAt(eye, at, upWorld);
		const proj = perspective((55 * Math.PI) / 180, w / h, 0.1, 80);
		const viewProj = mat4Mul(proj, view);

		// Camera basis vectors for billboarding (taken from view's inverse columns).
		// We can extract right (view col 0 = (snx, sny, snz)) and up (view col 1 = (ux, uy, uz))
		// directly from view, then negate Z component if needed. From our lookAt build:
		const camRight: [number, number, number] = [view[0], view[4], view[8]];
		const camUp: [number, number, number] = [view[1], view[5], view[9]];

		// Sim params — includes camera Z for recycling plus spatial grammar.
		const sp = new Float32Array(20);
		sp[0] = dt;
		sp[1] = time;
		sp[2] = smoothed.bass * (isSilent ? 0 : 1);
		sp[3] = smoothed.mid * (isSilent ? 0 : 1);
		sp[4] = smoothed.treble * (isSilent ? 0 : 1);
		sp[5] = smoothed.rmsSlow;
		// Per-track curl field character: same song = same flow texture.
		sp[6] = 0.28 + mk3TrackSeed * 0.2; // flow scale
		sp[7] = flowStrength * 0.82 + smoothed.bass * 0.18 + directed.motion * 0.14 + directed.bassPunch * 0.20;
		sp[8] = dampingState;
		sp[9] = 2.35 - directed.structure * 0.35 + antic3 * 0.45; // radial pull (lateral) — anticipation expands the field
		sp[10] = swirlStrength + smoothed.mid * 0.14 + downbeatKick * 0.40;
		// Drop detonation rides the radial impulse hard for ~1.5s.
		sp[11] = radialForce + smoothed.bass * 0.16 + postDrop3 * 0.55 + dropBurst * 1.3;
		sp[12] = camZ; // recycle threshold reference
		sp[13] = 6.0; // tailDist — recycle particles >6 units behind camera
		sp[14] = 22.0; // headDist — new particles spawn within 22 units ahead
		sp[15] = 1.15 + directed.density * 0.85 + postDrop3 * 0.50 + dropBurst * 1.2; // spawnSpread — drop blooms the field
		sp[16] = topology;
		sp[17] = chromaKey;
		sp[18] = phrase;
		sp[19] = 0;
		gpu.device.queue.writeBuffer(gpu.simParamBuf, 0, sp.buffer, sp.byteOffset, 80);

		// View params (32 floats = 128 bytes)
		const vp = new Float32Array(32);
		for (let i = 0; i < 16; i++) vp[i] = viewProj[i];
		vp[16] = camRight[0];
		vp[17] = camRight[1];
		vp[18] = camRight[2];
		// +25% base size addresses the near-black field from the visual audit;
		// the drop burst pops sprites a further ~30% for the detonation frame.
		vp[19] = pointSizeState * 1.25 + smoothed.treble * 0.0035 + dropBurst * 0.004;
		vp[20] = camUp[0];
		vp[21] = camUp[1];
		vp[22] = camUp[2];
		// Palette anchored to state archetype; audio nudges it within the zone.
		vp[23] = palOffsetState + (smoothed.centroidSlow - 0.5) * 0.05 + mk3TrackSeed * 0.31;
		vp[24] = smoothed.bass;
		vp[25] = smoothed.mid;
		vp[26] = smoothed.treble;
		vp[27] = smoothed.flash;
		gpu.device.queue.writeBuffer(gpu.viewParamBuf, 0, vp.buffer, vp.byteOffset, 128);

		// Post params
		const pp = new Float32Array(8);
		pp[0] = w;
		pp[1] = h;
		pp[2] = time;
		pp[3] = smoothed.flash;
		pp[4] = smoothed.treble;
		gpu.device.queue.writeBuffer(gpu.postParamBuf, 0, pp.buffer, pp.byteOffset, 32);

		// Long-arc cloudPhase — slow continuous drift (~0.01 per second).
		// Independent of state, so the background slowly evolves regardless
		// of audio activity. Goes the same direction either way; never resets.
		const cloudPhase = time * 0.01;
		// Sky intensity — silent kills it (matches silence gate elsewhere).
		const skyIntensity = isSilent ? 0.08 : 0.22 + directed.energy * 0.16;
		const sp2 = new Float32Array(8);
		sp2[0] = w;
		sp2[1] = h;
		sp2[2] = time;
		// Slightly offset palette so sky sits in a complementary zone to particles.
		sp2[3] = palOffsetState + (smoothed.centroidSlow - 0.5) * 0.05 + mk3TrackSeed * 0.31 + 0.15;
		sp2[4] = smoothed.rmsSlow;
		sp2[5] = smoothed.bass * (isSilent ? 0 : 1);
		sp2[6] = cloudPhase;
		sp2[7] = skyIntensity;
		gpu.device.queue.writeBuffer(gpu.skyParamBuf, 0, sp2.buffer, sp2.byteOffset, 32);

		const encoder = gpu.device.createCommandEncoder();

		// One-time init compute pass
		if (!gpu.initialized) {
			const pass = encoder.beginComputePass();
			pass.setPipeline(gpu.pipelines.init);
			pass.setBindGroup(0, gpu.bgs.init);
			pass.dispatchWorkgroups(Math.ceil(PARTICLE_COUNT / 64));
			pass.end();
			gpu.initialized = true;
		}

		// Sim compute pass
		{
			const pass = encoder.beginComputePass();
			pass.setPipeline(gpu.pipelines.sim);
			pass.setBindGroup(0, gpu.bgs.sim);
			pass.dispatchWorkgroups(Math.ceil(PARTICLE_COUNT / 64));
			pass.end();
		}

		// Sky → sceneTex (clear). Fills atmosphere/depth in the void.
		{
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{
						view: gpu.targets.sceneView,
						clearValue: { r: 0, g: 0, b: 0, a: 1 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				]
			});
			pass.setPipeline(gpu.pipelines.sky);
			pass.setBindGroup(0, gpu.bgs.sky);
			pass.draw(6);
			pass.end();
		}

		// Particles → sceneTex (load — additive blends over sky).
		{
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{
						view: gpu.targets.sceneView,
						loadOp: 'load',
						storeOp: 'store'
					}
				],
				depthStencilAttachment: {
					view: gpu.targets.depthView,
					depthClearValue: 1.0,
					depthLoadOp: 'clear',
					depthStoreOp: 'store'
				}
			});
			pass.setPipeline(gpu.pipelines.render);
			pass.setBindGroup(0, gpu.bgs.render);
			pass.draw(6, PARTICLE_COUNT);
			pass.end();
		}

		// Composite → swap chain
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
			pass.setPipeline(gpu.pipelines.composite);
			pass.setBindGroup(0, gpu.bgs.composite);
			pass.draw(6);
			pass.end();
		}

		gpu.device.queue.submit([encoder.finish()]);
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
						g.particleBuf.destroy();
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
				mk3 — particle field choir — click anywhere or press esc to exit
			</div>
			<div
				class="pointer-events-none absolute left-6 top-6 rounded border border-white/15 bg-black/40 px-2 py-1 font-mono text-xs uppercase tracking-wider text-white/70"
			>
				mk3 · {PARTICLE_COUNT.toLocaleString()} particles · state:
				<strong class={isSilent ? 'text-white/40' : 'text-white/90'}
					>{isSilent ? 'silent' : songState}</strong
				>
				· topology: <strong>{topologyName}</strong>
			</div>
		{/if}
		{#if errorMsg}
			<div class="absolute left-6 top-16 max-w-md text-xs text-red-300/80">
				Visualizer error: {errorMsg}
			</div>
		{/if}
	</div>
{/if}
