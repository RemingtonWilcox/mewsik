<script lang="ts">
	import { formatTime } from '$lib/state/player.svelte';
	import * as api from '$lib/api/tauri';

	// A SoundCloud-style waveform of the playing file. The bars are drawn once
	// into a mask; the played and hovered parts are the same mask in other
	// colours, clipped, so playback never redraws anything.
	// The engine reports position every ~250 ms; between reports the bar runs
	// on its own clock so the fill glides instead of stepping.
	let {
		recordingId = null,
		positionMs,
		durationMs,
		playing,
		enabled = true,
		onseek
	}: {
		/** Draws this recording's waveform when it has a local file. */
		recordingId?: string | null;
		positionMs: number;
		durationMs: number;
		playing: boolean;
		enabled?: boolean;
		onseek: (ms: number) => void;
	} = $props();

	const HEIGHT = 34;
	const BAR = 2;
	const GAP = 1;
	// The bars stand on a baseline with a faint reflection underneath.
	const BASELINE = 0.72;

	let bar = $state<HTMLDivElement | null>(null);
	let width = $state(0);
	let shown = $state(0);
	let drag = $state<number | null>(null);
	let hover = $state<number | null>(null);
	let shape = $state<number[] | null>(null);
	let shapeFor = $state<string | null>(null);
	let mask = $state('');

	let anchorPos = 0;
	let anchorAt = 0;

	// Shapes already fetched this session, so going back is instant.
	const shapes = new Map<string, number[] | null>();

	$effect(() => {
		const id = recordingId;
		if (!id) {
			shape = null;
			shapeFor = null;
			return;
		}
		if (shapes.has(id)) {
			shape = shapes.get(id) ?? null;
			shapeFor = id;
			return;
		}
		shape = null;
		shapeFor = id;
		let cancelled = false;
		api
			.getPlaybackWaveform(id, 600)
			.then((wave) => {
				// Mostly body (rms) with a little of each transient's peak.
				const values = wave.peaks.map((p, i) => 0.3 * p + 0.7 * (wave.rms?.[i] ?? p));
				shapes.set(id, values);
				if (!cancelled) shape = values;
			})
			.catch(() => {
				shapes.set(id, null);
			});
		return () => {
			cancelled = true;
		};
	});

	$effect(() => {
		if (!bar) return;
		const observer = new ResizeObserver(() => (width = bar?.clientWidth ?? 0));
		observer.observe(bar);
		width = bar.clientWidth;
		return () => observer.disconnect();
	});

	$effect(() => {
		mask = drawMask(shape, width);
	});

	function drawMask(values: number[] | null, cssWidth: number): string {
		if (cssWidth <= 0 || typeof document === 'undefined') return '';
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const canvas = document.createElement('canvas');
		canvas.width = Math.round(cssWidth * dpr);
		canvas.height = Math.round(HEIGHT * dpr);
		const ctx = canvas.getContext('2d');
		if (!ctx) return '';
		ctx.scale(dpr, dpr);
		const count = Math.max(1, Math.floor(cssWidth / (BAR + GAP)));
		const base = HEIGHT * BASELINE;
		for (let i = 0; i < count; i++) {
			let v = 0.08;
			if (values && values.length) {
				const start = Math.floor((i * values.length) / count);
				const end = Math.max(start + 1, Math.floor(((i + 1) * values.length) / count));
				v = 0;
				for (let j = start; j < end && j < values.length; j++) v = Math.max(v, values[j]);
			}
			const up = Math.max(1.5, v * (base - 1));
			const down = up * ((1 - BASELINE) / BASELINE);
			const x = i * (BAR + GAP);
			ctx.fillStyle = '#fff';
			ctx.fillRect(x, base - up, BAR, up);
			ctx.fillStyle = 'rgba(255,255,255,0.35)';
			ctx.fillRect(x, base + 1, BAR, down);
		}
		return `url(${canvas.toDataURL()})`;
	}

	$effect(() => {
		const now = performance.now();
		// Small disagreements are poll jitter; only re-anchor on a real jump
		// (seek, new track, pause) so the fill never twitches backwards.
		if (playing && Math.abs(positionMs - (anchorPos + (now - anchorAt))) < 350) return;
		anchorPos = positionMs;
		anchorAt = now;
		shown = positionMs;
	});

	$effect(() => {
		if (!playing || durationMs <= 0) return;
		let frame = 0;
		const tick = (now: number) => {
			shown = Math.min(durationMs, anchorPos + (now - anchorAt));
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	});

	const ratio = $derived(
		durationMs > 0 ? Math.max(0, Math.min(1, (drag ?? shown / durationMs) || 0)) : 0
	);
	const loaded = $derived(shape !== null && shapeFor === recordingId);

	function ratioAt(clientX: number) {
		if (!bar) return 0;
		const rect = bar.getBoundingClientRect();
		return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
	}

	function down(event: PointerEvent) {
		if (!enabled || durationMs <= 0 || event.button !== 0) return;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		drag = ratioAt(event.clientX);
	}

	function move(event: PointerEvent) {
		hover = ratioAt(event.clientX);
		if (drag !== null) drag = hover;
	}

	function up(event: PointerEvent) {
		if (drag === null) return;
		const ms = Math.round(ratioAt(event.clientX) * durationMs);
		drag = null;
		anchorPos = ms;
		anchorAt = performance.now();
		shown = ms;
		onseek(ms);
	}

	function key(event: KeyboardEvent) {
		if (!enabled || durationMs <= 0) return;
		const step = event.shiftKey ? 30000 : 5000;
		if (event.key === 'ArrowLeft') onseek(Math.max(0, shown - step));
		else if (event.key === 'ArrowRight') onseek(Math.min(durationMs, shown + step));
		else return;
		event.preventDefault();
	}

	const pointer = $derived(drag ?? hover);
</script>

<div class="flex w-full items-center gap-3 text-[11px] tabular-nums text-muted-foreground">
	<span class="w-10 text-right" class:text-foreground={drag !== null}>
		{formatTime(drag !== null ? drag * durationMs : shown)}
	</span>
	<div
		bind:this={bar}
		role="slider"
		tabindex={enabled ? 0 : -1}
		aria-label="Seek"
		aria-valuemin={0}
		aria-valuemax={durationMs}
		aria-valuenow={Math.round(shown)}
		aria-valuetext={formatTime(shown)}
		aria-disabled={!enabled}
		data-waveform={loaded ? 'ready' : 'pending'}
		class="seek relative flex-1 touch-none rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-primary/60 {enabled
			? 'cursor-pointer'
			: 'opacity-40'}"
		style:height="{HEIGHT}px"
		onpointerdown={down}
		onpointermove={move}
		onpointerup={up}
		onpointercancel={() => (drag = null)}
		onpointerleave={() => (hover = null)}
		onkeydown={key}
	>
		{#key loaded ? recordingId : null}
			<div
				class="wave absolute inset-0"
				class:grow={loaded}
				style:--mask={mask}
				style:transform-origin="50% {BASELINE * 100}%"
			>
				<div class="layer bg-white/25"></div>
				{#if pointer !== null && enabled}
					<div
						class="layer bg-white/55"
						style:clip-path="inset(0 {(1 - pointer) * 100}% 0 0)"
					></div>
				{/if}
				<div class="layer played" style:clip-path="inset(0 {(1 - ratio) * 100}% 0 0)"></div>
			</div>
		{/key}
		{#if pointer !== null && enabled && durationMs > 0}
			<div
				class="pointer-events-none absolute inset-y-0 w-px bg-white/80"
				style:left="{pointer * 100}%"
			></div>
			<div
				class="pointer-events-none absolute bottom-0 rounded-sm bg-black/90 px-1 text-[10px] font-medium leading-[14px] text-white"
				style:left="{pointer * 100}%"
				style:transform={pointer > 0.9 ? 'translateX(calc(-100% - 3px))' : 'translateX(3px)'}
			>
				{formatTime(pointer * durationMs)}
			</div>
		{/if}
	</div>
	<span class="w-10">{formatTime(durationMs)}</span>
</div>

<style>
	.layer {
		position: absolute;
		inset: 0;
		-webkit-mask-image: var(--mask);
		mask-image: var(--mask);
		-webkit-mask-size: 100% 100%;
		mask-size: 100% 100%;
	}
	.played {
		background: linear-gradient(
			to right,
			color-mix(in oklch, var(--color-primary) 70%, white),
			var(--color-primary)
		);
	}
	.grow {
		animation: grow 320ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	@keyframes grow {
		from {
			transform: scaleY(0.15);
			opacity: 0.4;
		}
	}
	.seek:hover .played,
	.seek:focus-visible .played {
		filter: brightness(1.12);
	}
</style>
