<script lang="ts">
	type WaveformScrubberProps = {
		peaks?: number[] | null;
		valueMs: number;
		durationMs: number;
		interactive?: boolean;
		onCommit?: (positionMs: number) => void;
	};

	let {
		peaks = null,
		valueMs,
		durationMs,
		interactive = true,
		onCommit = () => {}
	}: WaveformScrubberProps = $props();

	let root = $state<HTMLButtonElement | null>(null);
	let isDragging = $state(false);
	let previewRatio = $state<number | null>(null);

	let hasDuration = $derived(durationMs > 0);
	let hasWaveform = $derived(Boolean(peaks && peaks.length > 0));
	let resolvedInteractive = $derived(interactive && hasDuration);
	let baseRatio = $derived(hasDuration ? Math.min(1, Math.max(0, valueMs / durationMs)) : 0);
	let activeRatio = $derived(previewRatio ?? baseRatio);
	let activePercent = $derived(`${(activeRatio * 100).toFixed(3)}%`);
	let activeIndex = $derived(
		hasWaveform && peaks ? Math.floor(activeRatio * peaks.length) : 0
	);

	function clampRatio(value: number) {
		return Math.max(0, Math.min(1, value));
	}

	function ratioFromClientX(clientX: number) {
		if (!root) {
			return 0;
		}
		const rect = root.getBoundingClientRect();
		if (rect.width <= 0) {
			return 0;
		}
		return clampRatio((clientX - rect.left) / rect.width);
	}

	function commitRatio(ratio: number) {
		if (!resolvedInteractive) {
			return;
		}
		onCommit(Math.round(clampRatio(ratio) * durationMs));
	}

	function handlePointerDown(event: PointerEvent) {
		if (!resolvedInteractive || !root) {
			return;
		}
		isDragging = true;
		previewRatio = ratioFromClientX(event.clientX);
		root.setPointerCapture(event.pointerId);
	}

	function handlePointerMove(event: PointerEvent) {
		if (!isDragging) {
			return;
		}
		previewRatio = ratioFromClientX(event.clientX);
	}

	function handlePointerUp(event: PointerEvent) {
		if (!isDragging || !root) {
			return;
		}
		const ratio = ratioFromClientX(event.clientX);
		isDragging = false;
		previewRatio = null;
		root.releasePointerCapture(event.pointerId);
		commitRatio(ratio);
	}

	function handlePointerCancel(event: PointerEvent) {
		if (!isDragging || !root) {
			return;
		}
		isDragging = false;
		previewRatio = null;
		if (root.hasPointerCapture(event.pointerId)) {
			root.releasePointerCapture(event.pointerId);
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (!resolvedInteractive) {
			return;
		}

		const smallStep = Math.max(5000, durationMs * 0.02);
		const largeStep = Math.max(15000, durationMs * 0.1);
		switch (event.key) {
			case 'ArrowLeft':
				event.preventDefault();
				commitRatio((valueMs - smallStep) / durationMs);
				break;
			case 'ArrowRight':
				event.preventDefault();
				commitRatio((valueMs + smallStep) / durationMs);
				break;
			case 'PageDown':
				event.preventDefault();
				commitRatio((valueMs - largeStep) / durationMs);
				break;
			case 'PageUp':
				event.preventDefault();
				commitRatio((valueMs + largeStep) / durationMs);
				break;
			case 'Home':
				event.preventDefault();
				commitRatio(0);
				break;
			case 'End':
				event.preventDefault();
				commitRatio(1);
				break;
		}
	}
</script>

<button
	type="button"
	bind:this={root}
	role={resolvedInteractive ? 'slider' : undefined}
	disabled={!resolvedInteractive}
	aria-valuemin={resolvedInteractive ? 0 : undefined}
	aria-valuemax={resolvedInteractive ? durationMs : undefined}
	aria-valuenow={resolvedInteractive ? Math.round(activeRatio * durationMs) : undefined}
	aria-label="Playback position"
	class={`group relative w-full transition ${
		resolvedInteractive
			? 'cursor-pointer focus:outline-none'
			: 'opacity-60'
	}`}
	style="height: 20px; display: flex; align-items: center;"
	onpointerdown={handlePointerDown}
	onpointermove={handlePointerMove}
	onpointerup={handlePointerUp}
	onpointercancel={handlePointerCancel}
	onkeydown={handleKeydown}
>
	<!-- Track background -->
	<div style="position: absolute; left: 0; right: 0; height: 4px; border-radius: 9999px; background-color: #3a3a4a;"></div>
	<!-- Filled range -->
	<div style="position: absolute; left: 0; height: 4px; border-radius: 9999px; background-color: oklch(0.75 0.18 160); transition: width 0.1s; width: {activePercent};"></div>
	<!-- Thumb dot -->
	{#if resolvedInteractive}
		<div
			style="position: absolute; width: 12px; height: 12px; border-radius: 50%; background: white; box-shadow: 0 1px 4px rgba(0,0,0,0.3); transform: translateX(-50%); transition: left 0.075s; left: {activePercent};"
		></div>
	{/if}
</button>
