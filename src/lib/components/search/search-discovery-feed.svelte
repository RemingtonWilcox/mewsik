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

	let liveSourceCount = $derived((feed?.source_statuses ?? []).filter((source) => source.state === 'live').length);
	let cachedSourceCount = $derived((feed?.source_statuses ?? []).filter((source) => source.state === 'cached').length);
	let unavailableSourceCount = $derived((feed?.source_statuses ?? []).filter((source) => source.state === 'unavailable').length);
	let hasPersonalizedShelves = $derived((feed?.sections ?? []).some((section) => section.personalized));
	let sourceSummary = $derived(
		liveSourceCount > 0
			? `${liveSourceCount} live signal${liveSourceCount === 1 ? '' : 's'}${cachedSourceCount > 0 ? ` · ${cachedSourceCount} cached` : ''}`
			: cachedSourceCount > 0
				? `${cachedSourceCount} cached signal${cachedSourceCount === 1 ? '' : 's'}`
				: feed?.source || 'Source status'
	);
	let sourceTooltip = $derived(
		(feed?.source_statuses ?? [])
			.map((source) => `${source.label}: ${source.state}${source.detail ? ` — ${source.detail}` : ''}`)
			.join('\n') || feed?.source || ''
	);
</script>

<section class="min-w-0 space-y-7 pb-6" aria-label="Search inspiration" data-testid="search-discovery-feed">
	<div class="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
		<div>
			<h2 class="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-foreground/85">
				<Sparkles class="size-3.5 text-primary" /> Find your next rabbit hole
			</h2>
			<p class="mt-1 text-xs text-muted-foreground">Charts, release feeds, and editorial signals{hasPersonalizedShelves ? ', shaped by your listening history' : ''}—every pick says why it is here.</p>
		</div>
		{#if loading}
			<span class="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
				<LoaderCircle class="size-3 animate-spin" /> Refreshing picks
			</span>
		{:else if feed && feed.source_statuses.length > 0}
			<details class="group/source relative max-w-full">
				<summary
					class="inline-flex max-w-full cursor-pointer list-none items-center gap-1.5 rounded-full border border-border/70 bg-muted/25 px-2.5 py-1 text-[10px] text-muted-foreground marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
					aria-label={`Discovery sources. ${sourceTooltip}`}
				>
					<Radio class="size-2.5 {feed.is_fallback || liveSourceCount === 0 ? '' : 'text-primary'}" />
					<span class="truncate">
						{feed.is_stale ? `Stale snapshot · ${sourceSummary}` : `${sourceSummary}${feed.has_history ? ' · movement on' : ''}`}
					</span>
				</summary>
				<div class="absolute right-0 z-20 mt-1.5 w-72 max-w-[80vw] rounded-lg border border-border bg-popover p-2.5 text-[10px] text-popover-foreground shadow-xl">
					{#each feed.source_statuses as source (source.id)}
						<p class="flex gap-2 py-0.5">
							<span class="w-14 shrink-0 font-semibold uppercase tracking-wide text-muted-foreground">{source.state}</span>
							<span><strong>{source.label}</strong>{source.detail ? ` — ${source.detail}` : ''}</span>
						</p>
					{/each}
					{#if unavailableSourceCount > 0}
						<p class="mt-1 border-t border-border pt-1 text-muted-foreground">Unavailable optional sources do not weaken the live ones above.</p>
					{/if}
				</div>
			</details>
		{:else if feed}
			<span class="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/70 bg-muted/25 px-2.5 py-1 text-[10px] text-muted-foreground">
				<Radio class="size-2.5" /> <span class="truncate">{feed.source}</span>
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
						<SearchDiscoveryCard
							{item}
							sectionId={section.id}
							snapshotId={feed.snapshot_id || String(feed.generated_at)}
							{onselect}
						/>
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
