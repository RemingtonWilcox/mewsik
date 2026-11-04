<script lang="ts">
	import type { Snippet } from 'svelte';
	import Cover from './cover.svelte';
	import { Play, Shuffle } from '@lucide/svelte';

	// The big header shared by album, artist and playlist pages.
	let {
		kind,
		title,
		cover = null,
		round = false,
		meta,
		onplay,
		onshuffle,
		titleSlot,
		actions
	}: {
		kind: string;
		title: string;
		cover?: string | null;
		round?: boolean;
		meta?: Snippet;
		onplay?: () => void;
		onshuffle?: () => void;
		titleSlot?: Snippet;
		actions?: Snippet;
	} = $props();
</script>

<header class="flex flex-wrap items-end gap-6 pb-2">
	<Cover
		src={cover}
		name={title}
		eager
		class="size-48 shadow-2xl {round ? 'rounded-full' : 'rounded-lg'}"
		textClass="text-5xl"
	/>
	<div class="flex min-w-0 flex-1 flex-col gap-2">
		<p class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{kind}</p>
		{#if titleSlot}
			{@render titleSlot()}
		{:else}
			<h1 class="line-clamp-2 break-words text-4xl font-bold tracking-tight" {title}>{title}</h1>
		{/if}
		{#if meta}
			<div class="text-sm text-muted-foreground">{@render meta()}</div>
		{/if}
		<div class="mt-3 flex items-center gap-2">
			{#if onplay}
				<button
					class="flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105"
					aria-label="Play"
					onclick={onplay}
				>
					<Play class="ml-0.5 size-5 fill-current" />
				</button>
			{/if}
			{#if onshuffle}
				<button
					class="flex size-10 items-center justify-center rounded-full text-muted-foreground hover:bg-white/5 hover:text-foreground"
					aria-label="Shuffle"
					title="Shuffle"
					onclick={onshuffle}
				>
					<Shuffle class="size-5" />
				</button>
			{/if}
			{@render actions?.()}
		</div>
	</div>
</header>
