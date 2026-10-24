<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		VISUALIZER_TUNING,
		useVisualizer,
		type VisualizerJourneySnapshot
	} from '$lib/state/visualizer.svelte';
	import {
		SIGNAL_BEAM_WGSL,
		SIGNAL_COMPOSITE_WGSL,
		SIGNAL_FEEDBACK_WGSL,
		SIGNAL_GLOW_DOWN_WGSL,
		SIGNAL_RENDER_PASSES,
		SIGNAL_SCENE_WGSL,
		SIGNAL_SCOPE_WINDOW,
		SIGNAL_TERRAIN_BINS,
		SIGNAL_TERRAIN_FLOATS,
		SIGNAL_TERRAIN_ROWS,
		SIGNAL_TIGHT_BLUR_H_WGSL,
		SIGNAL_TIGHT_BLUR_V_WGSL,
		SIGNAL_TIGHT_DIVISOR,
		SIGNAL_TRACE_INSTANCES,
		SIGNAL_VERTEX_COUNT,
		SIGNAL_WIDE_BLUR_H_WGSL,
		SIGNAL_WIDE_BLUR_V_WGSL,
		SIGNAL_WIDE_DIVISOR,
		SIGNAL_WIDE_DOWN_WGSL
	} from '$lib/visualizer/signal/shaders';
	import {
		SIGNAL_UNIFORM_BYTES,
		SIGNAL_UNIFORM_FLOATS,
		packSignalUniforms,
		type SignalUniformValues
	} from '$lib/visualizer/signal/uniform-layout';
	import {
		SIGNAL_FAMILY_NAMES,
		SIGNAL_FIGURE_FLOATS,
		SIGNAL_FIGURE_SEGMENTS,
		signalScopeShare,
		type SignalFigureInput
	} from '$lib/visualizer/signal/figures';
	import { SignalScopeBeam } from '$lib/visualizer/signal/scope-beam';
	import {
		SIGNAL_CAMERAS,
		SIGNAL_DISPLAYS,
		SURFACE_FLOOR,
		SURFACE_RING,
		SURFACE_TUNNEL,
		SIGNAL_LAYOUT_PARTS,
		buildSignalLayout,
		createSignalLayout,
		lerpPreset,
		lerpSignalLayout,
		lerpSignalLayoutPart,
		mirrorSignalLayout,
		signalBenchName,
		signalCompose,
		type SignalCompose,
		type SignalLayout
	} from '$lib/visualizer/signal/layouts';
	import { SIGNAL_NOISE_LANE, SignalRoam } from '$lib/visualizer/signal/roam';
	import { SIGNAL_PALETTES, createSignalPaletteOut, resolveSignalPalette } from '$lib/visualizer/signal/palettes';
	import {
		parseSignalLookOverride,
		signalVariationFor,
		type SignalLookOverride,
		type SignalVariation
	} from '$lib/visualizer/signal/genome';
	import {
		signalPartDelay,
		signalPartMix,
		signalRendererMemory,
		type SignalMorph,
		type SignalRendererScalars
	} from '$lib/visualizer/signal/continuity';
	import {
		SIGNAL_VOICE_FLOATS,
		SIGNAL_VOICE_LANES,
		SignalBand
	} from '$lib/visualizer/signal/band';

	const vis = useVisualizer();

	const DETAIL_BYTES = 64 * 4;
	const TERRAIN_FLOATS = SIGNAL_TERRAIN_FLOATS;
	const TARGET_FRAME_RATE = 60;
	const INTERNAL_SCALE = 0.75;
	// The cheaper path for phones (lab: ?signalLite=1): half the beam
	// upsampling and a smaller internal target; the glow targets scale with it.
	const LITE_INTERNAL_SCALE = 0.6;
	const LITE_UPSAMPLE = 3;
	let internalScale = INTERNAL_SCALE;
	const MAX_INTERNAL_PIXELS = 1920 * 1080;
	const BEATS_PER_PHRASE = 32;
	// How far a bench change ripples down the horizon history: rows nearest the
	// figure take the new surface first, the old scene's rows age out on the old.
	const SURFACE_RIPPLE = 1.4;
	// Log-frequency position of each analyzer band edge across the 64 bins
	// (20 Hz .. 20 kHz): sub, kick, body, mids, presence, air.
	const BAND_EDGES = [0, 0.16, 0.29, 0.43, 0.66, 0.82, 1];

	let canvas = $state<HTMLCanvasElement | null>(null);
	let errorMsg = $state<string | null>(null);
	let ready = $state(false);
	let hudSection = $state('intro');
	let hudTempo = $state(0);
	let hudContext = $state<'live' | 'score'>('live');
	let hudChannels = $state(1);
	let hudLayout = $state('bench');
	let hudFamily = $state('lissajous');
	let hudPalette = $state('P31 bench');
	let hudScene = $state(0);
	let hudFrameMs = $state(0);
	let hudBeam = $state(0);
	let hudStereo = $state(0);
	let frameCpuMs = 0;
	// Lab-only GPU timing (?signalGpuTiming=1): timestamp queries around the
	// whole frame when the adapter has them, else submit to queue-done.
	let gpuTiming = $state(false);
	let gpuPending = false;
	let gpuMs = 0;
	let hudGpuMs = $state(0);
	type SignalTimer = { querySet: GPUQuerySet; resolve: GPUBuffer; readback: GPUBuffer };
	let timer: SignalTimer | null = null;
	let activeFrameStride = $state(1);
	let measuredRefreshRate = $state(60);
	let internalPixels = $state(0);
	let raf = 0;
	let running = false;
	let unsubscribe: (() => void) | null = null;
	let initVersion = 0;
	let initializing = false;
	let schedulerTickAt = 0;
	let refreshIntervalMs = 1000 / 60;
	let framesUntilRender = 0;
	let lastRenderedAt = 0;
	let lastHudUpdateAt = 0;
	let startTime = 0;
	let rendererSourceEpoch = -1;
	let feedbackResetFrames = 2;

	// Render-rate state. The shared journey advances at analyzer cadence; these
	// ease it to the display so nothing visibly steps.
	const bands = { sub: 0, kick: 0, body: 0, mids: 0, presence: 0, air: 0 };
	const BAND_KEYS = ['sub', 'kick', 'body', 'mids', 'presence', 'air'] as const;
	let rms = 0;
	let silence = 1;
	let quietFor = 0.5;
	let renderBeats = 0;
	let renderBpm = 120;
	// Heard transients (kick-band rise, onsets): the only beat light.
	let transient = 0;
	let lastKickLevel = 0;
	let sweepPhase = 0;
	/** Section paces, each glided on its own time (see renderFrame). */
	let sweepGlide = 0;
	let traceEnergy = 0.4;
	/** Chord lane root cycles per trace map style. */
	const CHORD_CYCLES = [3, 4, 2.5];
	let chordCycles = 3;
	/** The hero's own glided pace (conductor trace phase per second). */
	let heroPace = 0;
	let headEnergy = 0.4;
	let tickGlide = 0;
	/** Where the X/Y record was last written up to. */
	let lastSweepWritten = 0;
	let figurePhase = 0;
	let lastTracePhase = 0;
	let tickPhase = 0;
	let terrainHead = 0;
	let tickFlash = 0;
	let mode = 0;
	let asymmetry = 0;
	let spectralMotion = 0;
	let spinAngle = 0;
	let lockStep = 0;
	/** Kick-driven strides of a locked figure: target, eased value, last kick answered. */
	let kickStrideTarget = 0;
	let kickStride = 0;
	let kickStrideSerial = -1;
	let breathPhase = 0;
	let grainClock = 0;
	let fracturePhase = 0;
	let reactBoost = 1;
	const renderDetailBins = new Float32Array(64);
	// Session memory: the figure, the horizon history, the look morphs and the
	// conductor carry outlive this component, so a remount resumes the picture.
	const memory = signalRendererMemory();
	const morphs = memory.morphs;
	const carry = memory.carry;
	const terrainRows = memory.terrainRows;
	// Interleaved height, heat per bin.
	const pendingRow = memory.pendingRow;
	const silhouette = new Float32Array(SIGNAL_TERRAIN_BINS);
	const scopeSilhouette = new Float32Array(SIGNAL_TERRAIN_BINS);
	let pendingRowFresh = true;

	// The instrument model shared by every element on the bench.
	const figureEngine = memory.figure;
	const voiceTracker = memory.voice;
	// The real stereo signal as the XY beam (see scope-beam.ts).
	let scopeBeam = new SignalScopeBeam();
	const paletteOut = createSignalPaletteOut();
	const layoutMix = createSignalLayout();
	/** This frame's conductor rails as drawn (see SignalCarry). */
	const carriedJourney = {
		tension: 0,
		release: 0,
		openness: 0,
		motion: 0,
		channels: 0,
		complexity: 0,
		sweepBeats: 1,
		tickRate: 1,
		tempo: 0.5,
		signedAsymmetry: 0,
		ellipse: 0,
		lissajous: 1,
		ribbon: 0,
		rosette: 0,
		energy: 0,
		impact: 0,
		ringOut: 0,
		sectionPulse: 0,
		tracePhase: 0
	};
	const headLocal: [number, number] = [0, 0];
	const heroDrift: [number, number] = [0, 0];
	const compose: SignalCompose = { pan: 0, lift: 0, size: 0, spread: 0, depth: 0, reach: 0, horizon: 0, glow: 0 };
	let lookOverride: SignalLookOverride = {};
	let roamPin: Record<string, number> = {};
	let variation: SignalVariation | null = null;

	/** One bench built at composition `k`, turned round by the mirror morph. */
	function benchAt(index: number, aspectRatio: number, mirror: SignalMorph, k: SignalCompose): SignalLayout {
		const amount = (m: number) => mirror.from + (mirror.to - mirror.from) * m;
		if (mirror.from === mirror.to) {
			return mirrorSignalLayout(buildSignalLayout(index, aspectRatio, k), amount(mirror.mix));
		}
		// Turning round, piece by piece: each part slides across in its own
		// window of the move (the mirror is linear in its amount).
		const plain = buildSignalLayout(index, aspectRatio, k);
		const flipped = mirrorSignalLayout(buildSignalLayout(index, aspectRatio, k), 1);
		const out = lerpSignalLayout(plain, flipped, amount(mirror.mix), createSignalLayout());
		for (let part = 0; part < SIGNAL_LAYOUT_PARTS.length; part += 1) {
			const delay = signalPartDelay(mirror.from + 17, mirror.to + 17, part, partSpan);
			lerpSignalLayoutPart(plain, flipped, part, amount(signalPartMix(mirror.progress, delay, partSpan)), out);
		}
		return out;
	}

	/** Each part's share of a staggered move: short windows, so parts move one after another. */
	const PART_SPAN = 0.32;
	/**
	 * This frame's stagger window. Right after the music changes character the
	 * parts move together (a genre change is the one whole-bench gesture left),
	 * easing back to the cubie-by-cubie stagger as the answer lands.
	 */
	let partSpan = PART_SPAN;
	/**
	 * How far behind the roam each trace follows, seconds of music (trace k
	 * is layout part k + 1). The hero and its screens lead; the traces follow
	 * in a scattered order, so a rearrangement ripples through the bench.
	 */
	const TRACE_LAG = [2.5, 7.5, 12.5, 4.5, 10, 1, 6, 14];

	const echoValues: number[] = [];
	const echoCompose: SignalCompose = { ...compose };

	/**
	 * One bench at the roam's current point in its room of arrangements,
	 * turned round by the mirror morph, each trace placed where the roam was
	 * its own lag ago. Built fresh every frame: the roam never stops, so
	 * there is nothing to cache.
	 */
	function layoutFor(index: number, aspectRatio: number, mirror: SignalMorph, roam: SignalRoam): SignalLayout {
		// The hero, its screens and the horizon lead; each trace follows the
		// roam on its own lag, so a rearrangement ripples through the bench.
		const out = benchAt(index, aspectRatio, mirror, compose);
		for (let trace = 0; trace < TRACE_LAG.length; trace += 1) {
			roam.echo.sample(TRACE_LAG[trace], echoValues);
			signalCompose(echoValues, echoCompose);
			for (const key of Object.keys(echoCompose) as (keyof SignalCompose)[]) {
				if (roamPin[key] !== undefined) echoCompose[key] = roamPin[key];
			}
			const lagged = benchAt(index, aspectRatio, mirror, echoCompose);
			lerpSignalLayoutPart(out, lagged, trace + 1, 1, out);
		}
		return out;
	}

	/** Palette roles blended part by part: each role turns in its own window. */
	const paletteScratch = createSignalPaletteOut();
	const PALETTE_ROLES = ['hero', 'trace', 'horizon', 'hot'] as const;

	/** The roam, created on the first frame of a session from its journey's seed. */
	function roamFor(seed: number): SignalRoam {
		memory.roam ??= new SignalRoam(`signal-roam:${seed}`);
		return memory.roam;
	}

	/** The band on the bench, created on the first frame of a session (see band.ts). */
	function bandFor(seed: number): SignalBand {
		memory.band ??= new SignalBand(`signal-band:${seed}`);
		return memory.band;
	}

	/** Lane colours, rebuilt each frame from the palette roles. */
	const laneRgb = Array.from({ length: SIGNAL_VOICE_LANES }, () => [0, 0, 0] as [number, number, number]);
	const leanScratch: [number, number, number] = [0, 0, 0];

	/**
	 * Lean a phosphor toward warm or cool at its own luminance, and twist its
	 * hue a little round the grey axis (a chord's tension). Small moves only:
	 * every part stays inside the tube's palette family.
	 */
	function leanColour(rgb: ArrayLike<number>, warmth: number, twist: number, out: [number, number, number]) {
		const lum = rgb[0] * 0.3 + rgb[1] * 0.5 + rgb[2] * 0.2;
		const w = clamp(warmth, -1, 1) * 0.32;
		const tr = w > 0 ? 1.25 : 0.6;
		const tg = w > 0 ? 0.85 : 0.95;
		const tb = w > 0 ? 0.45 : 1.35;
		let r = rgb[0] + (lum * tr - rgb[0]) * Math.abs(w);
		let g = rgb[1] + (lum * tg - rgb[1]) * Math.abs(w);
		let b = rgb[2] + (lum * tb - rgb[2]) * Math.abs(w);
		// Rotation about the grey axis (Rodrigues), by up to ~40 degrees.
		const angle = clamp(twist, 0, 1) * 0.7;
		if (angle > 1e-3) {
			const c = Math.cos(angle);
			const sn = Math.sin(angle);
			const k = (1 - c) / 3;
			const q = sn / Math.sqrt(3);
			const nr = r * (c + k) + g * (k - q) + b * (k + q);
			const ng = r * (k + q) + g * (c + k) + b * (k - q);
			const nb = r * (k - q) + g * (k + q) + b * (c + k);
			r = nr;
			g = ng;
			b = nb;
		}
		out[0] = Math.max(0, r);
		out[1] = Math.max(0, g);
		out[2] = Math.max(0, b);
		return out;
	}

	type SignalTargets = {
		scene: GPUTexture;
		sceneView: GPUTextureView;
		feedback: [GPUTexture, GPUTexture];
		feedbackViews: [GPUTextureView, GPUTextureView];
		/** Tight glow, half resolution: [result, scratch]. */
		tight: [GPUTexture, GPUTexture];
		tightViews: [GPUTextureView, GPUTextureView];
		/** Wide glow, an eighth of full resolution: [result, scratch]. */
		wide: [GPUTexture, GPUTexture];
		wideViews: [GPUTextureView, GPUTextureView];
		width: number;
		height: number;
	};

	type SignalGpu = {
		device: GPUDevice;
		context: GPUCanvasContext;
		format: GPUTextureFormat;
		sampler: GPUSampler;
		uniformBuffer: GPUBuffer;
		detailBuffer: GPUBuffer;
		terrainBuffer: GPUBuffer;
		figureBuffer: GPUBuffer;
		scopeBuffer: GPUBuffer;
		voiceBuffer: GPUBuffer;
		uniforms: Float32Array;
		scenePipeline: GPURenderPipeline;
		beamPipeline: GPURenderPipeline;
		feedbackPipeline: GPURenderPipeline;
		glowDownPipeline: GPURenderPipeline;
		tightHPipeline: GPURenderPipeline;
		tightVPipeline: GPURenderPipeline;
		wideDownPipeline: GPURenderPipeline;
		wideHPipeline: GPURenderPipeline;
		wideVPipeline: GPURenderPipeline;
		compositePipeline: GPURenderPipeline;
		sceneBindGroup: GPUBindGroup;
		beamBindGroup: GPUBindGroup;
		targets: SignalTargets | null;
		post: SignalPostBindings | null;
		parity: 0 | 1;
	};

	type SignalPostBindings = {
		feedback: [GPUBindGroup, GPUBindGroup];
		glowDown: [GPUBindGroup, GPUBindGroup];
		tightH: GPUBindGroup;
		tightV: GPUBindGroup;
		wideDown: GPUBindGroup;
		wideH: GPUBindGroup;
		wideV: GPUBindGroup;
		composite: [GPUBindGroup, GPUBindGroup];
	};

	let gpu: SignalGpu | null = null;

	function clamp(value: number, min: number, max: number) {
		return Math.min(max, Math.max(min, value));
	}

	function approach(current: number, target: number, rate: number, dt: number) {
		return current + (target - current) * (1 - Math.exp(-rate * dt));
	}

	function smoothstep(edge0: number, edge1: number, value: number) {
		const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
		return t * t * (3 - 2 * t);
	}

	function wrapSigned(value: number) {
		return value - Math.round(value);
	}

	function displayFrameStride(refreshMs: number, targetFrameRate: number) {
		const safeRefresh = clamp(refreshMs, 1000 / 360, 1000 / 24);
		return Math.max(1, Math.min(8, Math.round(1000 / safeRefresh / targetFrameRate)));
	}

	function observeDisplayCadence(tickElapsedMs: number) {
		if (tickElapsedMs < 1000 / 360 || tickElapsedMs > 1000 / 24) return;
		if (tickElapsedMs < refreshIntervalMs * 0.8) {
			refreshIntervalMs += (tickElapsedMs - refreshIntervalMs) * 0.38;
		} else if (tickElapsedMs <= refreshIntervalMs * 1.35) {
			refreshIntervalMs += (tickElapsedMs - refreshIntervalMs) * 0.08;
		}
		measuredRefreshRate = Math.round(1000 / refreshIntervalMs);
	}

	function beatAnchor(clock: VisualizerJourneySnapshot['director']['clock']) {
		if (!Number.isFinite(clock.phraseIndex) || !Number.isFinite(clock.phrasePos)) return null;
		return clock.phraseIndex * BEATS_PER_PHRASE + clock.phrasePos * BEATS_PER_PHRASE;
	}

	/**
	 * Club lock clock: whole beats plus an eased step inside each one, so a
	 * locked figure moves in one gliding stride per beat and rests between.
	 */
	function steppedBeats(beats: number) {
		const whole = Math.floor(beats);
		const t = beats - whole;
		const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
		return whole + eased;
	}

	/** Smooth level profile: interpolate between band centres, no plateaus. */
	function bandLevelAt(position: number) {
		let previousCenter = 0;
		let previousLevel = bands.sub;
		for (let band = 0; band < 6; band += 1) {
			const center = (BAND_EDGES[band] + BAND_EDGES[band + 1]) * 0.5;
			const level = bands[BAND_KEYS[band]];
			if (position <= center) {
				if (band === 0) return level;
				const t = clamp((position - previousCenter) / (center - previousCenter), 0, 1);
				const eased = t * t * (3 - 2 * t);
				return previousLevel + (level - previousLevel) * eased;
			}
			previousCenter = center;
			previousLevel = level;
		}
		return previousLevel;
	}

	function spectrumAt(position: number) {
		const last = renderDetailBins.length - 1;
		const scaled = clamp(position, 0, 1) * last;
		const bin = Math.round(scaled);
		const detail =
			renderDetailBins[Math.max(bin - 1, 0)] * 0.25 +
			renderDetailBins[bin] * 0.5 +
			renderDetailBins[Math.min(bin + 1, last)] * 0.25;
		const drive = bandLevelAt(position) * 0.45 + detail * 1.8;
		// Soft saturation: loud bands round off instead of flat-topping.
		return drive >= 0 ? 1 - Math.exp(-drive * 1.6) : Math.max(drive, -0.3);
	}

	/**
	 * The horizon remembers the figure: each row is the figure's polar
	 * silhouette (its farthest reach per angle) shaped by the live spectrum,
	 * with the bass under the figure. Beat stamps from the beam head ride in a
	 * second channel. Peak-held between ticks so no transient is lost.
	 */
	function accumulateTerrainRow(
		coupling: number,
		headTurn: number,
		stamp: number,
		beamMix: number,
		beamTurn: number
	) {
		figureEngine.silhouette(silhouette);
		// With the XY beam up, the horizon remembers the real picture.
		if (beamMix > 0.001) {
			scopeBeam.silhouette(scopeSilhouette, beamTurn);
			for (let bin = 0; bin < SIGNAL_TERRAIN_BINS; bin += 1) {
				silhouette[bin] += (scopeSilhouette[bin] - silhouette[bin]) * beamMix;
			}
		}
		let mean = 0;
		for (let bin = 0; bin < SIGNAL_TERRAIN_BINS; bin += 1) mean += silhouette[bin];
		mean = Math.max(0.15, mean / SIGNAL_TERRAIN_BINS);
		for (let bin = 0; bin < SIGNAL_TERRAIN_BINS; bin += 1) {
			const turn = bin / SIGNAL_TERRAIN_BINS;
			// Distance round the circle from the figure's underside (0.75 turn).
			const fromBottom = Math.abs(((turn - 0.75 + 1.5) % 1) - 0.5) * 2;
			const spectral = spectrumAt(fromBottom);
			const shape = silhouette[bin] / mean;
			const figureValue = (shape * 0.75 - 0.05) * (0.6 + Math.max(spectral, 0) * 0.8);
			const value = spectral + (figureValue - spectral) * coupling;
			const heatDistance = Math.abs(((turn - headTurn + 1.5) % 1) - 0.5) * SIGNAL_TERRAIN_BINS;
			const heat = stamp * Math.exp(-heatDistance * heatDistance * 0.35);
			const o = bin * 2;
			pendingRow[o] = pendingRowFresh ? value : Math.max(pendingRow[o], value);
			pendingRow[o + 1] = pendingRowFresh ? heat : Math.max(pendingRow[o + 1], heat);
		}
		pendingRowFresh = false;
	}

	/** Stamp a part of the band into the row being written, at its own place. */
	function stampRow(turn: number, width: number, amount: number) {
		if (!(amount > 0.001)) return;
		for (let bin = 0; bin < SIGNAL_TERRAIN_BINS; bin += 1) {
			const d = Math.abs(((bin / SIGNAL_TERRAIN_BINS - turn + 1.5) % 1) - 0.5);
			const heat = amount * Math.exp(-(d * d) / (width * width));
			const o = bin * 2 + 1;
			if (heat > pendingRow[o]) pendingRow[o] = heat;
		}
	}

	function commitTerrainRow() {
		terrainHead = (terrainHead + 1) % SIGNAL_TERRAIN_ROWS;
		terrainRows.set(pendingRow, terrainHead * SIGNAL_TERRAIN_BINS * 2);
		pendingRowFresh = true;
	}

	function rendererScalars(): SignalRendererScalars {
		return {
			figurePhase,
			lastTracePhase,
			spinAngle,
			sweepPhase,
			tickPhase,
			terrainHead,
			mode,
			asymmetry,
			renderBpm,
			breathPhase,
			grainClock,
			fracturePhase,
			reactBoost
		};
	}

	/** Keep the session memory current so a remount picks up exactly here. */
	function rememberRenderer() {
		if (rendererSourceEpoch < 0) return;
		memory.epoch = rendererSourceEpoch;
		memory.scalars = rendererScalars();
	}

	/**
	 * Bring the renderer onto the journey's current source. Nothing visual is
	 * reset here: the very first frame of a session starts from the journey,
	 * a remount resumes the remembered picture, and a new source (next song,
	 * new station) carries the picture on while the conductor rails it reads
	 * glide from where they were to the new source's (see SignalCarry). The
	 * phosphor feedback only clears when its textures are rebuilt (resize).
	 */
	function syncRendererSource(shared: VisualizerJourneySnapshot, live: boolean) {
		const mounting = rendererSourceEpoch === -1;
		const newSource = mounting ? memory.epoch !== -1 && memory.epoch !== shared.sourceEpoch : true;
		rendererSourceEpoch = shared.sourceEpoch;
		variation = signalVariationFor(shared.seed, shared.sourceEpoch);
		variation.setOverride(lookOverride);
		roamFor(shared.seed);
		bandFor(shared.seed);
		if (mounting) {
			// Audio envelopes always start from what is playing now.
			const levels = shared.spectrum.levels;
			for (const key of BAND_KEYS) bands[key] = live ? levels[key] : 0;
			rms = 0;
			silence = live ? 0 : 1;
			quietFor = live ? 0 : 0.5;
			spectralMotion = shared.spectrum.spectralMotion;
			for (let index = 0; index < renderDetailBins.length; index += 1) {
				renderDetailBins[index] = shared.spectrum.detailBins[index] ?? 0;
			}
			renderBeats = beatAnchor(shared.director.clock) ?? 0;
			tickFlash = 0;
			pendingRowFresh = true;
			lockStep = steppedBeats(renderBeats);
			const saved = memory.scalars;
			// The figure turns on from where it was left, whatever the shared
			// phase did while Signal was away.
			lastTracePhase = shared.signal.tracePhase;
			if (saved) {
				({
					figurePhase,
					spinAngle,
					sweepPhase,
					tickPhase,
					terrainHead,
					mode,
					asymmetry,
					renderBpm,
					breathPhase,
					grainClock,
					fracturePhase,
					reactBoost
				} = saved);
			} else {
				// First Signal frame of the session.
				figurePhase = shared.signal.tracePhase * 1.6;
				asymmetry = shared.signal.signedAsymmetry;
				sweepPhase = 0;
				tickPhase = 0;
				terrainHead = 0;
				spinAngle = 0;
				terrainRows.fill(0);
				pendingRow.fill(0);
			}
		} else {
			// A new source mid-view: the conductor restarted its monotonic phase.
			lastTracePhase = shared.signal.tracePhase;
			renderBeats = beatAnchor(shared.director.clock) ?? renderBeats;
			lockStep = steppedBeats(renderBeats);
		}
		if (newSource) carry.rebase();
		lastHudUpdateAt = 0;
		rememberRenderer();
	}

	function backingSize(targetCanvas: HTMLCanvasElement) {
		const cssWidth = Math.max(1, targetCanvas.clientWidth);
		const cssHeight = Math.max(1, targetCanvas.clientHeight);
		const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
		let width = Math.max(1, Math.floor(cssWidth * pixelRatio * internalScale));
		let height = Math.max(1, Math.floor(cssHeight * pixelRatio * internalScale));
		const pixels = width * height;
		if (pixels > MAX_INTERNAL_PIXELS) {
			const reduction = Math.sqrt(MAX_INTERNAL_PIXELS / pixels);
			width = Math.max(1, Math.floor(width * reduction));
			height = Math.max(1, Math.floor(height * reduction));
		}
		return { width, height };
	}

	function destroyTargets(targets: SignalTargets | null) {
		if (!targets) return;
		targets.scene.destroy();
		for (const texture of [...targets.feedback, ...targets.tight, ...targets.wide]) texture.destroy();
	}

	function ensureTargets(state: SignalGpu, width: number, height: number) {
		if (state.targets?.width === width && state.targets.height === height) return;
		destroyTargets(state.targets);
		const hdr = (label: string, w: number, h: number) =>
			state.device.createTexture({
				label,
				size: { width: Math.max(1, w), height: Math.max(1, h) },
				format: 'rgba16float',
				usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
			});
		const scene = hdr('Signal beams', width, height);
		const feedback: [GPUTexture, GPUTexture] = [
			hdr('Signal phosphor A', width, height),
			hdr('Signal phosphor B', width, height)
		];
		const tightWidth = Math.ceil(width / SIGNAL_TIGHT_DIVISOR);
		const tightHeight = Math.ceil(height / SIGNAL_TIGHT_DIVISOR);
		const tight: [GPUTexture, GPUTexture] = [
			hdr('Signal tight glow', tightWidth, tightHeight),
			hdr('Signal tight glow scratch', tightWidth, tightHeight)
		];
		const wideWidth = Math.ceil(width / SIGNAL_WIDE_DIVISOR);
		const wideHeight = Math.ceil(height / SIGNAL_WIDE_DIVISOR);
		const wide: [GPUTexture, GPUTexture] = [
			hdr('Signal wide glow', wideWidth, wideHeight),
			hdr('Signal wide glow scratch', wideWidth, wideHeight)
		];
		const targets: SignalTargets = {
			scene,
			sceneView: scene.createView(),
			feedback,
			feedbackViews: [feedback[0].createView(), feedback[1].createView()],
			tight,
			tightViews: [tight[0].createView(), tight[1].createView()],
			wide,
			wideViews: [wide[0].createView(), wide[1].createView()],
			width,
			height
		};
		state.targets = targets;

		const uniform = { binding: 0, resource: { buffer: state.uniformBuffer } };
		const sampler = { binding: 1, resource: state.sampler };
		const bind = (pipeline: GPURenderPipeline, label: string, views: GPUTextureView[]) =>
			state.device.createBindGroup({
				label,
				layout: pipeline.getBindGroupLayout(0),
				entries: [
					uniform,
					sampler,
					...views.map((view, index) => ({ binding: 2 + index, resource: view }))
				]
			});
		const [phosphorA, phosphorB] = targets.feedbackViews;
		const [tightGlow, tightScratch] = targets.tightViews;
		const [wideGlow, wideScratch] = targets.wideViews;
		state.post = {
			feedback: [
				bind(state.feedbackPipeline, 'Signal phosphor reads A', [targets.sceneView, phosphorA]),
				bind(state.feedbackPipeline, 'Signal phosphor reads B', [targets.sceneView, phosphorB])
			],
			glowDown: [
				bind(state.glowDownPipeline, 'Signal glow prefilter A', [phosphorA]),
				bind(state.glowDownPipeline, 'Signal glow prefilter B', [phosphorB])
			],
			tightH: bind(state.tightHPipeline, 'Signal tight glow H', [tightGlow]),
			tightV: bind(state.tightVPipeline, 'Signal tight glow V', [tightScratch]),
			wideDown: bind(state.wideDownPipeline, 'Signal wide prefilter', [tightGlow]),
			wideH: bind(state.wideHPipeline, 'Signal wide glow H', [wideGlow]),
			wideV: bind(state.wideVPipeline, 'Signal wide glow V', [wideScratch]),
			composite: [
				bind(state.compositePipeline, 'Signal present A', [phosphorA, tightGlow, wideGlow]),
				bind(state.compositePipeline, 'Signal present B', [phosphorB, tightGlow, wideGlow])
			]
		};
		feedbackResetFrames = 2;
	}

	async function initGpu(targetCanvas: HTMLCanvasElement): Promise<SignalGpu> {
		const gpuApi = navigator.gpu;
		if (!gpuApi) throw new Error('Signal needs WebGPU, but this WebView does not expose it.');
		const adapter = await gpuApi.requestAdapter();
		if (!adapter) throw new Error('No compatible WebGPU adapter was found.');
		const wantTiming =
			new URLSearchParams(location.search).get('signalGpuTiming') === '1' &&
			adapter.features.has('timestamp-query');
		const device = (await adapter.requestDevice(
			wantTiming ? { requiredFeatures: ['timestamp-query'] } : undefined
		)) as GPUDevice;
		timer = wantTiming
			? {
					querySet: device.createQuerySet({ type: 'timestamp', count: 2 }),
					resolve: device.createBuffer({
						size: 16,
						usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
					}),
					readback: device.createBuffer({
						size: 16,
						usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
					})
				}
			: null;
		let context: GPUCanvasContext | null = null;
		let uniformBuffer: GPUBuffer | null = null;
		let detailBuffer: GPUBuffer | null = null;
		let terrainBuffer: GPUBuffer | null = null;
		let figureBuffer: GPUBuffer | null = null;
		let scopeBuffer: GPUBuffer | null = null;
		let voiceBuffer: GPUBuffer | null = null;
		try {
			context = targetCanvas.getContext('webgpu') as unknown as GPUCanvasContext | null;
			if (!context) throw new Error('The WebGPU canvas context could not be created.');
			const format = gpuApi.getPreferredCanvasFormat() as GPUTextureFormat;
			context.configure({ device, format, alphaMode: 'opaque' });

			const modules = {
				scene: device.createShaderModule({ label: 'Signal scene', code: SIGNAL_SCENE_WGSL }),
				beam: device.createShaderModule({ label: 'Signal XY beam', code: SIGNAL_BEAM_WGSL }),
				feedback: device.createShaderModule({ label: 'Signal phosphor', code: SIGNAL_FEEDBACK_WGSL }),
				glowDown: device.createShaderModule({ label: 'Signal glow', code: SIGNAL_GLOW_DOWN_WGSL }),
				tightH: device.createShaderModule({ label: 'Signal tight H', code: SIGNAL_TIGHT_BLUR_H_WGSL }),
				tightV: device.createShaderModule({ label: 'Signal tight V', code: SIGNAL_TIGHT_BLUR_V_WGSL }),
				wideDown: device.createShaderModule({ label: 'Signal wide', code: SIGNAL_WIDE_DOWN_WGSL }),
				wideH: device.createShaderModule({ label: 'Signal wide H', code: SIGNAL_WIDE_BLUR_H_WGSL }),
				wideV: device.createShaderModule({ label: 'Signal wide V', code: SIGNAL_WIDE_BLUR_V_WGSL }),
				composite: device.createShaderModule({ label: 'Signal composite', code: SIGNAL_COMPOSITE_WGSL })
			};
			await Promise.all(
				Object.entries(modules).map(async ([label, module]) => {
					const info = await module.getCompilationInfo();
					const errors = info.messages.filter((message) => message.type === 'error');
					if (errors.length) {
						const detail = errors
							.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`)
							.join(' | ');
						throw new Error(`Signal ${label} shader failed to compile: ${detail}`);
					}
				})
			);

			// Additive light: retraces and crossings stack, the way a beam's
			// energy really lands on the phosphor (the tone map rolls it off).
			const addBlend: GPUBlendState = {
				color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
				alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
			};
			const beams = (label: string, module: GPUShaderModule) =>
				device.createRenderPipelineAsync({
					label,
					layout: 'auto',
					vertex: { module, entryPoint: 'vs_main' },
					fragment: {
						module,
						entryPoint: 'fs_main',
						targets: [{ format: 'rgba16float', blend: addBlend }]
					},
					primitive: { topology: 'triangle-list', cullMode: 'none' }
				});
			const fullscreen = (label: string, module: GPUShaderModule, targetFormat: GPUTextureFormat) =>
				device.createRenderPipelineAsync({
					label,
					layout: 'auto',
					vertex: { module, entryPoint: 'vs_main' },
					fragment: { module, entryPoint: 'fs_main', targets: [{ format: targetFormat }] },
					primitive: { topology: 'triangle-list' }
				});
			const [
				scenePipeline,
				beamPipeline,
				feedbackPipeline,
				glowDownPipeline,
				tightHPipeline,
				tightVPipeline,
				wideDownPipeline,
				wideHPipeline,
				wideVPipeline,
				compositePipeline
			] = await Promise.all([
				beams('Signal strokes', modules.scene),
				beams('Signal XY beam', modules.beam),
				fullscreen('Signal phosphor', modules.feedback, 'rgba16float'),
				fullscreen('Signal glow prefilter', modules.glowDown, 'rgba16float'),
				fullscreen('Signal tight glow H', modules.tightH, 'rgba16float'),
				fullscreen('Signal tight glow V', modules.tightV, 'rgba16float'),
				fullscreen('Signal wide prefilter', modules.wideDown, 'rgba16float'),
				fullscreen('Signal wide glow H', modules.wideH, 'rgba16float'),
				fullscreen('Signal wide glow V', modules.wideV, 'rgba16float'),
				fullscreen('Signal present', modules.composite, format)
			]);

			uniformBuffer = device.createBuffer({
				label: 'Signal uniforms',
				size: SIGNAL_UNIFORM_BYTES,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
			});
			detailBuffer = device.createBuffer({
				label: 'Signal detail bins',
				size: DETAIL_BYTES,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
			});
			terrainBuffer = device.createBuffer({
				label: 'Signal horizon history',
				size: TERRAIN_FLOATS * 4,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
			});
			figureBuffer = device.createBuffer({
				label: 'Signal figure polyline',
				size: SIGNAL_FIGURE_FLOATS * 4,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
			});
			scopeBuffer = device.createBuffer({
				label: 'Signal stereo window',
				size: SIGNAL_SCOPE_WINDOW * 2 * 4,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
			});
			voiceBuffer = device.createBuffer({
				label: 'Signal voice lanes',
				size: SIGNAL_VOICE_FLOATS * 4,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
			});
			const sceneBindGroup = device.createBindGroup({
				label: 'Signal strokes',
				layout: scenePipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: uniformBuffer } },
					{ binding: 1, resource: { buffer: detailBuffer } },
					{ binding: 2, resource: { buffer: terrainBuffer } },
					{ binding: 3, resource: { buffer: figureBuffer } },
					{ binding: 4, resource: { buffer: scopeBuffer } },
					{ binding: 5, resource: { buffer: voiceBuffer } }
				]
			});
			const beamBindGroup = device.createBindGroup({
				label: 'Signal XY beam',
				layout: beamPipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: uniformBuffer } },
					{ binding: 1, resource: { buffer: figureBuffer } },
					{ binding: 2, resource: { buffer: scopeBuffer } }
				]
			});
			const state: SignalGpu = {
				device,
				context,
				format,
				sampler: device.createSampler({
					magFilter: 'linear',
					minFilter: 'linear',
					addressModeU: 'clamp-to-edge',
					addressModeV: 'clamp-to-edge'
				}),
				uniformBuffer,
				detailBuffer,
				terrainBuffer,
				figureBuffer,
				scopeBuffer,
				voiceBuffer,
				uniforms: new Float32Array(SIGNAL_UNIFORM_FLOATS),
				scenePipeline,
				beamPipeline,
				feedbackPipeline,
				glowDownPipeline,
				tightHPipeline,
				tightVPipeline,
				wideDownPipeline,
				wideHPipeline,
				wideVPipeline,
				compositePipeline,
				sceneBindGroup,
				beamBindGroup,
				targets: null,
				post: null,
				parity: 0
			};

			void device.lost.then((info) => {
				if (gpu?.device !== device) return;
				errorMsg = `The graphics device was lost${info.message ? `: ${info.message}` : '.'}`;
				ready = false;
				gpu = null;
			});
			return state;
		} catch (error) {
			uniformBuffer?.destroy();
			detailBuffer?.destroy();
			terrainBuffer?.destroy();
			figureBuffer?.destroy();
			scopeBuffer?.destroy();
			voiceBuffer?.destroy();
			try {
				context?.unconfigure();
			} catch {
				// A failed configure may also make unconfigure unavailable.
			}
			device.destroy();
			throw error;
		}
	}

	function destroyGpuState(state: SignalGpu | null) {
		if (!state) return;
		destroyTargets(state.targets);
		state.uniformBuffer.destroy();
		state.detailBuffer.destroy();
		state.terrainBuffer.destroy();
		state.figureBuffer.destroy();
		state.scopeBuffer.destroy();
		state.voiceBuffer.destroy();
		if (timer) {
			timer.querySet.destroy();
			timer.resolve.destroy();
			timer.readback.destroy();
			timer = null;
			gpuPending = false;
		}
		try {
			state.context.unconfigure();
		} catch {
			// The device may already be lost.
		}
		state.device.destroy();
	}

	function teardownGpu() {
		const state = gpu;
		gpu = null;
		ready = false;
		destroyGpuState(state);
	}

	/** Drum lane geometry (traces 4..7) as uniform values. */
	function laneFrames(layout: SignalLayout) {
		const out: Record<string, number> = {};
		for (let k = 4; k < 8; k += 1) {
			for (const key of ['ox', 'oy', 'tx', 'ty', 'vx', 'vy', 'scroll', 'vis'] as const) {
				out[`t${k}${key}`] = layout[`t${k}${key}` as keyof SignalLayout];
			}
		}
		return out as Pick<SignalUniformValues, `t${4 | 5 | 6 | 7}${'ox' | 'oy' | 'tx' | 'ty' | 'vx' | 'vy' | 'scroll' | 'vis'}`>;
	}

	/** Each lane's phosphor and light as uniform values. */
	function laneColours(light: Float32Array) {
		const out: Record<string, number> = {};
		for (let lane = 0; lane < SIGNAL_VOICE_LANES; lane += 1) {
			const k = lane + 2;
			out[`v${k}r`] = laneRgb[lane][0];
			out[`v${k}g`] = laneRgb[lane][1];
			out[`v${k}b`] = laneRgb[lane][2];
			out[`v${k}light`] = light[lane];
		}
		return out as Pick<SignalUniformValues, `v${2 | 3 | 4 | 5 | 6 | 7}${'r' | 'g' | 'b' | 'light'}`>;
	}

	function renderFrame(state: SignalGpu, dt: number) {
		if (!canvas) return;
		const size = backingSize(canvas);
		if (canvas.width !== size.width || canvas.height !== size.height) {
			canvas.width = size.width;
			canvas.height = size.height;
			internalPixels = size.width * size.height;
		}

		// Sample the shared feature clock, not the rAF frame-start timestamp.
		// Analyzer frames are stamped with performance.now() when they arrive,
		// which is usually later than the frame start; reading with the rAF
		// time made every fresh frame look like it came from the future, so
		// getLatest() returned null and the whole instrument went silent.
		const sampleAt = performance.now();
		const feature = vis.getLatest(sampleAt);
		const shared = vis.getJourney(sampleAt);
		if (shared.sourceEpoch !== rendererSourceEpoch) syncRendererSource(shared, feature !== null);

		ensureTargets(state, size.width, size.height);
		const targets = state.targets;
		const post = state.post;
		if (!targets || !post) return;
		// The stereo pairs whose time has come (renderer-only; see scope-beam.ts).
		const beam = scopeBeam.update(vis.scope, dt, sampleAt);

		const directed = shared.director;
		const spectrum = shared.spectrum;
		const clock = directed.clock;
		const response = VISUALIZER_TUNING.signal;
		// Conductor rails, carried across a new source so a song change glides.
		// Transients (impact, ring-out, section pulse) pass through untouched.
		carry.advance(dt);
		const conductor = shared.signal;
		const journey = carriedJourney;
		journey.tension = carry.apply('tension', conductor.tension);
		journey.release = carry.apply('release', conductor.release);
		journey.openness = carry.apply('openness', conductor.openness);
		journey.motion = carry.apply('motion', conductor.motion);
		journey.channels = carry.apply('channels', conductor.channels);
		journey.complexity = carry.apply('complexity', conductor.complexity);
		journey.sweepBeats = carry.apply('sweepBeats', conductor.sweepBeats);
		journey.tickRate = carry.apply('tickRate', conductor.tickRate);
		journey.tempo = carry.apply('tempo', conductor.tempo);
		journey.signedAsymmetry = carry.apply('signedAsymmetry', conductor.signedAsymmetry);
		journey.ellipse = carry.apply('ellipse', conductor.shapeWeights.ellipse);
		journey.lissajous = carry.apply('lissajous', conductor.shapeWeights.lissajous);
		journey.ribbon = carry.apply('ribbon', conductor.shapeWeights.ribbon);
		journey.rosette = carry.apply('rosette', conductor.shapeWeights.rosette);
		journey.energy = carry.apply('energy', directed.energy);
		journey.impact = conductor.impact;
		journey.ringOut = conductor.ringOut;
		journey.sectionPulse = conductor.sectionPulse;
		journey.tracePhase = conductor.tracePhase;
		const responseMotion = response.motion;
		const responseImpact = response.impact;

		// ---- Character: what kind of music this is, as an instrument. --------
		if (!variation) {
			variation = signalVariationFor(shared.seed, shared.sourceEpoch);
			variation.setOverride(lookOverride);
		}
		const genome = variation;
		// The music's character: weights fitted to it, character-led axes
		// pulled toward it, and every new shift answered once (genome.shift).
		const character = shared.character;
		const shiftEvent = genome.respond(character, directed.energy, dt, beam.interest);
		const roam = roamFor(shared.seed);
		if (shiftEvent) {
			reactBoost = Math.max(reactBoost, 1 + 4.5 * Math.max(0.65, shiftEvent.strength));
			// New music, new ground: the bench and the camera set off somewhere
			// else at once (on their springs, so it glides).
			roam.redirect();
		}
		reactBoost = 1 + (reactBoost - 1) * Math.exp(-dt / 4);
		const voice = voiceTracker.update(character, dt, Math.max(reactBoost * 0.75, genome.genome.glideSpeed));

		// Audio envelopes at render rate.
		const rmsTarget = clamp(feature?.rms ?? 0, 0, 1);
		rms = approach(rms, rmsTarget, rmsTarget > rms ? 18 : 7, dt);
		if (!feature || rmsTarget < 0.009) quietFor += dt;
		else quietFor = 0;
		silence = approach(silence, quietFor > 0.45 ? 1 : 0, quietFor > 0.45 ? 4 : 7, dt);
		const bandMix = 1 - Math.exp(-dt / 0.05);
		for (const key of BAND_KEYS) {
			const target = feature ? spectrum.levels[key] : 0;
			bands[key] += (target - bands[key]) * bandMix;
		}
		for (let index = 0; index < renderDetailBins.length; index += 1) {
			const target = feature ? (spectrum.detailBins[index] ?? 0) : 0;
			renderDetailBins[index] += (target - renderDetailBins[index]) * bandMix;
		}
		spectralMotion = approach(spectralMotion, spectrum.spectralMotion, 10, dt);
		// Hero placement glides over bars, never per beat, so it cannot smear.
		asymmetry = approach(asymmetry, journey.signedAsymmetry, 0.3, dt);

		// ---- The band: every part of the bench answers its own instrument. ----
		const ensemble = shared.ensemble;
		const band = bandFor(shared.seed);
		const voices = band.update(ensemble, dt, {
			fallbackBpm: clamp(clock.tempoBpm || 120, 40, 220),
			silent: !feature || silence > 0.6,
			restless: clamp(0.25 + ensemble.texture.density * 0.5 + ensemble.texture.build * 0.3, 0, 1),
			reroute: shiftEvent ? shiftEvent.strength : 0,
			chordCycles
		});

		// Song clock: beats phase-locked to the director's phrase anchor.
		const bpmTarget = clamp(clock.tempoBpm || 0, 0, 220);
		renderBpm = approach(renderBpm, bpmTarget >= 30 ? bpmTarget : 120, 2, dt);
		const beatsPerSecond = renderBpm / 60;
		if (feature && silence < 0.5) renderBeats += dt * beatsPerSecond;
		const anchor = beatAnchor(clock);
		if (feature && anchor !== null) {
			const diff = anchor - renderBeats;
			if (Math.abs(diff) > BEATS_PER_PHRASE * 0.75) renderBeats = anchor;
			else renderBeats += diff * (1 - Math.exp(-dt / 0.45));
		}
		// Beat light comes only from what is heard: the kick band's rise and the
		// analyzer's onsets, decaying in a breath. Never the predicted clock.
		const kickLevel = feature ? spectrum.levels.kick : 0;
		const kickRise = Math.max(0, kickLevel - lastKickLevel);
		lastKickLevel = kickLevel;
		transient *= Math.exp(-dt / 0.14);
		transient = Math.max(transient, clamp(kickRise * 7, 0, 1), feature?.onset ? 0.55 : 0);

		// Channel sweep: one pass per sweepBeats, locked to the bar when the
		// section's sweep length settles on a whole number of beats.
		// Each part takes a new section's pace on its own time: the X/Y sweep
		// over several seconds, the horizon's scroll more slowly still, so a
		// section change is not every part speeding up in the same instant.
		sweepGlide = sweepGlide > 0 ? approach(sweepGlide, journey.sweepBeats, 1 / 5, dt) : journey.sweepBeats;
		const sweepBeats = clamp(sweepGlide, 0.5, 4);
		const sweepStep = (dt * beatsPerSecond) / sweepBeats;
		sweepPhase += sweepStep;
		const wholeBeats = Math.max(1, Math.round(sweepBeats));
		const lockStrength = clamp(1 - Math.abs(sweepBeats - wholeBeats) * 3, 0, 1);
		if (feature && lockStrength > 0) {
			const lockError = wrapSigned(renderBeats / wholeBeats - sweepPhase);
			sweepPhase += lockError * (1 - Math.exp(-dt / 0.35)) * lockStrength;
		}
		sweepPhase -= Math.floor(sweepPhase);

		// Hero rotation integrates the conductor's monotonic trace phase so
		// remounts and response changes never jump the figure.
		// Tempo sets how fast the beam writes; a club lock trades the smooth
		// drift for one stride per heard kick (never the predicted beat): each
		// kick pushes the figure on by its velocity, eased over a breath.
		const traceDelta = clamp(journey.tracePhase - lastTracePhase, 0, 0.5);
		lastTracePhase = journey.tracePhase;
		const kickLayer = ensemble.drums.kick;
		if (kickLayer.serial !== kickStrideSerial) {
			if (kickStrideSerial >= 0 && feature && silence < 0.5) kickStrideTarget += 0.5 + kickLayer.velocity * 0.5;
			kickStrideSerial = kickLayer.serial;
		}
		const strideBefore = kickStride;
		kickStride += (kickStrideTarget - kickStride) * (1 - Math.exp(-dt / 0.09));
		const lockDelta = clamp(kickStride - strideBefore, 0, 0.5);
		// The lock only holds while a kick is there to step on; without one the
		// figure drifts on at its own pace instead of stopping with the drums.
		const lock = voice.lock * clamp(kickLayer.present * 1.3, 0, 1);
		// The hero keeps its own pace through a section change: the conductor's
		// rate reaches it over several seconds, so the whole bench does not
		// speed up or calm down in one instant.
		const tracePace = dt > 0 ? traceDelta / dt : 0;
		heroPace = heroPace > 0 ? approach(heroPace, tracePace, 1 / 6, dt) : tracePace;
		figurePhase +=
			heroPace * dt * 1.6 * responseMotion * voice.speed * (1 - lock * 0.8) +
			lockDelta * 0.22 * lock * responseMotion;
		breathPhase += dt * 0.75;
		grainClock += dt * voice.speed;
		fracturePhase += dt * (0.8 + voice.speed * 2.2);

		const energy = clamp(
			journey.energy * 0.58 + rms * 0.24 + bands.body * 0.08 + spectralMotion * 0.1,
			0,
			1
		);
		const impact = clamp(journey.impact * responseImpact, 0, 1);
		// Parts take the section's energy on their own time: the hero now, the
		// X/Y traces over a few seconds, the beam head's pool on the bench later.
		traceEnergy = approach(traceEnergy, energy, 1 / 4, dt);
		headEnergy = approach(headEnergy, energy, 1 / 7, dt);
		const ringOut = journey.ringOut;
		const modeTarget =
			(directed.context.keyMode === 'major' ? 1 : directed.context.keyMode === 'minor' ? -1 : 0) *
			clamp(0.4 + directed.context.keyConfidence, 0, 1);
		mode = approach(mode, modeTarget, 0.8, dt);
		const aspect = size.width / Math.max(size.height, 1);
		const elapsed = (performance.now() - startTime) / 1000;

		// ---- Genome: the look walks forward at musical boundaries. ----------
		genome.advance({
			phraseIndex: clock.phraseIndex,
			section: directed.section,
			energy: directed.energy,
			silence: directed.silence || !feature,
			dt
		});
		// The genome decides; the morphs make each decision one finished,
		// staggered, eased move (see SignalChoiceMorph). They pause in silence
		// with the genome, so a quiet gap never lands half a move.
		// Right after a shift they run several times faster, so the answer
		// lands in one or two seconds and still glides. Colour may turn fast;
		// moves that rearrange the bench (layout, camera) keep at least about
		// three seconds so the composition travels instead of cutting.
		const morphDt = directed.silence || !feature ? 0 : dt;
		const structural = 1 + (reactBoost - 1) * 0.75;
		const layoutChoice = morphs.layout.update(genome.choice('layout').to, morphDt, structural);
		const familyChoice = morphs.family.update(genome.choice('family').to, morphDt, 1 + (reactBoost - 1) * 0.8);
		const paletteChoice = morphs.palette.update(genome.choice('palette').to, morphDt, reactBoost * 1.7);
		partSpan = PART_SPAN + (1 - PART_SPAN) * clamp((reactBoost - 1) / 2, 0, 1);
		const cameraChoice = morphs.camera.update(genome.choice('camera').to, morphDt, structural);
		const displayChoice = morphs.display.update(genome.choice('display').to, morphDt, reactBoost);
		// The trace map now styles the chord lane: how many root cycles its
		// standing wave spans (glided, so the wave re-spaces as it is written).
		const traceMapChoice = morphs.traceMap.update(genome.choice('traceMap').to, morphDt, reactBoost);
		chordCycles =
			CHORD_CYCLES[traceMapChoice.from] +
			(CHORD_CYCLES[traceMapChoice.to] - CHORD_CYCLES[traceMapChoice.from]) * traceMapChoice.mix;
		const mirrorChoice = morphs.mirror.update(genome.choice('mirror').to, morphDt, structural);
		// The roam travels through each bench's room of arrangements while the
		// genome picks which bench: tempo sets its pace, energy its restlessness,
		// and it holds still in silence with the morphs.
		roam.update(morphDt, {
			tempo: journey.tempo,
			// The roam's restlessness is its own drifting voice, not the
			// section's energy: a drop does not set every part moving at once.
			energy: 0.35 + voices.restless * 0.35,
			ringOut: journey.ringOut
		});
		signalCompose(roam.compose.value, compose);
		for (const key of Object.keys(compose) as (keyof SignalCompose)[]) {
			if (roamPin[key] !== undefined) compose[key] = roamPin[key];
		}
		const layoutFrom = layoutFor(layoutChoice.from, aspect, mirrorChoice, roam);
		const layoutTo =
			layoutChoice.to === layoutChoice.from ? layoutFrom : layoutFor(layoutChoice.to, aspect, mirrorChoice, roam);
		// Panels, traces and faces travel to their new places, each in its own
		// window of the move: the cubies turn one after another.
		const layout = lerpSignalLayout(layoutFrom, layoutTo, layoutChoice.mix, layoutMix);
		if (layoutChoice.from !== layoutChoice.to) {
			for (let part = 0; part < SIGNAL_LAYOUT_PARTS.length; part += 1) {
				const delay = signalPartDelay(layoutChoice.from, layoutChoice.to, part, partSpan);
				lerpSignalLayoutPart(layoutFrom, layoutTo, part, signalPartMix(layoutChoice.progress, delay, partSpan), layout);
			}
		}
		const camera = lerpPreset(
			SIGNAL_CAMERAS[cameraChoice.from],
			SIGNAL_CAMERAS[cameraChoice.to],
			cameraChoice.mix
		);
		const display = lerpPreset(
			SIGNAL_DISPLAYS[displayChoice.from],
			SIGNAL_DISPLAYS[displayChoice.to],
			displayChoice.mix
		);
		const gene = (name: Parameters<SignalVariation['value']>[0]) => genome.value(name);

		// ---- Camera ------------------------------------------------------------
		// The regime the genome picked is the centre of a region the camera
		// roams: pitch, height, focal length and yaw each travel on their own
		// springs. Dolly and sway regimes roam wider in height and yaw.
		const drift = gene('drift');
		const roamCam = roam.camera.value;
		const camRoam = (axis: number) => clamp(roamPin[`cam${axis}`] ?? roamCam[axis], -1.3, 1.3);
		const yawRoam = camRoam(3) * (0.07 + camera.sway * 0.55) + (drift - 0.5) * 0.12;
		/** One bench's camera under the current camera regime. */
		const benchCamera = (bench: SignalLayout) => {
			const freedom = bench.freedom;
			return {
				pitch: bench.pitch + (camera.pitch + camRoam(0) * 0.12 + (drift - 0.5) * 0.06) * freedom,
				height:
					bench.camHeight *
					(1 + (camera.height - 1) * freedom) *
					(1 + camRoam(1) * (0.24 + camera.dolly * 0.12) * freedom),
				focal: bench.focal * (1 + (camera.focal - 1) * freedom) * (1 + camRoam(2) * 0.08 * freedom),
				yaw: yawRoam * freedom
			};
		};
		// The blended bench drives the figure's tilt; each horizon surface keeps
		// its own bench's camera (rigs A and B below).
		const camPitch = benchCamera(layout).pitch;
		const rigCameraA = benchCamera(layoutFrom);
		const rigCameraB = benchCamera(layoutTo);

		// ---- Figure placement ----------------------------------------------------
		const driftX = clamp(asymmetry * 0.62, -0.4, 0.4) * aspect * layout.drift;
		const conductorScale = clamp(
			0.29 +
				journey.openness * 0.21 +
				journey.release * 0.05 -
				journey.tension * 0.05 +
				ringOut * 0.03,
			0.22,
			0.56
		);
		// Bass sets the figure's weight; ambient breathes it slowly, a club lock
		// kicks it on the beat.
		const scaleFactor =
			clamp(conductorScale / 0.4, 0.72, 1.3) *
			(0.86 + gene('figureScale') * 0.26) *
			voice.scale *
			// The breath swells on a path that never repeats its rhythm.
			(1 + voice.breathe * 0.07 * roam.noise(SIGNAL_NOISE_LANE.breath, breathPhase * 0.16)) *
			(1 + voice.lock * transient * 0.02);
		const figAScale = layout.figAScale * scaleFactor;
		// The hero drifts slowly about its place on the face, the way a real
		// trace wanders with the tube's warm-up; its own size sets how far.
		roam.drift(heroDrift);
		const figAX = layout.figAX + driftX + heroDrift[0] * figAScale * 0.1;
		const figAY =
			layout.figAY +
			(journey.openness * 0.04 - journey.tension * 0.03) * layout.drift +
			heroDrift[1] * figAScale * 0.07;
		const screen = clamp(layout.figBScreen, 0, 1);
		const figBX = figAX + (layout.figBX - figAX) * screen;
		const figBY = figAY + (layout.figBY - figAY) * screen;
		const figBScale = figAScale + (layout.figBScale * scaleFactor - figAScale) * screen;

		// ---- Figure polyline: the one signal everything else reads. -----------
		const spin = gene('spin');
		spinAngle += dt * spin * 0.18 * (0.4 + journey.motion) * voice.speed;
		// The stereo ghost opens with the stereo image and its own drifting voice.
		const spread =
			0.02 +
			bands.air * 0.06 +
			journey.release * 0.05 +
			ringOut * 0.2 +
			ensemble.texture.width * 0.05 +
			(voices.ghost - 0.4) * 0.08;
		const figureInput: SignalFigureInput = {
			familyFrom: familyChoice.from,
			familyTo: familyChoice.to,
			familyMix: familyChoice.mix,
			phase: figurePhase,
			complexity: journey.complexity,
			mode,
			p1: gene('p1'),
			p2: gene('p2'),
			ellipse: journey.ellipse,
			lissajous: journey.lissajous,
			ribbon: journey.ribbon,
			rosette: journey.rosette,
			tension: journey.tension,
			release: journey.release,
			spread,
			sub: bands.sub,
			kick: bands.kick,
			body: bands.body,
			mids: bands.mids,
			presence: bands.presence,
			air: bands.air,
			spectralMotion,
			energy,
			detail: renderDetailBins,
			yaw:
				asymmetry * 0.55 +
				// Wobble on the figure's own music-driven phase, never periodic.
				roam.noise(SIGNAL_NOISE_LANE.yaw, figurePhase * 0.037) * (0.18 + voices.wobble * 0.36) +
				spinAngle +
				voice.organic * 0.22 * roam.noise(SIGNAL_NOISE_LANE.organic, grainClock * 0.046),
			tilt:
				0.34 +
				journey.tension * 0.2 -
				journey.release * 0.08 +
				(gene('tilt') - 0.5) * 0.5 +
				camPitch * 0.35,
			roll: figurePhase * 0.05 + spinAngle * 0.6,
			partner: layout.partner,
			dt,
			pace: (beatsPerSecond / 2) * (0.5 + journey.motion),
			jitter: voice.jitter,
			wander: voice.organic,
			grainTime: grainClock,
			harmonyIndex: voices.heroIndex,
			harmonyMinor: voices.heroMinor,
			harmonyLead: voices.heroLead
		};
		const figurePoints = figureEngine.evaluate(figureInput);
		const headU = sweepPhase;
		figureEngine.sample(0, headU, headLocal);
		// The XY beam owns the hero by the scope family's share of the morph,
		// and only while the signal is there; otherwise the synthesized figure
		// carries on. When the picture turns to a cloud (noise, a dense mix)
		// the beam mostly hands back: the synthesized figure, shaken by the
		// signal. Goniometer view (mid up) as the tilt gene runs high.
		const beamMix =
			signalScopeShare(familyChoice.from, familyChoice.to, familyChoice.mix) *
			beam.live *
			(0.2 + 0.8 * beam.structure);
		const beamTurn = smoothstep(0.58, 0.78, gene('tilt')) * (Math.PI / 4);
		// X and Y are written where the sweep head passes (see band.ts).
		// With the XY beam up they carry the real left and right waveforms,
		// triggered, but repainted by the head as it passes rather than all at
		// once every frame: the traces change where they are written.
		const waveMix = beamMix;
		const scopeWindow = scopeBeam.window;
		band.writeDeflection(lastSweepWritten, sweepPhase, (u, out) => {
			figureEngine.sample(0, u, out);
			if (waveMix > 0.001) {
				const position = clamp(beam.traceStart + u * beam.traceSpan, 0, SIGNAL_SCOPE_WINDOW - 2);
				const i0 = Math.floor(position);
				const f = position - i0;
				const l = scopeWindow[i0 * 2] + (scopeWindow[i0 * 2 + 2] - scopeWindow[i0 * 2]) * f;
				const r = scopeWindow[i0 * 2 + 1] + (scopeWindow[i0 * 2 + 3] - scopeWindow[i0 * 2 + 1]) * f;
				out[0] += (0.95 * Math.tanh((l * beam.agc) / 0.95) - out[0]) * waveMix;
				out[1] += (0.95 * Math.tanh((r * beam.agc) / 0.95) - out[1]) * waveMix;
			}
		});
		lastSweepWritten = sweepPhase;
		if (beamMix > 0) {
			const c = Math.cos(beamTurn);
			const s = Math.sin(beamTurn);
			const hx = beam.head[0] * c - beam.head[1] * s;
			const hy = beam.head[0] * s + beam.head[1] * c;
			headLocal[0] += (hx - headLocal[0]) * beamMix;
			headLocal[1] += (hy - headLocal[1]) * beamMix;
		}
		const headX = figAX + headLocal[0] * figAScale;
		const headY = figAY + headLocal[1] * figAScale;
		const headTurn = (Math.atan2(headLocal[1], headLocal[0]) / (Math.PI * 2) + 1) % 1;

		// ---- Horizon: the figure's history, written on beat ticks. ------------
		const coupling = clamp(0.5 + gene('coupling') * 0.42, 0, 1);
		accumulateTerrainRow(coupling, headTurn, 0, beamMix, beamTurn);
		// Who played while this row was written, each at its own place.
		band.stamps(ensemble, stampRow);
		// Rows are written on the band's own tempo, never the director's clock.
		// The newest row no longer flashes across its whole width: the kick
		// lights its own stamp under the figure instead.
		tickGlide = tickGlide > 0 ? approach(tickGlide, journey.tickRate, 1 / 11, dt) : journey.tickRate;
		const tickRate = clamp(tickGlide, 0.125, 3);
		tickPhase += dt * (voices.bpm / 60) * tickRate * (feature ? 1 : 0.25);
		if (tickPhase >= 1) {
			tickPhase -= Math.floor(tickPhase);
			commitTerrainRow();
		}
		tickFlash = 0.5;

		// Surface rigs. Each bench projects its own horizon with its own camera;
		// a bench change blends the two projections on screen (rows nearest
		// the figure first), so the horizon re-forms instead of the camera
		// swinging through poses where it falls behind the lens.
		const driftBase = clamp(asymmetry * 0.62, -0.4, 0.4) * aspect;
		const reliefDrive = (0.75 + gene('relief') * 0.5) * 0.95;
		const surfaceRig = (bench: SignalLayout, cam: ReturnType<typeof benchCamera>) => {
			// Put the surface's anchor (vanishing point, ring centre, waterfall
			// origin) where the bench wants it.
			const anchorX = bench.anchorX + driftBase * bench.drift * bench.anchorFollow;
			const anchorY = bench.anchorY;
			let offset: [number, number] = [anchorX, anchorY];
			if (bench.surface === SURFACE_RING) {
				const cp = Math.cos(cam.pitch);
				const sp = Math.sin(cam.pitch);
				const cy = Math.cos(cam.yaw);
				const sy = Math.sin(cam.yaw);
				const wy = -cam.height;
				const wz = bench.ringZ;
				const x1 = wz * sy;
				const z1 = wz * cy;
				const y2 = wy * cp + z1 * sp;
				const z2 = Math.max(0.03, -wy * sp + z1 * cp);
				offset = [anchorX - (x1 * cam.focal) / z2, anchorY - (y2 * cam.focal) / z2];
			} else if (bench.surface === SURFACE_FLOOR || bench.surface === SURFACE_TUNNEL) {
				offset = [anchorX - cam.focal * Math.tan(cam.yaw), anchorY - cam.focal * Math.tan(cam.pitch)];
			}
			return { cam, offset, anchorX, anchorY, relief: bench.relief * reliefDrive };
		};
		const rigA = surfaceRig(layoutFrom, rigCameraA);
		const rigB = surfaceRig(layoutTo, rigCameraB);
		const surfaceA = layoutFrom.surface;
		const surfaceB = layoutTo.surface;

		// ---- Phosphor ------------------------------------------------------------
		const paletteContext = {
			hueLean: gene('hueLean'),
			mode,
			energy: 0.5,
			warmth: gene('warmth'),
			temperature: voice.temperature
		};
		resolveSignalPalette(paletteChoice.from, paletteChoice.to, paletteChoice.mix, paletteContext, paletteOut);
		if (paletteChoice.from !== paletteChoice.to) {
			// A new phosphor reaches the tube's roles one after another.
			PALETTE_ROLES.forEach((role, index) => {
				const delay = signalPartDelay(paletteChoice.from + 31, paletteChoice.to + 31, index, partSpan);
				resolveSignalPalette(
					paletteChoice.from,
					paletteChoice.to,
					signalPartMix(paletteChoice.progress, delay, partSpan),
					paletteContext,
					paletteScratch
				);
				paletteOut[role][0] = paletteScratch[role][0];
				paletteOut[role][1] = paletteScratch[role][1];
				paletteOut[role][2] = paletteScratch[role][2];
			});
		}
		// Each tube role leans on its own: the hero by the chord (major warm,
		// minor cool, diminished twisted), the traces and the horizon by their
		// own drifting voices.
		leanColour(paletteOut.hero, voices.heroWarmth * 0.45 + (voices.heroLean - 0.5) * 0.4, voices.heroTwist * 0.4, leanScratch);
		paletteOut.hero[0] = leanScratch[0];
		paletteOut.hero[1] = leanScratch[1];
		paletteOut.hero[2] = leanScratch[2];
		leanColour(paletteOut.trace, (voices.traceLean - 0.5) * 1.2, 0, leanScratch);
		paletteOut.trace[0] = leanScratch[0];
		paletteOut.trace[1] = leanScratch[1];
		paletteOut.trace[2] = leanScratch[2];
		leanColour(paletteOut.horizon, (voices.horizonLean - 0.5) * 1.2, 0, leanScratch);
		paletteOut.horizon[0] = leanScratch[0];
		paletteOut.horizon[1] = leanScratch[1];
		paletteOut.horizon[2] = leanScratch[2];
		// The lanes: bass in the horizon's phosphor, the chord in the hero's,
		// each drum its own mix of the tube's roles.
		const blendRgb = (a: ArrayLike<number>, b: ArrayLike<number>, t: number, out: [number, number, number]) => {
			out[0] = a[0] + (b[0] - a[0]) * t;
			out[1] = a[1] + (b[1] - a[1]) * t;
			out[2] = a[2] + (b[2] - a[2]) * t;
			return out;
		};
		blendRgb(paletteOut.horizon, paletteOut.hero, 0.35, laneRgb[0]);
		blendRgb(paletteOut.hero, paletteOut.trace, 0.2, laneRgb[1]);
		blendRgb(paletteOut.horizon, paletteOut.hot, 0.3, laneRgb[2]);
		blendRgb(paletteOut.trace, paletteOut.hot, 0.55, laneRgb[3]);
		blendRgb(paletteOut.trace, paletteOut.hero, 0.15, laneRgb[4]);
		blendRgb(paletteOut.trace, paletteOut.horizon, 0.5, laneRgb[5]);
		for (let lane = 0; lane < SIGNAL_VOICE_LANES; lane += 1) {
			leanColour(laneRgb[lane], voices.warmth[lane], voices.twist[lane], laneRgb[lane]);
		}

		// Phosphor persistence per 60 Hz frame, converted to this frame's dt.
		const persistence = clamp(
			0.875 +
				journey.tension * 0.02 +
				(1 - journey.motion) * 0.012 -
				journey.release * 0.01 -
				impact * 0.04 +
				response.persistenceOffset +
				display.persist +
				(gene('persistence') - 0.5) * 0.04 +
				voice.persistence +
				// Legato lingers on the tube, staccato is wiped quickly.
				voices.legato * 0.018,
			0.78,
			0.972
		);
		const feedbackFade =
			feedbackResetFrames > 0 ? 0 : Math.pow(persistence * (1 - silence * 0.04), dt * 60);
		// Fast phosphor for channel tails and horizon rows (their tails are drawn
		// analytically, so the feedback only needs to soften them).
		const floorFade = feedbackResetFrames > 0 ? 0 : Math.pow(0.6, dt * 60);
		if (feedbackResetFrames > 0) feedbackResetFrames -= 1;
		// Light each frame deposits. A stroke redrawn every frame builds toward
		// deposit / fade, a one-off fast stroke shows only its deposit: so
		// standing figures glow and passing ones are faint, as on a real tube.
		// A deposit a little over the fade settles a standing stroke near its
		// intensity, so the tone map has headroom for dwell and retraces.
		const frames60 = dt * 60;
		const depositLong = ((1 - persistence) * 1.15 + 0.025) * frames60;
		const depositShort = 0.42 * frames60;
		// Beam light: the same reference intensity the hero uses, carried by
		// every segment equally. The reference length is the geometric mean
		// of the beam's mean step and a fixed 2 px, so a larger or busier
		// picture dims by the square root of its speed, not all the way.
		const halfHeight = size.height * 0.5;
		const beamSegments = Math.max(1, beam.segments);
		const synthStep = (figureEngine.meanLength[0] * SIGNAL_FIGURE_SEGMENTS) / beamSegments;
		const meanStepPx = (synthStep + (beam.step - synthStep) * beamMix) * figAScale * halfHeight;
		const beamReference = Math.sqrt(Math.max(meanStepPx, 0.02) * 2);
		const heroLight =
			(0.62 + energy * 0.4 + clamp(journey.sectionPulse * responseImpact, 0, 1) * 0.3) *
			(1 - silence * 0.55) *
			paletteOut.gain *
			voice.gain;
		// A figure's light shrinks with its size: double the figure, about
		// two thirds the light per pixel.
		const sizeEnergy = (meanLength: number, scale: number) =>
			Math.pow(Math.max((meanLength * scale * halfHeight) / 7, 0.05), -0.4);

		const scanAxis = gene('scan');
		const values: SignalUniformValues = {
			width: size.width,
			height: size.height,
			elapsed,
			dt,
			sub: bands.sub,
			kick: bands.kick,
			body: bands.body,
			mids: bands.mids,
			presence: bands.presence,
			air: bands.air,
			rms,
			centroid: spectrum.centroid,
			impact,
			transient,
			sectionPulse: clamp(journey.sectionPulse * responseImpact, 0, 1),
			ringOut,
			energy: clamp(energy * responseMotion, 0, 1),
			silence,
			stroke:
				response.stroke *
				display.stroke *
				(0.86 + gene('stroke') * 0.28) *
				voice.weight,
			beatPhase: clamp(clock.beatPhase, 0, 1),
			heroR: paletteOut.hero[0],
			heroG: paletteOut.hero[1],
			heroB: paletteOut.hero[2],
			paletteGain: paletteOut.gain * voice.gain,
			traceR: paletteOut.trace[0],
			traceG: paletteOut.trace[1],
			traceB: paletteOut.trace[2],
			ghostSpread: spread,
			horizonR: paletteOut.horizon[0],
			horizonG: paletteOut.horizon[1],
			horizonB: paletteOut.horizon[2],
			coupling,
			hotR: paletteOut.hot[0],
			hotG: paletteOut.hot[1],
			hotB: paletteOut.hot[2],
			headGlow: 0.9 + energy * 0.4,
			roomR: paletteOut.room[0],
			roomG: paletteOut.room[1],
			roomB: paletteOut.room[2],
			haze: display.haze,
			figAX,
			figAY,
			figAScale,
			figAVis: 1,
			figBX,
			figBY,
			figBScale,
			figBScreen: screen,
			headU,
			headX,
			headY,
			lightLevel: (0.55 + headEnergy * 0.3) * (1 - silence * 0.6),
			sweepPhase,
			channels: clamp(journey.channels * (0.85 + responseMotion * 0.15), 0, 4),
			feed: layout.feed,
			traceLevel: traceEnergy,
			t0ox: layout.t0ox,
			t0oy: layout.t0oy,
			t0tx: layout.t0tx,
			t0ty: layout.t0ty,
			t0vx: layout.t0vx,
			t0vy: layout.t0vy,
			t0scroll: layout.t0scroll,
			t0vis: layout.t0vis,
			t1ox: layout.t1ox,
			t1oy: layout.t1oy,
			t1tx: layout.t1tx,
			t1ty: layout.t1ty,
			t1vx: layout.t1vx,
			t1vy: layout.t1vy,
			t1scroll: layout.t1scroll,
			t1vis: layout.t1vis,
			t2ox: layout.t2ox,
			t2oy: layout.t2oy,
			t2tx: layout.t2tx,
			t2ty: layout.t2ty,
			t2vx: layout.t2vx,
			t2vy: layout.t2vy,
			t2scroll: layout.t2scroll,
			t2vis: layout.t2vis,
			t3ox: layout.t3ox,
			t3oy: layout.t3oy,
			t3tx: layout.t3tx,
			t3ty: layout.t3ty,
			t3vx: layout.t3vx,
			t3vy: layout.t3vy,
			t3scroll: layout.t3scroll,
			t3vis: layout.t3vis,
			...laneFrames(layout),
			vis2: voices.vis[0],
			vis3: voices.vis[1],
			vis4: voices.vis[2],
			vis5: voices.vis[3],
			vis6: voices.vis[4],
			vis7: voices.vis[5],
			fillTravel: voices.fillTravel,
			fillAmount: voices.fillAmount,
			head2: voices.head[0],
			head3: voices.head[1],
			head4: voices.head[2],
			head5: voices.head[3],
			head6: voices.head[4],
			head7: voices.head[5],
			withdraw: voices.withdraw,
			gather: voices.gather,
			...laneColours(voices.light),
			rail0: voices.rails[0],
			rail1: voices.rails[1],
			rail2: voices.rails[2],
			rail3: voices.rails[3],
			rail4: voices.rails[4],
			rail5: voices.rails[5],
			rail6: voices.rails[6],
			graticule: voices.graticule,
			feedX: voices.feeds[0],
			feedY: voices.feeds[1],
			feedDrip: voices.feeds[2],
			feedLight: voices.feedLight,
			floorKick: voices.zones[0],
			floorSnare: voices.zones[1],
			floorHat: voices.zones[2],
			floorPerc: voices.zones[3],
			chordTurn: voices.chordTurn,
			chordLight: voices.zones[4],
			bassTurn: voices.bassTurn,
			bassLight: voices.zones[5],
			surfaceA,
			surfaceB,
			surfaceMix: layoutChoice.mix,
			terrainVis: layout.terrainVis,
			tickPhase,
			headIndex: terrainHead,
			tickFlash,
			relief: rigA.relief,
			camHeight: rigA.cam.height,
			camPitch: rigA.cam.pitch,
			camYaw: rigA.cam.yaw,
			focal: rigA.cam.focal,
			offAX: rigA.offset[0],
			offAY: rigA.offset[1],
			offBX: rigB.offset[0],
			offBY: rigB.offset[1],
			near: layoutFrom.near,
			far: layoutFrom.far,
			span: layoutFrom.span,
			rails: layout.rails,
			ringInner: layoutFrom.ringInner,
			ringOuter: layoutFrom.ringOuter,
			ringZ: layoutFrom.ringZ,
			radarArm: layout.radarArm,
			wfX: rigA.anchorX,
			wfY: rigA.anchorY,
			wfDx: layoutFrom.wfDx,
			wfDy: layoutFrom.wfDy,
			camHeightB: rigB.cam.height,
			camPitchB: rigB.cam.pitch,
			camYawB: rigB.cam.yaw,
			focalB: rigB.cam.focal,
			nearB: layoutTo.near,
			farB: layoutTo.far,
			spanB: layoutTo.span,
			reliefB: rigB.relief,
			ringInnerB: layoutTo.ringInner,
			ringOuterB: layoutTo.ringOuter,
			ringZB: layoutTo.ringZ,
			// A sped-up bench change ripples less, so no single row re-forms faster
			// than it does in an ordinary scene change.
			surfaceRipple: Math.max(0, (1 + SURFACE_RIPPLE) / structural - 1),
			wfXB: rigB.anchorX,
			wfYB: rigB.anchorY,
			wfDxB: layoutTo.wfDx,
			wfDyB: layoutTo.wfDy,
			faceAX: layout.faceAX,
			faceAY: layout.faceAY,
			faceAW: layout.faceAW,
			faceAH: layout.faceAH,
			faceARadius: layout.faceARadius,
			faceARepeat: layout.faceARepeat,
			faceAGap: layout.faceAGap,
			faceAVis: layout.faceAVis,
			faceBX: layout.faceBX,
			faceBY: layout.faceBY,
			faceBW: layout.faceBW,
			faceBH: layout.faceBH,
			faceBRadius: layout.faceBRadius,
			faceABezel: layout.faceABezel,
			faceBBezel: layout.faceBBezel,
			faceBVis: layout.faceBVis,
			scanDensity: display.scanDensity,
			scanStrength: display.scanStrength * (0.5 + scanAxis),
			curvature: display.curvature * (0.6 + gene('curvature') * 0.8),
			grain: display.grain * (0.6 + gene('grain') * 0.8) + voice.grain * 0.03,
			bloomGain: display.bloom,
			aberration: display.aberration,
			vignette: display.vignette,
			glass: display.glass,
			fadeLong: 1 - feedbackFade,
			fadeShort: 1 - floorFade,
			afterglow: 0.2,
			gridLevel: 0.75 + gene('grid') * 0.5,
			reflectY: layout.reflectY,
			reflect: layout.reflect,
			seamY: layout.seamY,
			seam: layout.seam,
			gridDensity: gene('grid'),
			sectionProgress: directed.context.sectionProgress,
			figurePhase,
			tempo: journey.tempo,
			fracture: voice.fracture,
			sharpness: voice.sharpness,
			fracturePhase,
			halation: voice.halation,
			// Worn and raster tubes have rounder faces; the glass reflects in
			// step with how much glass the display shows.
			tubeRadius: 0.05 + display.curvature * 0.7,
			glassReflect: 0.35 + display.glass * 0.9,
			// The room is lit by the instrument, but softly: a strong spill would
			// carry any one part's flash across the whole glass.
			roomSpill: 0.7,
			glassGhost: 0.03 + display.glass * 0.09,
			figALen: figureEngine.meanLength[0],
			figBLen: figureEngine.meanLength[1],
			figAEnergy: sizeEnergy(figureEngine.meanLength[0], figAScale),
			figBEnergy: sizeEnergy(figureEngine.meanLength[1], figBScale),
			depositLong,
			depositShort,
			spotSigma: 0.8,
			// Punchy music focuses the spot hard; soft music blooms it.
			focus: 1.2 - voice.sharpness * 0.4,
			beamFirst: beam.first,
			beamSegments: beam.segments,
			beamUp: beam.up,
			beamMix,
			beamGain: heroLight * beamMix * beamReference,
			beamAgc: beam.agc,
			beamTurn,
			beamStep: Math.max(meanStepPx, 0.01),
			traceStart: beam.traceStart,
			traceSpan: beam.traceSpan,
			traceGain: beam.agc,
			// The waveforms are written into the X/Y records at the head (above).
			traceMix: 0,
			glowTight: 0.26,
			glowWide: 0.17,
			reflection: 0.06,
			// Fixed exposure: loudness never brightens the whole face at once.
			exposure: 1.2,
			overexposure: 0.8,
			reflectSpread: 0.05,
			saturation: 1.06,
			extinction: 0.0012 * dt * 60
		};
		packSignalUniforms(state.uniforms, values);

		const queue = state.device.queue;
		queue.writeBuffer(
			state.uniformBuffer,
			0,
			state.uniforms.buffer,
			state.uniforms.byteOffset,
			state.uniforms.byteLength
		);
		queue.writeBuffer(
			state.detailBuffer,
			0,
			renderDetailBins.buffer,
			renderDetailBins.byteOffset,
			renderDetailBins.byteLength
		);
		queue.writeBuffer(
			state.terrainBuffer,
			0,
			terrainRows.buffer,
			terrainRows.byteOffset,
			terrainRows.byteLength
		);
		queue.writeBuffer(
			state.figureBuffer,
			0,
			figurePoints.buffer,
			figurePoints.byteOffset,
			figurePoints.byteLength
		);
		queue.writeBuffer(state.voiceBuffer, 0, band.lanes.buffer, band.lanes.byteOffset, band.lanes.byteLength);
		queue.writeBuffer(
			state.scopeBuffer,
			0,
			scopeBeam.window.buffer,
			scopeBeam.window.byteOffset,
			scopeBeam.window.byteLength
		);

		const now = performance.now();
		if (now - lastHudUpdateAt >= 250) {
			lastHudUpdateAt = now;
			hudSection = directed.section;
			hudTempo = directed.clock.tempoBpm;
			hudContext = directed.context.source;
			hudChannels = Math.round(journey.channels);
			hudLayout = signalBenchName(layoutChoice.to);
			hudFamily = SIGNAL_FAMILY_NAMES[familyChoice.to];
			hudPalette = SIGNAL_PALETTES[paletteChoice.to].name;
			hudScene = genome.scene;
			hudFrameMs = Math.round(frameCpuMs * 100) / 100;
			hudBeam = Math.round(beamMix * 100) / 100;
			hudStereo = Math.round(beam.interest * 100) / 100;
		}

		const encoder = state.device.createCommandEncoder({ label: 'Signal frame' });
		{
			const pass = encoder.beginRenderPass({
				label: 'Signal beams',
				...(timer ? { timestampWrites: { querySet: timer.querySet, beginningOfPassWriteIndex: 0 } } : {}),
				colorAttachments: [
					{
						view: targets.sceneView,
						// Alpha carries the phosphor class; empty space claims none.
						clearValue: { r: 0, g: 0, b: 0, a: 0 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				]
			});
			pass.setPipeline(state.scenePipeline);
			pass.setBindGroup(0, state.sceneBindGroup);
			pass.draw(SIGNAL_VERTEX_COUNT, SIGNAL_TRACE_INSTANCES);
			// The real XY beam, in the same light (figure B's screen when dual).
			if (beamMix > 0.001 && beam.segments > 0) {
				pass.setPipeline(state.beamPipeline);
				pass.setBindGroup(0, state.beamBindGroup);
				pass.draw(beam.segments * 6, screen > 0.01 ? 2 : 1);
			}
			pass.end();
		}
		const previous = state.parity;
		const next: 0 | 1 = previous === 0 ? 1 : 0;
		const fullscreen = (
			label: string,
			view: GPUTextureView,
			pipeline: GPURenderPipeline,
			bindGroup: GPUBindGroup,
			last = false
		) => {
			const pass = encoder.beginRenderPass({
				label,
				...(timer && last ? { timestampWrites: { querySet: timer.querySet, endOfPassWriteIndex: 1 } } : {}),
				colorAttachments: [
					{ view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }
				]
			});
			pass.setPipeline(pipeline);
			pass.setBindGroup(0, bindGroup);
			pass.draw(3);
			pass.end();
		};
		fullscreen('Signal phosphor', targets.feedbackViews[next], state.feedbackPipeline, post.feedback[previous]);
		fullscreen('Signal glow prefilter', targets.tightViews[0], state.glowDownPipeline, post.glowDown[next]);
		fullscreen('Signal tight glow H', targets.tightViews[1], state.tightHPipeline, post.tightH);
		fullscreen('Signal tight glow V', targets.tightViews[0], state.tightVPipeline, post.tightV);
		fullscreen('Signal wide prefilter', targets.wideViews[0], state.wideDownPipeline, post.wideDown);
		fullscreen('Signal wide glow H', targets.wideViews[1], state.wideHPipeline, post.wideH);
		fullscreen('Signal wide glow V', targets.wideViews[0], state.wideVPipeline, post.wideV);
		fullscreen(
			'Signal present',
			state.context.getCurrentTexture().createView(),
			state.compositePipeline,
			post.composite[next],
			true
		);
		state.parity = next;
		const frameTimer = timer && !gpuPending ? timer : null;
		if (frameTimer) {
			encoder.resolveQuerySet(frameTimer.querySet, 0, 2, frameTimer.resolve, 0);
			encoder.copyBufferToBuffer(frameTimer.resolve, 0, frameTimer.readback, 0, 16);
		}
		queue.submit([encoder.finish()]);
		const recordGpu = (ms: number) => {
			gpuPending = false;
			if (Number.isFinite(ms) && ms >= 0 && ms < 1000) {
				gpuMs += (ms - gpuMs) * 0.1;
				hudGpuMs = Math.round(gpuMs * 100) / 100;
			}
		};
		if (frameTimer) {
			gpuPending = true;
			void frameTimer.readback
				.mapAsync(GPUMapMode.READ)
				.then(() => {
					const stamps = new BigInt64Array(frameTimer.readback.getMappedRange().slice(0));
					frameTimer.readback.unmap();
					recordGpu(Number(stamps[1] - stamps[0]) / 1e6);
				})
				.catch(() => (gpuPending = false));
		} else if (gpuTiming && !gpuPending) {
			gpuPending = true;
			const submittedAt = performance.now();
			void queue.onSubmittedWorkDone().then(() => recordGpu(performance.now() - submittedAt));
		}
	}

	function loop(now: number) {
		if (!running) return;
		raf = requestAnimationFrame(loop);
		if (!canvas || !gpu) return;
		if (!schedulerTickAt) {
			schedulerTickAt = now;
		} else {
			const elapsed = Math.max(0, now - schedulerTickAt);
			schedulerTickAt = now;
			observeDisplayCadence(elapsed);
		}
		// Whole-vsync frame stride: 60 fps on 120/144 Hz panels without the
		// uneven 2/3-vsync cadence a fractional accumulator produces.
		const nextFrameStride = displayFrameStride(refreshIntervalMs, TARGET_FRAME_RATE);
		if (nextFrameStride !== activeFrameStride) {
			activeFrameStride = nextFrameStride;
			framesUntilRender = 0;
		}
		if (framesUntilRender > 0) {
			framesUntilRender -= 1;
			return;
		}
		framesUntilRender = activeFrameStride - 1;
		const elapsedMs = lastRenderedAt ? now - lastRenderedAt : refreshIntervalMs * activeFrameStride;
		lastRenderedAt = now;
		try {
			const cpuStart = performance.now();
			renderFrame(gpu, clamp(elapsedMs / 1000, 0.001, 0.25));
			frameCpuMs += (performance.now() - cpuStart - frameCpuMs) * 0.05;
		} catch (error) {
			errorMsg = error instanceof Error ? error.message : String(error);
			teardownGpu();
		}
	}

	$effect(() => {
		const targetCanvas = canvas;
		if (!targetCanvas) {
			initVersion += 1;
			initializing = false;
			teardownGpu();
			return;
		}
		if (gpu || initializing) return;
		const version = ++initVersion;
		initializing = true;
		errorMsg = null;
		ready = false;
		initGpu(targetCanvas)
			.then((state) => {
				if (version !== initVersion || canvas !== targetCanvas) {
					destroyGpuState(state);
					return;
				}
				gpu = state;
				startTime = performance.now();
				schedulerTickAt = 0;
				refreshIntervalMs = 1000 / 60;
				activeFrameStride = 1;
				framesUntilRender = 0;
				lastRenderedAt = 0;
				rendererSourceEpoch = -1;
				ready = true;
			})
			.catch((error) => {
				if (version !== initVersion) return;
				errorMsg = error instanceof Error ? error.message : String(error);
				ready = false;
			})
			.finally(() => {
				if (version === initVersion) initializing = false;
			});
	});

	onMount(async () => {
		running = true;
		startTime = performance.now();
		const search = new URLSearchParams(location.search);
		lookOverride = parseSignalLookOverride(search.get('signalLook'));
		// Lab: pin roam axes for inspection (?signalRoam=pan:1,lift:-1,cam1:0.5).
		roamPin = {};
		for (const part of (search.get('signalRoam') ?? '').split(',')) {
			const [name, raw] = part.split(/[:=]/);
			const value = Number(raw);
			if (name && Number.isFinite(value)) roamPin[name.trim()] = Math.max(-1.3, Math.min(1.3, value));
		}
		gpuTiming = search.get('signalGpuTiming') === '1';
		if (search.get('signalLite') === '1') {
			internalScale = LITE_INTERNAL_SCALE;
			scopeBeam = new SignalScopeBeam(LITE_UPSAMPLE);
		}
		variation?.setOverride(lookOverride);
		unsubscribe = await vis.subscribe();
		if (!running) {
			unsubscribe();
			unsubscribe = null;
			return;
		}
		raf = requestAnimationFrame(loop);
	});

	onDestroy(() => {
		rememberRenderer();
		running = false;
		initVersion += 1;
		cancelAnimationFrame(raf);
		unsubscribe?.();
		unsubscribe = null;
		teardownGpu();
	});
</script>

{#if vis.active}
	<div class="fixed inset-0 z-[100] overflow-hidden bg-black">
		<canvas
			bind:this={canvas}
			class="h-full w-full"
			aria-label="Signal audio visualizer"
			data-signal-section={hudSection}
			data-signal-context={hudContext}
			data-signal-tempo={Math.round(hudTempo)}
			data-signal-channels={hudChannels}
			data-signal-layout={hudLayout}
			data-signal-family={hudFamily}
			data-signal-palette={hudPalette}
			data-signal-scene={hudScene}
			data-signal-frame-ms={hudFrameMs}
			data-signal-gpu-ms={gpuTiming ? hudGpuMs : undefined}
			data-signal-beam={hudBeam}
			data-signal-stereo={hudStereo}
			data-signal-render-passes={SIGNAL_RENDER_PASSES}
			data-signal-uniform-bytes={SIGNAL_UNIFORM_BYTES}
			data-signal-frame-stride={activeFrameStride}
			data-signal-refresh-rate={measuredRefreshRate}
			data-signal-internal-pixels={internalPixels}
			data-signal-ready={String(ready)}
		></canvas>

		{#if !ready && !errorMsg}
			<div
				class="pointer-events-none absolute inset-0 grid place-items-center font-mono text-[11px] uppercase tracking-[0.2em] text-emerald-100/40"
			>
				warming phosphor
			</div>
		{/if}

		{#if errorMsg}
			<div
				class="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-[#010508] px-6"
				role="alert"
			>
				<div class="max-w-md text-center">
					<p class="font-mono text-xs uppercase tracking-[0.18em] text-orange-200/80">
						Signal unavailable
					</p>
					<p class="mt-3 text-sm leading-6 text-white/55">{errorMsg}</p>
				</div>
			</div>
		{/if}
	</div>
{/if}
