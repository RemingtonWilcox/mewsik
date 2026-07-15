<script lang="ts">
	// Browser visualizer lab. Run `pnpm dev`, open /visualizer-test, then use
	// deterministic music profiles, a local audio file, or a CORS-enabled URL.
	import { onDestroy, onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import VisualizerMk1 from '$lib/components/visualizer/visualizer.svelte';
	import VisualizerMk2 from '$lib/components/visualizer/visualizer-mk2.svelte';
	import VisualizerSignal from '$lib/components/visualizer/visualizer-signal.svelte';
	import VisualizerLoom from '$lib/components/visualizer/visualizer-loom.svelte';
	import {
		PRESET_NAMES,
		VISUALIZER_CATALOG,
		VISUALIZER_ENGINES,
		VISUALIZER_RESPONSE_LABELS,
		VISUALIZER_RESPONSES,
		useVisualizer,
		type AudioFeatures,
		type VisualizerEngine
	} from '$lib/state/visualizer.svelte';
	import { WebAnalyzer } from '$lib/audio/web-analyzer';
	import { setActiveScore, setScorePlayback } from '$lib/visualizer/director/score';
	import {
		SOMA_LAB_PROFILE_IDS,
		SOMA_LAB_PROFILES,
		getSomaLabProfile,
		getSomaLabStage,
		isSomaLabProfileId,
		type SomaLabProfileId
	} from '$lib/visualizer/lab/music-profiles';

	type LabSnapshot = {
		profile: SomaLabProfileId;
		stage: string;
		seed: string;
		engine: VisualizerEngine;
		positionMs: number;
		latest: AudioFeatures | null;
		journey: ReturnType<typeof vis.getJourney>;
	};

	type MewsikLabApi = {
		select(profile: string, stage?: string, seed?: string): boolean;
		settle(frames?: number): Promise<LabSnapshot>;
		snapshot(): LabSnapshot;
	};

	type LabWindow = Window & { __MEWSIK_LAB__?: MewsikLabApi };

	const vis = useVisualizer();
	const SILENT_BINS = Array.from({ length: 64 }, () => 0);
	const DEFAULT_SEED = 'soma-qa';

	let audioEl = $state<HTMLAudioElement | null>(null);
	let audioCtx: AudioContext | null = null;
	let analyzer: WebAnalyzer | null = null;
	let setupDone = false;
	let raf = 0;
	let lastObjectUrl: string | null = null;
	let urlInput = $state('');
	let engine = $state<VisualizerEngine>('mk1');
	let demoMode = $state(true);
	let manualPreset = $state(-1);
	let labReady = $state(false);
	let labProfileReady = $state(false);
	let chromeVisible = $state(true);
	let activeProfileId = $state<SomaLabProfileId>('club128');
	let activeStageId = $state(SOMA_LAB_PROFILES.club128.defaultStage);
	let labSeed = $state(DEFAULT_SEED);
	let activeProfile = $derived(SOMA_LAB_PROFILES[activeProfileId]);
	let activeStage = $derived(getSomaLabStage(activeProfile, activeStageId));
	let profileStartedAt = 0;
	let activePositionMs = 0;
	let profileFrameSerial = 0;
	let installedLabApi: MewsikLabApi | null = null;
	let settleWaiters: Array<{
		target: number;
		resolve: (snapshot: LabSnapshot) => void;
	}> = [];

	function ensureSetup(): boolean {
		if (setupDone || !audioEl) return setupDone;
		audioCtx = new AudioContext();
		const source = audioCtx.createMediaElementSource(audioEl);
		analyzer = new WebAnalyzer(audioCtx, source);
		// The analyser receives the media source; route its output to speakers.
		analyzer['analyser'].connect(audioCtx.destination);
		setupDone = true;
		return true;
	}

	function normalizeSeed(value: string | null | undefined): string {
		return value?.trim().slice(0, 80) || DEFAULT_SEED;
	}

	function updateUrl() {
		if (typeof location === 'undefined') return;
		const url = new URL(location.href);
		url.searchParams.set('engine', engine);
		url.searchParams.set('profile', activeProfileId);
		url.searchParams.set('stage', activeStageId);
		url.searchParams.set('seed', labSeed);
		url.searchParams.set('chrome', chromeVisible ? '1' : '0');
		replaceState(url, {});
	}

	function makeLabSnapshot(): LabSnapshot {
		const latest = vis.latest;
		return {
			profile: activeProfileId,
			stage: activeStageId,
			seed: labSeed,
			engine,
			positionMs: activePositionMs,
			latest: latest ? { ...latest, bins: [...latest.bins] } : null,
			journey: structuredClone(vis.getJourney())
		};
	}

	function flushSettleWaiters() {
		if (settleWaiters.length === 0) return;
		const pending: typeof settleWaiters = [];
		for (const waiter of settleWaiters) {
			if (profileFrameSerial >= waiter.target) waiter.resolve(makeLabSnapshot());
			else pending.push(waiter);
		}
		settleWaiters = pending;
	}

	function settleProfile(frames = 30): Promise<LabSnapshot> {
		const safeFrames = Math.max(0, Math.min(600, Math.floor(Number.isFinite(frames) ? frames : 30)));
		if (safeFrames === 0) return Promise.resolve(makeLabSnapshot());
		return new Promise((resolve) => {
			settleWaiters.push({ target: profileFrameSerial + safeFrames, resolve });
		});
	}

	function applyProfileSelection(
		profileId: SomaLabProfileId,
		stageId: string | undefined,
		seed: string,
		syncUrl = true
	) {
		const profile = SOMA_LAB_PROFILES[profileId];
		const stage = getSomaLabStage(profile, stageId);
		activeProfileId = profile.id;
		activeStageId = stage.id;
		labSeed = normalizeSeed(seed);
		demoMode = true;
		labProfileReady = false;
		activePositionMs = stage.atMs;
		profileStartedAt = performance.now();
		setActiveScore(profile.score);
		setScorePlayback(activePositionMs, false);
		// Reset through null so selecting the same URL state is a real replay while
		// the final identity—and therefore the visual seed—stays deterministic.
		vis.resetPerformance(null, profileStartedAt);
		vis.resetPerformance(`visualizer-lab:${profile.id}:${labSeed}`, profileStartedAt);
		if (syncUrl) updateUrl();
	}

	function selectFromLabApi(profileValue: string, stage?: string, seed?: string): boolean {
		if (!isSomaLabProfileId(profileValue)) return false;
		const profile = SOMA_LAB_PROFILES[profileValue];
		if (stage && !profile.stages.some((candidate) => candidate.id === stage)) return false;
		applyProfileSelection(profileValue, stage, seed ?? labSeed);
		return true;
	}

	function publishProfileFrame(now: number) {
		const elapsedMs = Math.max(0, now - profileStartedAt);
		activePositionMs = Math.min(activeStage.endMs - 1, activeStage.atMs + elapsedMs);
		setScorePlayback(activePositionMs, false);
		vis.setLatest(activeProfile.frameAt(activePositionMs, labSeed), now);
		profileFrameSerial += 1;
		if (!labProfileReady) labProfileReady = true;
		flushSettleWaiters();
	}

	function silenceFeatures(): NonNullable<typeof vis.latest> {
		return {
			bins: SILENT_BINS,
			rms: 0,
			peak: 0,
			centroid: 0,
			onset: false,
			bass: 0,
			mid: 0,
			treble: 0,
			sample_rate: 44100,
			bpm: 0,
			beat_phase: 0,
			chroma_key: 0,
			chroma_strength: 0
		};
	}

	function tick() {
		const now = performance.now();
		if (demoMode) {
			publishProfileFrame(now);
		} else if (analyzer) {
			const features = analyzer.tick();
			if (features) vis.setLatest(features);
		} else {
			vis.setLatest(silenceFeatures());
		}

		if (vis.forcedPreset !== manualPreset) vis.forcedPreset = manualPreset;
		if (vis.engine !== engine) vis.setEngine(engine);

		raf = requestAnimationFrame(tick);
	}

	function setEngine(next: VisualizerEngine, syncUrl = true) {
		engine = next;
		vis.setEngine(next);
		if (syncUrl) updateUrl();
	}

	function setSyntheticMode(enabled: boolean) {
		if (enabled) {
			applyProfileSelection(activeProfileId, activeStageId, labSeed);
			return;
		}
		demoMode = false;
		labProfileReady = false;
		setActiveScore(null);
		vis.resetPerformance(null);
	}

	function setChromeVisible(next: boolean) {
		chromeVisible = next;
		updateUrl();
	}

	function onFile(event: Event) {
		const file = (event.target as HTMLInputElement).files?.[0];
		if (!file || !audioEl) return;
		if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
		lastObjectUrl = URL.createObjectURL(file);
		audioEl.src = lastObjectUrl;
		setSyntheticMode(false);
		vis.resetPerformance(`visualizer-lab:file:${file.name}:${file.size}`);
		ensureSetup();
		audioCtx?.resume().catch(() => {});
		audioEl.play().catch(() => {});
	}

	function loadUrl() {
		const url = urlInput.trim();
		if (!audioEl || !url) return;
		audioEl.crossOrigin = 'anonymous';
		audioEl.src = url;
		setSyntheticMode(false);
		vis.resetPerformance(`visualizer-lab:url:${url}`);
		ensureSetup();
		audioCtx?.resume().catch(() => {});
		audioEl.play().catch(() => {});
	}

	onMount(() => {
		// Restore persistence before mounting an engine so the lab does not briefly
		// create Mk1 and race the shared native feature subscription.
		vis.hydrateEngine();
		const params = new URLSearchParams(location.search);
		const requestedEngine = params.get('engine');
		engine = VISUALIZER_ENGINES.includes(requestedEngine as VisualizerEngine)
			? (requestedEngine as VisualizerEngine)
			: vis.engine;
		chromeVisible = params.get('chrome') !== '0';
		const requestedProfile = getSomaLabProfile(params.get('profile'));
		labSeed = normalizeSeed(params.get('seed'));
		vis.active = true;
		labReady = true;
		setEngine(engine, false);
		applyProfileSelection(requestedProfile.id, params.get('stage') ?? undefined, labSeed, false);
		installedLabApi = {
			select: selectFromLabApi,
			settle: settleProfile,
			snapshot: makeLabSnapshot
		};
		(window as LabWindow).__MEWSIK_LAB__ = installedLabApi;
		raf = requestAnimationFrame(tick);
	});

	onDestroy(() => {
		const finalSnapshot = labReady ? makeLabSnapshot() : null;
		if (finalSnapshot) {
			for (const waiter of settleWaiters) waiter.resolve(finalSnapshot);
		}
		settleWaiters = [];
		const labWindow = window as LabWindow;
		if (labWindow.__MEWSIK_LAB__ === installedLabApi) delete labWindow.__MEWSIK_LAB__;
		installedLabApi = null;
		labReady = false;
		cancelAnimationFrame(raf);
		vis.active = false;
		vis.forcedPreset = -1;
		setActiveScore(null);
		vis.clearLatest();
		if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
		audioCtx?.close().catch(() => {});
	});
</script>

<svelte:window
	onkeydown={(event) => {
		const target = event.target as HTMLElement;
		if (
			target.tagName === 'INPUT' ||
			target.tagName === 'TEXTAREA' ||
			target.tagName === 'SELECT' ||
			target.isContentEditable
		)
			return;
		if (event.key === '0') manualPreset = -1;
		else if (event.key >= '1' && event.key <= '4') manualPreset = Number(event.key) - 1;
		else if (event.key.toLowerCase() === 'q') setEngine('mk1');
		else if (event.key.toLowerCase() === 'w') setEngine('mk2');
		else if (event.key.toLowerCase() === 'e') setEngine('signal');
		else if (event.key.toLowerCase() === 'r') setEngine('loom');
		else if (event.key.toLowerCase() === 'c') setChromeVisible(!chromeVisible);
	}}
/>

<div
	class="contents"
	data-visualizer-lab
	data-lab-profile={activeProfileId}
	data-lab-stage={activeStageId}
	data-lab-seed={labSeed}
	data-lab-ready={labReady && (!demoMode || labProfileReady)}
	data-lab-chrome={chromeVisible}
>
	{#if chromeVisible}
		<div
			class="pointer-events-none fixed inset-x-0 top-0 flex flex-col gap-2 p-4 text-xs text-white"
			style="z-index: 300; background: linear-gradient(180deg, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0) 100%);"
		>
			<div class="pointer-events-auto flex flex-wrap items-center gap-3">
				<span class="font-mono text-white/70">visualizer lab</span>
				<div class="flex overflow-hidden rounded border border-white/20">
					<button
						onclick={() => setEngine('mk1')}
						class={`px-3 py-1 ${engine === 'mk1' ? 'bg-white text-black' : 'bg-black/40 hover:bg-white/10'}`}
					>
						{VISUALIZER_CATALOG.mk1.name} · mk1
					</button>
					<button
						onclick={() => setEngine('mk2')}
						class={`border-l border-white/20 px-3 py-1 ${engine === 'mk2' ? 'bg-amber-300 text-black' : 'bg-black/40 text-amber-200 hover:bg-white/10'}`}
					>
						{VISUALIZER_CATALOG.mk2.name} · mk2
					</button>
					<button
						onclick={() => setEngine('signal')}
						class={`border-l border-white/20 px-3 py-1 ${engine === 'signal' ? 'bg-white text-black' : 'bg-black/40 hover:bg-white/10'}`}
					>
						{VISUALIZER_CATALOG.signal.name}
					</button>
					<button
						onclick={() => setEngine('loom')}
						class={`border-l border-white/20 px-3 py-1 ${engine === 'loom' ? 'bg-blue-200 text-black' : 'bg-black/40 text-blue-100 hover:bg-white/10'}`}
					>
						{VISUALIZER_CATALOG.loom.name}
					</button>
				</div>
				<div class="flex overflow-hidden rounded border border-white/20">
					{#each VISUALIZER_RESPONSES as response}
						<button
							onclick={() => vis.setResponse(response)}
							class={`border-l border-white/20 px-2 py-1 first:border-l-0 ${vis.response === response ? 'bg-white text-black' : 'bg-black/40 text-white/60 hover:bg-white/10'}`}
						>
							{VISUALIZER_RESPONSE_LABELS[response]}
						</button>
					{/each}
				</div>
				<label class="flex items-center gap-2 rounded border border-white/20 bg-black/40 px-2 py-1">
					<input
						type="checkbox"
						checked={demoMode}
						onchange={(event) => setSyntheticMode((event.currentTarget as HTMLInputElement).checked)}
					/>
					deterministic profile
				</label>
				<button
					onclick={() => setChromeVisible(false)}
					class="rounded border border-white/20 bg-black/40 px-2 py-1 text-white/60 hover:bg-white/10"
				>
					hide chrome · c
				</button>
			</div>

			<div class="pointer-events-auto flex flex-wrap items-center gap-2">
				<label class="flex items-center gap-1 rounded border border-white/20 bg-black/40 pl-2">
					<span class="text-white/45">profile</span>
					<select
						aria-label="Music profile"
						value={activeProfileId}
						disabled={!demoMode}
						onchange={(event) =>
							applyProfileSelection(
								(event.currentTarget as HTMLSelectElement).value as SomaLabProfileId,
								undefined,
								labSeed
							)}
						class="rounded-r bg-black/70 px-2 py-1 outline-none disabled:opacity-40"
					>
						{#each SOMA_LAB_PROFILE_IDS as profileId}
							<option value={profileId}>{SOMA_LAB_PROFILES[profileId].label}</option>
						{/each}
					</select>
				</label>
				<label class="flex items-center gap-1 rounded border border-white/20 bg-black/40 pl-2">
					<span class="text-white/45">stage</span>
					<select
						aria-label="Song stage"
						value={activeStageId}
						disabled={!demoMode}
						onchange={(event) =>
							applyProfileSelection(
								activeProfileId,
								(event.currentTarget as HTMLSelectElement).value,
								labSeed
							)}
						class="rounded-r bg-black/70 px-2 py-1 outline-none disabled:opacity-40"
					>
						{#each activeProfile.stages as stage}
							<option value={stage.id}>{stage.label}</option>
						{/each}
					</select>
				</label>
				<label class="flex items-center gap-1 rounded border border-white/20 bg-black/40 pl-2">
					<span class="text-white/45">seed</span>
					<input
						aria-label="Profile seed"
						value={labSeed}
						disabled={!demoMode}
						onchange={(event) =>
							applyProfileSelection(
								activeProfileId,
								activeStageId,
								(event.currentTarget as HTMLInputElement).value
							)}
						class="w-28 rounded-r bg-black/70 px-2 py-1 outline-none disabled:opacity-40"
					/>
				</label>
				<input
					type="file"
					accept="audio/*"
					onchange={onFile}
					class="text-xs file:mr-2 file:cursor-pointer file:rounded file:border-0 file:bg-white/10 file:px-2 file:py-1 file:text-white"
				/>
				<input
					type="url"
					bind:value={urlInput}
					placeholder="or paste a CORS-enabled audio URL"
					class="w-64 rounded border border-white/20 bg-black/40 px-2 py-1 placeholder-white/40 outline-none"
				/>
				<button onclick={loadUrl} class="rounded border border-white/20 px-2 py-1 hover:bg-white/10">
					load
				</button>
				<audio bind:this={audioEl} controls class="h-8 w-56 max-w-full"></audio>
			</div>

			<div class="pointer-events-auto flex flex-wrap items-center gap-3 font-mono text-white/80">
				{#if engine === 'mk1'}
					<span>
						<strong>{VISUALIZER_CATALOG.mk1.name} · mk1</strong>
						· {PRESET_NAMES[vis.preset] ?? '?'}
						{#if manualPreset >= 0}<span class="text-amber-300">(forced)</span>{/if}
					</span>
				{:else if engine === 'mk2'}
					<span class="text-amber-200"><strong>{VISUALIZER_CATALOG.mk2.name} · mk2</strong> · living fractal</span>
				{:else if engine === 'signal'}
					<span><strong>{VISUALIZER_CATALOG.signal.name}</strong> · phosphor score</span>
				{:else}
					<span class="text-blue-100"><strong>{VISUALIZER_CATALOG.loom.name}</strong> · harmonic weave</span>
				{/if}
				{#if demoMode}
					<span class="text-emerald-200">{activeProfile.label} · {activeStage.label}</span>
					<span class="max-w-80 truncate text-white/40">{activeProfile.description}</span>
				{/if}
				<span class="text-white/45">keys: q/w/e/r engines · c chrome · 0–4 prism scenes</span>
				<span class="text-white/40">|</span>
				{#if vis.latest}
					<span>bpm {vis.latest.bpm.toFixed(0)}</span>
					<span>rms {vis.latest.rms.toFixed(2)}</span>
					<span>bass {vis.latest.bass.toFixed(2)}</span>
					<span>mid {vis.latest.mid.toFixed(2)}</span>
					<span>high {vis.latest.treble.toFixed(2)}</span>
					<span>key {vis.latest.chroma_key.toFixed(2)}</span>
					<span>tonal {vis.latest.chroma_strength.toFixed(2)}</span>
					{#if vis.latest.onset}<span class="text-emerald-300">onset</span>{/if}
				{/if}
			</div>
		</div>
	{/if}

	{#if labReady}
		{#if engine === 'mk1'}
			<VisualizerMk1 />
		{:else if engine === 'mk2'}
			<VisualizerMk2 />
		{:else if engine === 'signal'}
			<VisualizerSignal />
		{:else}
			<VisualizerLoom />
		{/if}
	{/if}
</div>
