<script lang="ts">
	import { formatTime } from '$lib/state/player.svelte';

	// The engine reports position every ~250 ms; between reports the bar runs
	// on its own clock so the fill glides instead of stepping.
	let {
		positionMs,
		durationMs,
		playing,
		enabled = true,
		onseek
	}: {
		positionMs: number;
		durationMs: number;
		playing: boolean;
		enabled?: boolean;
		onseek: (ms: number) => void;
	} = $props();

	let bar = $state<HTMLDivElement | null>(null);
	let shown = $state(0);
	let drag = $state<number | null>(null);
	let hover = $state<number | null>(null);

	let anchorPos = 0;
	let anchorAt = 0;

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

	function ratioAt(clientX: number) {
		if (!bar) return 0;
		const rect = bar.getBoundingClientRect();
		return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
	}

	function down(event: PointerEvent) {
		if (!enabled || durationMs <= 0) return;
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
</script>

<div class="flex w-full items-center gap-2.5 text-[11px] tabular-nums text-muted-foreground">
	<span class="w-10 text-right">{formatTime(drag !== null ? drag * durationMs : shown)}</span>
	<div
		bind:this={bar}
		role="slider"
		tabindex={enabled ? 0 : -1}
		aria-label="Seek"
		aria-valuemin={0}
		aria-valuemax={durationMs}
		aria-valuenow={Math.round(shown)}
		aria-disabled={!enabled}
		class="group relative flex h-4 flex-1 items-center outline-none {enabled
			? 'cursor-pointer'
			: 'opacity-50'}"
		onpointerdown={down}
		onpointermove={move}
		onpointerup={up}
		onpointercancel={() => (drag = null)}
		onpointerleave={() => (hover = null)}
		onkeydown={key}
	>
		<div class="absolute inset-x-0 h-1 overflow-hidden rounded-full bg-white/15">
			{#if hover !== null && enabled}
				<div class="absolute inset-y-0 left-0 bg-white/10" style:width="{hover * 100}%"></div>
			{/if}
			<div
				class="absolute inset-y-0 left-0 rounded-full bg-foreground group-hover:bg-primary"
				class:!bg-primary={drag !== null}
				style:width="{ratio * 100}%"
			></div>
		</div>
		{#if enabled}
			<div
				class="absolute size-3 -translate-x-1/2 rounded-full bg-white shadow opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
				class:!opacity-100={drag !== null}
				style:left="{ratio * 100}%"
			></div>
		{/if}
	</div>
	<span class="w-10">{formatTime(durationMs)}</span>
</div>
