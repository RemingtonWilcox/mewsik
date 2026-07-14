<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { ChevronLeft, ChevronRight, EyeOff, X } from '@lucide/svelte';
	import VisualizerMk1 from './visualizer.svelte';
	import VisualizerMk2 from './visualizer-mk2.svelte';
	import VisualizerSignal from './visualizer-signal.svelte';
	import {
		PRESET_NAMES,
		VISUALIZER_CATALOG,
		VISUALIZER_RESPONSE_LABELS,
		VISUALIZER_RESPONSES,
		adjacentVisualizer,
		useVisualizer,
		type VisualizerJourneySnapshot,
		type VisualizerResponse
	} from '$lib/state/visualizer.svelte';
	import { useVisualizerChrome } from '$lib/state/visualizer-chrome.svelte';

	const vis = useVisualizer();
	const visualizerChrome = useVisualizerChrome();

	let engineHydrated = $state(false);
	let detailsOpen = $state(false);
	let keyboardFocusMode = true;
	let hudSection = $state('intro');
	let hudForm = $state('seed');
	let hudTempo = $state(0);
	let hudContext = $state<'live' | 'score'>('live');
	let telemetryTimer: ReturnType<typeof setInterval> | null = null;
	let wasActive = false;
	let hostElement = $state<HTMLDivElement | null>(null);
	let chromeElement = $state<HTMLDivElement | null>(null);
	let visualizerOpener: HTMLElement | null = null;

	let identity = $derived(VISUALIZER_CATALOG[vis.engine]);
	let previousEngine = $derived(adjacentVisualizer(vis.engine, -1));
	let nextEngine = $derived(adjacentVisualizer(vis.engine, 1));

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

	function refreshTelemetry() {
		if (!vis.active) return;
		const journey = vis.getJourney();
		hudSection = journey.director.section;
		hudForm = dominantLifecycleForm(journey.mk2);
		hudTempo = journey.director.clock.tempoBpm;
		hudContext = journey.director.context.source;
	}

	function hideControls() {
		detailsOpen = false;
		visualizerChrome.setHold('details', false);
		visualizerChrome.lockHidden();
		queueMicrotask(() => hostElement?.focus({ preventScroll: true }));
	}

	function handleChromeFocusIn() {
		visualizerChrome.wake();
		visualizerChrome.setHold('engine-focus', keyboardFocusMode);
	}

	function handleChromeFocusOut(event: FocusEvent) {
		const chrome = event.currentTarget;
		if (
			chrome instanceof HTMLElement &&
			event.relatedTarget instanceof Node &&
			chrome.contains(event.relatedTarget)
		) return;
		visualizerChrome.setHold('engine-focus', false);
	}

	function handleChromePointerDown() {
		// Pointer clicks may leave focus on a rail button, but should not pin the
		// chrome forever. The next real keyboard event restores focus-hold mode.
		keyboardFocusMode = false;
		visualizerChrome.setHold('engine-focus', false);
	}

	function toggleStageControls() {
		if (detailsOpen) {
			detailsOpen = false;
			visualizerChrome.setHold('details', false);
			visualizerChrome.wake();
			return;
		}
		if (visualizerChrome.visible) hideControls();
		else visualizerChrome.revealExplicitly();
	}

	function toggleDetails() {
		if (detailsOpen) {
			detailsOpen = false;
			visualizerChrome.setHold('details', false);
			visualizerChrome.wake();
			return;
		}
		visualizerChrome.revealExplicitly();
		detailsOpen = true;
		visualizerChrome.setHold('details', true);
	}

	function cycleEngine(direction: 1 | -1) {
		vis.setEngine(adjacentVisualizer(vis.engine, direction));
		refreshTelemetry();
		visualizerChrome.wake();
	}

	function setResponse(response: VisualizerResponse) {
		vis.setResponse(response);
		visualizerChrome.wake();
	}

	function isInteractiveEvent(event: KeyboardEvent): boolean {
		return event.composedPath().some((node) => {
			if (!(node instanceof HTMLElement)) return false;
			return node.matches(
				'input, textarea, select, [contenteditable="true"], [role="slider"], [role="textbox"]'
			);
		});
	}

	function handleKeydown(event: KeyboardEvent) {
		if (!vis.active) return;
		keyboardFocusMode = true;
		if (document.activeElement instanceof Node && chromeElement?.contains(document.activeElement)) {
			visualizerChrome.setHold('engine-focus', true);
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			vis.close();
			return;
		}
		if (isInteractiveEvent(event)) return;
		if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat) return;

		if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
			event.preventDefault();
			cycleEngine(event.key === 'ArrowRight' ? 1 : -1);
			return;
		}
		if (event.key.toLowerCase() === 'h') {
			event.preventDefault();
			if (visualizerChrome.visible) hideControls();
			else visualizerChrome.revealExplicitly();
			return;
		}
		if (event.key.toLowerCase() === 'i') {
			event.preventDefault();
			toggleDetails();
		}
	}

	onMount(() => {
		vis.hydrateEngine();
		engineHydrated = true;
		refreshTelemetry();
		telemetryTimer = setInterval(refreshTelemetry, 250);
	});

	$effect(() => {
		const active = vis.active;
		if (active && !wasActive) {
			visualizerOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			detailsOpen = false;
			keyboardFocusMode = true;
			visualizerChrome.activate();
			queueMicrotask(() => {
				hostElement?.focus({ preventScroll: true });
			});
		} else if (!active) {
			visualizerChrome.deactivate();
			if (wasActive && visualizerOpener?.isConnected) {
				const opener = visualizerOpener;
				queueMicrotask(() => opener.focus({ preventScroll: true }));
			}
			visualizerOpener = null;
		}
		wasActive = active;
	});

	onDestroy(() => {
		visualizerChrome.deactivate();
		if (telemetryTimer) clearInterval(telemetryTimer);
	});
</script>

<svelte:window
	onkeydown={handleKeydown}
	onblur={() => visualizerChrome.blur()}
/>

{#if vis.active && engineHydrated}
	<div
		bind:this={hostElement}
		class="outline-none"
		tabindex="-1"
		role="region"
		aria-label={`${identity.name} visualizer overlay`}
		data-visualizer-host
		data-render-engine={vis.engine}
		data-engine-name={identity.name}
		data-visualizer-response={vis.response}
		data-controls-visible={visualizerChrome.visible}
		data-controls-mode={visualizerChrome.mode}
	>
		{#if vis.engine === 'mk1'}
			<VisualizerMk1 />
		{:else if vis.engine === 'mk2'}
			<VisualizerMk2 />
		{:else}
			<VisualizerSignal />
		{/if}

		<button
			type="button"
			class="fixed inset-0 z-[104] cursor-default border-0 bg-transparent p-0"
			aria-label={detailsOpen
				? 'Close visualizer details'
				: visualizerChrome.visible
					? 'Hide visualizer controls'
					: 'Show visualizer controls'}
			onpointermove={(event) => {
				if (event.pointerType !== 'touch') visualizerChrome.wake();
			}}
			onclick={toggleStageControls}
		></button>

		<div
			bind:this={chromeElement}
			class={`pointer-events-none fixed inset-x-3 z-[106] mx-auto flex max-w-[26rem] flex-col items-center transition-opacity duration-[250ms] sm:inset-x-6 ${visualizerChrome.visible ? 'opacity-100' : 'opacity-0'}`}
			style="top: max(0.75rem, env(safe-area-inset-top));"
			role="group"
			aria-label="Visualizer controls"
			aria-hidden={!visualizerChrome.visible}
			inert={!visualizerChrome.visible}
			onpointerenter={() => visualizerChrome.setHold('engine-pointer', true)}
			onpointerleave={() => visualizerChrome.setHold('engine-pointer', false)}
			onpointerdown={handleChromePointerDown}
			onfocusin={handleChromeFocusIn}
			onfocusout={handleChromeFocusOut}
		>
			<nav
				class={`relative flex h-10 w-full items-center overflow-hidden rounded-xl border border-white/15 bg-black/65 shadow-2xl shadow-black/30 backdrop-blur-xl ${visualizerChrome.visible ? 'pointer-events-auto' : 'pointer-events-none'}`}
				aria-label="Visualizer engines"
			>
				<div
					class="pointer-events-none absolute inset-x-0 top-0 h-px"
					style={`background: linear-gradient(90deg, transparent, ${identity.accentMuted}, ${identity.accent}, ${identity.accentMuted}, transparent);`}
				></div>
				<button
					type="button"
					class="grid h-10 w-10 shrink-0 place-items-center text-white/65 transition hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-white"
					aria-label={`Previous visualizer: ${VISUALIZER_CATALOG[previousEngine].name}`}
					onclick={() => cycleEngine(-1)}
				>
					<ChevronLeft size={17} strokeWidth={1.7} />
				</button>

				<button
					type="button"
					class="flex min-w-0 flex-1 items-baseline gap-2 self-stretch border-x border-white/10 px-3 text-left transition hover:bg-white/[0.06] focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-white"
					aria-label={`${identity.name}: ${identity.subtitle}. ${detailsOpen ? 'Hide' : 'Show'} details`}
					aria-expanded={detailsOpen}
					aria-controls="visualizer-details"
					onclick={toggleDetails}
				>
					<span class="self-center truncate text-xs font-medium tracking-[0.1em] text-white">
						{identity.name.toUpperCase()}
					</span>
					<span class="self-center truncate font-mono text-[9px] uppercase tracking-[0.13em] text-white/35">
						{identity.subtitle}
					</span>
				</button>

				<button
					type="button"
					class="grid h-10 w-10 shrink-0 place-items-center text-white/65 transition hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-white"
					aria-label={`Next visualizer: ${VISUALIZER_CATALOG[nextEngine].name}`}
					onclick={() => cycleEngine(1)}
				>
					<ChevronRight size={17} strokeWidth={1.7} />
				</button>

				<div class="h-4 w-px bg-white/10"></div>
				<button
					type="button"
					class="grid h-10 w-9 shrink-0 place-items-center text-white/50 transition hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-white"
					aria-label="Hide visualizer controls"
					onclick={hideControls}
				>
					<EyeOff size={15} strokeWidth={1.7} />
				</button>
				<button
					type="button"
					class="grid h-10 w-10 shrink-0 place-items-center text-white/50 transition hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-white"
					aria-label="Close visualizer"
					onclick={() => vis.close()}
				>
					<X size={16} strokeWidth={1.7} />
				</button>
			</nav>

			{#if detailsOpen}
				<section
					id="visualizer-details"
					aria-label={`${identity.name} visualizer details`}
					class="pointer-events-auto mt-2 w-full rounded-xl border border-white/15 bg-black/70 p-4 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-5"
				>
					<div class="flex items-start justify-between gap-5">
						<div>
							<p class="font-mono text-[10px] uppercase tracking-[0.2em]" style={`color: ${identity.accent};`}>
								{identity.name} / {identity.role}
							</p>
							<p class="mt-1 text-sm text-white/55">{identity.description}</p>
						</div>
					</div>

					<div class="mt-4 flex flex-wrap gap-x-3 gap-y-1 border-y border-white/10 py-3 font-mono text-[10px] uppercase tracking-[0.15em] text-white/45">
						<span class="text-white/70">{hudSection}</span>
						<span aria-hidden="true">·</span>
						<span>{hudTempo > 30 ? `${Math.round(hudTempo)} bpm` : 'tempo seeking'}</span>
						<span aria-hidden="true">·</span>
						{#if vis.engine === 'mk1'}
							<span>{PRESET_NAMES[vis.preset] ?? 'kaleidoscope'}</span>
						{:else if vis.engine === 'mk2'}
							<span>{hudForm}</span>
						{:else}
							<span>{hudContext}</span>
						{/if}
					</div>

					<div class="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
						<p class="font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">Response</p>
						<div class="grid grid-cols-3 overflow-hidden rounded-lg border border-white/15" role="group" aria-label="Visualizer response">
							{#each VISUALIZER_RESPONSES as response}
								<button
									type="button"
									class={`min-h-10 border-l border-white/10 px-4 font-mono text-[10px] uppercase tracking-[0.15em] transition first:border-l-0 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-white ${vis.response === response ? 'bg-white text-black' : 'text-white/55'}`}
									aria-pressed={vis.response === response}
									onclick={() => setResponse(response)}
								>
									{VISUALIZER_RESPONSE_LABELS[response]}
								</button>
							{/each}
						</div>
					</div>

					<p class="mt-4 hidden font-mono text-[10px] uppercase tracking-[0.13em] text-white/30 sm:block">
						← → change visual · I details · H hide controls · Esc close
					</p>
				</section>
			{/if}
		</div>

		<p class="sr-only" aria-live="polite">{identity.name} visualizer selected.</p>
	</div>
{/if}
