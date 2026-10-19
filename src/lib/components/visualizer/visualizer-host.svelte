<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { EyeOff, X } from '@lucide/svelte';
	import VisualizerMk1 from './visualizer.svelte';
	import VisualizerMandala from './visualizer-mandala.svelte';
	import VisualizerMk2 from './visualizer-mk2.svelte';
	import VisualizerSignal from './visualizer-signal.svelte';
	import VisualizerLoom from './visualizer-loom.svelte';
	import EngineSwitcher from './overlay/engine-switcher.svelte';
	import NowPlaying from './overlay/now-playing.svelte';
	import {
		VISUALIZER_CATALOG,
		adjacentVisualizer,
		useVisualizer,
		type VisualizerEngine
	} from '$lib/state/visualizer.svelte';
	import { useVisualizerChrome } from '$lib/state/visualizer-chrome.svelte';
	import { usePlayer } from '$lib/state/player.svelte';

	// Full-screen visualizer: the picture is the product. Controls (engine
	// choice, now playing, exit) appear on activity and fade on idle. Only the
	// engine component is keyed on state; nothing about the chrome remounts it.

	const SWIPE_MIN_PX = 48;
	const SWIPE_MAX_MS = 700;
	// After a click/tap dismisses the chrome, the pointer must travel this far
	// before movement counts as activity again (click jitter is not intent).
	const WAKE_AFTER_DISMISS_PX = 24;
	const ENGINE_FLASH_MS = 1400;

	const vis = useVisualizer();
	const chrome = useVisualizerChrome();
	const player = usePlayer();

	let engineHydrated = $state(false);
	let hostElement = $state<HTMLDivElement | null>(null);
	let chromeElement = $state<HTMLDivElement | null>(null);
	let opener: HTMLElement | null = null;
	let lastOutsideFocus: HTMLElement | null = null;
	let wasActive = false;

	let identity = $derived(VISUALIZER_CATALOG[vis.engine]);

	// The engine name shown briefly in the middle when it changes while the
	// controls are hidden, so a swipe or arrow press is never a silent change.
	let flashEngine = $state<VisualizerEngine | null>(null);
	let flashTimer: ReturnType<typeof setTimeout> | null = null;

	let swipe: { id: number; x: number; y: number; t: number } | null = null;
	let suppressStageClick = false;
	let dismissedAt: { x: number; y: number } | null = null;

	function selectEngine(engine: VisualizerEngine) {
		if (engine === vis.engine) return;
		const focusWasOnSwitcher =
			document.activeElement instanceof HTMLElement &&
			document.activeElement.matches('[data-engine-option]');
		vis.setEngine(engine);
		chrome.wake();
		if (!chrome.visible) {
			flashEngine = engine;
			if (flashTimer) clearTimeout(flashTimer);
			flashTimer = setTimeout(() => (flashEngine = null), ENGINE_FLASH_MS);
		} else {
			flashEngine = null;
		}
		if (focusWasOnSwitcher) {
			void tick().then(() =>
				chromeElement
					?.querySelector<HTMLElement>(`[data-engine-option="${engine}"]`)
					?.focus({ preventScroll: true })
			);
		}
	}

	function cycleEngine(direction: 1 | -1) {
		selectEngine(adjacentVisualizer(vis.engine, direction));
	}

	function focusables(): HTMLElement[] {
		if (!chromeElement) return [];
		return Array.from(
			chromeElement.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"])')
		);
	}

	/** Keep Tab inside the overlay, and let Tab bring hidden controls back. */
	async function handleTab(event: KeyboardEvent) {
		event.preventDefault();
		if (!chrome.visible) {
			chrome.reveal();
			await tick();
			focusables()[0]?.focus({ preventScroll: true });
			return;
		}
		const items = focusables();
		if (items.length === 0) return;
		const index = items.indexOf(document.activeElement as HTMLElement);
		const next =
			index === -1
				? event.shiftKey
					? items.length - 1
					: 0
				: (index + (event.shiftKey ? -1 : 1) + items.length) % items.length;
		items[next].focus({ preventScroll: true });
	}

	function isTextEntry(event: KeyboardEvent): boolean {
		return event
			.composedPath()
			.some(
				(node) =>
					node instanceof HTMLElement &&
					node.matches('input, textarea, select, [contenteditable="true"], [role="textbox"]')
			);
	}

	function handleWindowFocusIn(event: FocusEvent) {
		if (vis.active || !(event.target instanceof HTMLElement)) return;
		lastOutsideFocus = event.target;
	}

	function handleWindowKeydown(event: KeyboardEvent) {
		if (!vis.active) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			vis.close();
			return;
		}
		if (isTextEntry(event)) return;
		if (event.key === 'Tab') {
			void handleTab(event);
			return;
		}
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
			event.preventDefault();
			if (!event.repeat) cycleEngine(event.key === 'ArrowRight' ? 1 : -1);
			return;
		}
		if (event.key === 'h' || event.key === 'H') {
			event.preventDefault();
			if (!event.repeat) chrome.toggleLock();
			return;
		}
		if (event.key !== 'Shift') chrome.wake();
	}

	// Space on the picture plays/pauses here, and is stopped before the app's
	// window-level shortcut so playback toggles exactly once. Space on a
	// focused control keeps its native meaning (press that control).
	function handleHostKeydown(event: KeyboardEvent) {
		if (event.key !== ' ' || event.target !== hostElement) return;
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		event.preventDefault();
		event.stopPropagation();
		chrome.wake();
		if (!event.repeat) void player.togglePlay();
	}

	function handleStagePointerDown(event: PointerEvent) {
		if (event.pointerType === 'mouse') return;
		swipe = { id: event.pointerId, x: event.clientX, y: event.clientY, t: performance.now() };
	}

	function handleStagePointerUp(event: PointerEvent) {
		const start = swipe;
		swipe = null;
		if (!start || start.id !== event.pointerId) return;
		const dx = event.clientX - start.x;
		const dy = event.clientY - start.y;
		if (
			Math.abs(dx) >= SWIPE_MIN_PX &&
			Math.abs(dx) > Math.abs(dy) * 1.5 &&
			performance.now() - start.t <= SWIPE_MAX_MS
		) {
			suppressStageClick = true;
			cycleEngine(dx < 0 ? 1 : -1);
		}
	}

	function handleStagePointerMove(event: PointerEvent) {
		if (event.pointerType !== 'mouse') return;
		// Reaching the picture proves the pointer has left every control surface;
		// clearing here guards against a missed pointerleave pinning the chrome.
		chrome.setHold('engines-pointer', false);
		chrome.setHold('playback-pointer', false);
		if (dismissedAt) {
			if (Math.hypot(event.clientX - dismissedAt.x, event.clientY - dismissedAt.y) < WAKE_AFTER_DISMISS_PX) {
				return;
			}
			dismissedAt = null;
		}
		chrome.wake();
	}

	function handleStageClick(event: MouseEvent) {
		if (suppressStageClick) {
			suppressStageClick = false;
			return;
		}
		if (chrome.mode === 'locked-hidden' || !chrome.visible) {
			dismissedAt = null;
			chrome.reveal();
			return;
		}
		dismissedAt = { x: event.clientX, y: event.clientY };
		chrome.dismiss();
	}

	function surfacePointer(hold: 'engines-pointer' | 'playback-pointer', held: boolean) {
		return (event: PointerEvent) => {
			if (event.pointerType === 'touch') return;
			chrome.setHold(hold, held);
		};
	}

	function handleChromeFocusIn() {
		chrome.setHold('focus', true);
	}

	function handleChromeFocusOut(event: FocusEvent) {
		if (event.relatedTarget instanceof Node && chromeElement?.contains(event.relatedTarget)) return;
		chrome.setHold('focus', false);
	}

	onMount(() => {
		vis.hydrateEngine();
		engineHydrated = true;
	});

	$effect(() => {
		const active = vis.active;
		if (active && !wasActive) {
			// Opening makes the rest of the app inert, which drops focus to <body>
			// before this runs; the last focus seen outside the overlay is the opener.
			opener = lastOutsideFocus?.isConnected ? lastOutsideFocus : null;
			flashEngine = null;
			dismissedAt = null;
			chrome.activate();
			void tick().then(() => hostElement?.focus({ preventScroll: true }));
		} else if (!active && wasActive) {
			chrome.deactivate();
			const restore = opener;
			opener = null;
			if (restore?.isConnected) void tick().then(() => restore.focus({ preventScroll: true }));
		}
		wasActive = active;
	});

	// Hidden controls are inert; never leave focus stranded on <body>.
	$effect(() => {
		if (chrome.visible || !vis.active || !hostElement) return;
		const focused = document.activeElement;
		if (!focused || focused === document.body || chromeElement?.contains(focused)) {
			hostElement.focus({ preventScroll: true });
		}
	});

	onDestroy(() => {
		chrome.deactivate();
		if (flashTimer) clearTimeout(flashTimer);
	});
</script>

<svelte:window
	onkeydown={handleWindowKeydown}
	onfocusin={handleWindowFocusIn}
	onblur={() => chrome.blur()}
/>

{#if vis.active && engineHydrated}
	<div
		bind:this={hostElement}
		class="outline-none"
		tabindex="-1"
		role="dialog"
		aria-modal="true"
		aria-label={`${identity.name} visualizer`}
		data-visualizer-host
		data-render-engine={vis.engine}
		data-engine-name={identity.name}
		data-controls-visible={chrome.visible}
		data-controls-mode={chrome.mode}
		onkeydown={handleHostKeydown}
	>
		{#if vis.engine === 'mk1'}
			<VisualizerMk1 />
		{:else if vis.engine === 'mandala'}
			<VisualizerMandala />
		{:else if vis.engine === 'mk2'}
			<VisualizerMk2 />
		{:else if vis.engine === 'signal'}
			<VisualizerSignal />
		{:else}
			<VisualizerLoom />
		{/if}

		<!-- The picture itself: pointer-only (H and Tab are the keyboard routes). -->
		<div
			class={`fixed inset-0 z-[104] touch-none select-none ${chrome.visible ? 'cursor-default' : 'cursor-none'}`}
			aria-hidden="true"
			data-visualizer-stage
			onpointermove={handleStagePointerMove}
			onpointerdown={handleStagePointerDown}
			onpointerup={handleStagePointerUp}
			onpointercancel={() => (swipe = null)}
			onclick={handleStageClick}
		></div>

		<!-- Where the switcher sits, so the eye finds the name in the same place. -->
		{#if flashEngine && !chrome.visible}
			<p
				class="pointer-events-none fixed inset-x-0 top-[max(1.75rem,calc(env(safe-area-inset-top)+0.75rem))] z-[105] text-center text-xs font-medium tracking-[0.32em] text-white/80 uppercase sm:top-[max(2rem,calc(env(safe-area-inset-top)+0.75rem))] [text-shadow:0_2px_18px_rgba(0,0,0,0.85)] motion-safe:animate-[visualizer-flash_1.4s_ease-out_forwards]"
				aria-hidden="true"
				data-visualizer-engine-flash
			>
				{VISUALIZER_CATALOG[flashEngine].name}
			</p>
		{/if}

		<!-- Chrome. Pointer presses never take focus here, so Space keeps meaning
		     play/pause after a click; keyboard focus still reaches every control. -->
		<div
			bind:this={chromeElement}
			class={`visualizer-chrome pointer-events-none fixed inset-0 z-[106] flex flex-col justify-between transition-opacity duration-300 ease-out motion-reduce:transition-none ${chrome.visible ? 'opacity-100' : 'opacity-0'}`}
			role="group"
			aria-label="Visualizer controls"
			aria-hidden={!chrome.visible}
			inert={!chrome.visible}
			data-visualizer-chrome
			onmousedown={(event) => event.preventDefault()}
			onpointerdown={() => chrome.wake()}
			onfocusin={handleChromeFocusIn}
			onfocusout={handleChromeFocusOut}
		>
			<header
				class="grid grid-cols-[1fr_auto_1fr] items-start gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))] max-sm:grid-cols-[minmax(0,1fr)_auto] sm:px-6 sm:pt-[max(1.25rem,env(safe-area-inset-top))]"
			>
				<div class="max-sm:hidden"></div>
				<!-- svelte-ignore a11y_no_static_element_interactions (hover hold only) -->
				<div
					class="pointer-events-auto min-w-0"
					onpointerenter={surfacePointer('engines-pointer', true)}
					onpointerleave={surfacePointer('engines-pointer', false)}
				>
					<EngineSwitcher engine={vis.engine} onSelect={selectEngine} />
				</div>
				<!-- svelte-ignore a11y_no_static_element_interactions (hover hold only) -->
				<div
					class="pointer-events-auto flex items-center justify-end gap-1.5 justify-self-end"
					onpointerenter={surfacePointer('engines-pointer', true)}
					onpointerleave={surfacePointer('engines-pointer', false)}
				>
					<button
						type="button"
						class="grid size-10 place-items-center rounded-full border border-white/10 bg-black/45 text-white/65 shadow-lg shadow-black/30 backdrop-blur-xl transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white/80 motion-reduce:transition-none max-sm:hidden"
						aria-label="Hide controls"
						aria-keyshortcuts="H"
						title="Hide controls (H)"
						onclick={() => chrome.lock()}
					>
						<EyeOff class="size-4" strokeWidth={1.75} />
					</button>
					<button
						type="button"
						class="grid size-10 place-items-center rounded-full border border-white/10 bg-black/45 text-white/75 shadow-lg shadow-black/30 backdrop-blur-xl transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white/80 motion-reduce:transition-none"
						aria-label="Exit visualizer"
						aria-keyshortcuts="Escape"
						title="Exit (Esc)"
						onclick={() => vis.close()}
					>
						<X class="size-[18px]" strokeWidth={1.75} />
					</button>
				</div>
			</header>

			<footer
				class="flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-[max(1.5rem,env(safe-area-inset-bottom))]"
			>
				<!-- svelte-ignore a11y_no_static_element_interactions (hover hold only) -->
				<div
					class="pointer-events-auto flex w-full max-w-[26rem] justify-center"
					onpointerenter={surfacePointer('playback-pointer', true)}
					onpointerleave={surfacePointer('playback-pointer', false)}
				>
					<NowPlaying />
				</div>
			</footer>
		</div>

		<p class="sr-only" aria-live="polite">{identity.name}: {identity.subtitle}</p>
	</div>
{/if}

<style>
	/* Large, far-away screens (a 3840-wide monitor at 100% scaling) get
	   proportionally larger chrome; everything else keeps the small type. */
	@media (min-width: 2400px) {
		.visualizer-chrome {
			zoom: 1.3;
		}
	}

	@keyframes -global-visualizer-flash {
		0% {
			opacity: 0;
		}
		15% {
			opacity: 1;
		}
		70% {
			opacity: 1;
		}
		100% {
			opacity: 0;
		}
	}
</style>
