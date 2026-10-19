<script lang="ts">
	import {
		VISUALIZER_CATALOG,
		VISUALIZER_ENGINES,
		type VisualizerEngine
	} from '$lib/state/visualizer.svelte';

	// The four engines by name, in arrow-key order. A radio group with a roving
	// tab stop: Tab lands on the current engine, ←/→ (handled by the host for
	// the whole overlay) move the selection, and focus follows it.
	let {
		engine,
		onSelect
	}: {
		engine: VisualizerEngine;
		onSelect: (engine: VisualizerEngine) => void;
	} = $props();

	let preview = $state<VisualizerEngine | null>(null);
	let caption = $derived(VISUALIZER_CATALOG[preview ?? engine]);
</script>

<div class="flex min-w-0 flex-col items-center gap-2 max-sm:items-start">
	<div
		role="radiogroup"
		aria-label="Visualizer"
		class="flex items-center gap-0.5 rounded-full border border-white/10 bg-black/45 p-1 shadow-lg shadow-black/30 backdrop-blur-xl"
	>
		{#each VISUALIZER_ENGINES as id (id)}
			{@const identity = VISUALIZER_CATALOG[id]}
			{@const selected = id === engine}
			<button
				type="button"
				role="radio"
				aria-checked={selected}
				aria-label={identity.name}
				aria-describedby={`visualizer-engine-${id}-description`}
				tabindex={selected ? 0 : -1}
				data-engine-option={id}
				class={`relative flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12px] font-medium tracking-[0.02em] transition-colors duration-200 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white/80 max-sm:px-3 ${
					selected
						? 'bg-white/[0.12] text-white'
						: 'text-white/50 hover:bg-white/[0.06] hover:text-white/85'
				}`}
				onclick={() => onSelect(id)}
				onpointerenter={(event) => {
					if (event.pointerType !== 'touch') preview = id;
				}}
				onpointerleave={() => {
					if (preview === id) preview = null;
				}}
				onfocus={() => (preview = id)}
				onblur={() => {
					if (preview === id) preview = null;
				}}
			>
				<span
					class={`size-1.5 rounded-full transition-opacity duration-200 motion-reduce:transition-none ${selected ? 'opacity-100' : 'opacity-0'}`}
					style:background={identity.accent}
					style:box-shadow={`0 0 8px ${identity.accentMuted}`}
					aria-hidden="true"
				></span>
				{identity.name}
			</button>
		{/each}
	</div>
	{#each VISUALIZER_ENGINES as id (id)}
		<span id={`visualizer-engine-${id}-description`} class="sr-only">
			{VISUALIZER_CATALOG[id].description}
		</span>
	{/each}

	<p
		class="max-w-[min(100%,28rem)] truncate px-2 text-[11px] leading-4 text-white/55 [text-shadow:0_1px_8px_rgba(0,0,0,0.9)]"
		aria-hidden="true"
		data-engine-caption
	>
		{caption.description}
	</p>
</div>
