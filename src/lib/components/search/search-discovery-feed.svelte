<script lang="ts">
	import type { SearchDiscoveryFeed, SearchDiscoveryItem } from '$lib/api/tauri';
	import { LoaderCircle, Radio, Sparkles } from '@lucide/svelte';
	import SearchDiscoveryCard from './search-discovery-card.svelte';

	let {
		feed,
		loading = false,
		onselect
	}: {
		feed: SearchDiscoveryFeed | null;
		loading?: boolean;
		onselect: (item: SearchDiscoveryItem) => void;
	} = $props();
</script>

<section class="min-w-0 space-y-7 pb-6" aria-label="Search inspiration" data-testid="search-discovery-feed">
	<div class="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
		<div>
			<h2 class="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-foreground/85">
				<Sparkles class="size-3.5 text-primary" /> Find your next rabbit hole
			</h2>
			<p class="mt-1 text-xs text-muted-foreground">Apple Music charts are labeled; rabbit holes are Mewsik editorial. Nothing here is personalized yet.</p>
		</div>
		{#if loading}
			<span class="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
				<LoaderCircle class="size-3 animate-spin" /> Refreshing picks
			</span>
		{:else if feed}
			<span class="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/70 bg-muted/25 px-2.5 py-1 text-[10px] text-muted-foreground" title={feed.source}>
				<Radio class="size-2.5 {feed.is_fallback ? '' : 'text-primary'}" />
				<span class="truncate">{feed.is_stale ? `Cached · ${feed.source}` : feed.source}</span>
			</span>
		{/if}
	</div>

	{#if feed}
		{#each feed.sections as section (section.id)}
			<section aria-labelledby={`discovery-${section.id}`} data-testid={`discovery-section-${section.id}`}>
				<div class="mb-3 flex items-end justify-between gap-4">
					<div class="min-w-0">
						<h3 id={`discovery-${section.id}`} class="text-lg font-semibold tracking-tight">{section.title}</h3>
						<p class="truncate text-xs text-muted-foreground">{section.subtitle}</p>
					</div>
					<span class="shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/55">Click to search</span>
				</div>
				<div class="discovery-rail flex gap-3 overflow-x-auto pb-2">
					{#each section.items as item (`${section.id}-${item.id}`)}
						<SearchDiscoveryCard {item} sectionId={section.id} {onselect} />
					{/each}
				</div>
			</section>
		{/each}
	{:else if loading}
		{#each Array(3) as _, sectionIndex}
			<div aria-hidden="true">
				<div class="mb-3 h-5 w-32 animate-pulse rounded bg-muted"></div>
				<div class="flex gap-3 overflow-hidden">
					{#each Array(6) as _, itemIndex}
						<div class="w-[9.75rem] shrink-0" data-skeleton={`${sectionIndex}-${itemIndex}`}>
							<div class="aspect-square animate-pulse rounded-xl bg-muted"></div>
							<div class="mt-2 h-3.5 w-4/5 animate-pulse rounded bg-muted"></div>
							<div class="mt-1.5 h-2.5 w-3/5 animate-pulse rounded bg-muted/70"></div>
						</div>
					{/each}
				</div>
			</div>
		{/each}
	{:else}
		<p class="py-10 text-center text-sm text-muted-foreground">Discovery picks are taking a break. Search above to keep exploring.</p>
	{/if}
</section>

<style>
	.discovery-rail {
		scrollbar-width: thin;
		scrollbar-color: color-mix(in oklab, var(--muted-foreground) 25%, transparent) transparent;
		scroll-snap-type: x proximity;
	}

	.discovery-rail :global(> *) {
		scroll-snap-align: start;
	}
</style>
