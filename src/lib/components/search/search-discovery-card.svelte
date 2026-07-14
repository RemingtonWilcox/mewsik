<script lang="ts">
	import type { SearchDiscoveryItem } from '$lib/api/tauri';
	import { ArrowUpRight, Search } from '@lucide/svelte';

	let {
		item,
		sectionId,
		onselect
	}: {
		item: SearchDiscoveryItem;
		sectionId: string;
		onselect: (item: SearchDiscoveryItem) => void;
	} = $props();

	let imageFailed = $state(false);
	let artworkUrl = $derived(validatedArtworkUrl(item.artwork_url));

	function validatedArtworkUrl(value: string | null): string | null {
		if (!value) return null;
		try {
			const url = new URL(value);
			if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
			const isCoverArtArchive =
				url.hostname === 'coverartarchive.org' &&
				/^\/release\/[0-9a-f-]{36}\/[0-9]+-250\.jpg$/i.test(url.pathname);
			const isAppleArtwork =
				url.hostname === 'mzstatic.com' || url.hostname.endsWith('.mzstatic.com');
			if (!isCoverArtArchive && !isAppleArtwork) return null;
			return url.toString();
		} catch {
			return null;
		}
	}

	function compactCount(value: number): string {
		return new Intl.NumberFormat(undefined, {
			notation: 'compact',
			maximumFractionDigits: 1
		}).format(value);
	}

	function initials(value: string): string {
		return value
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0])
			.join('')
			.toUpperCase();
	}
</script>

<button
	type="button"
	class="group w-[9.75rem] shrink-0 text-left focus-visible:outline-none"
	onclick={() => onselect(item)}
	aria-label={`Search for ${item.title} by ${item.artist}`}
	data-testid={`discovery-card-${sectionId}`}
>
	<div class="relative aspect-square overflow-hidden rounded-xl border border-white/8 bg-gradient-to-br from-primary/25 via-muted to-background shadow-sm transition duration-200 group-hover:-translate-y-0.5 group-hover:border-primary/35 group-hover:shadow-lg group-hover:shadow-primary/5 group-focus-visible:ring-2 group-focus-visible:ring-primary">
		{#if artworkUrl && !imageFailed}
			<img
				src={artworkUrl}
				alt=""
				class="size-full object-cover transition duration-300 group-hover:scale-[1.025]"
				loading="lazy"
				decoding="async"
				width="156"
				height="156"
				onerror={() => { imageFailed = true; }}
			/>
		{:else}
			<div class="flex size-full items-center justify-center bg-[radial-gradient(circle_at_25%_20%,color-mix(in_oklab,var(--primary)_35%,transparent),transparent_45%),linear-gradient(145deg,color-mix(in_oklab,var(--muted)_85%,black),var(--background))]">
				<span class="font-mono text-3xl font-semibold tracking-tight text-foreground/55">{initials(item.artist)}</span>
			</div>
		{/if}

		<div class="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100"></div>
		<span class="absolute bottom-2 right-2 flex size-8 translate-y-1 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-md transition duration-200 group-hover:translate-y-0 group-hover:opacity-100">
			<Search class="size-3.5" />
		</span>

		{#if item.momentum && item.momentum > 0}
			<span class="absolute left-2 top-2 inline-flex items-center gap-0.5 rounded-full bg-black/65 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm">
				<ArrowUpRight class="size-2.5" /> {item.momentum}
			</span>
		{:else if item.rank}
			<span class="absolute left-2 top-2 rounded-full bg-black/65 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm">#{item.rank}</span>
		{/if}
	</div>

	<div class="mt-2 min-w-0 px-0.5">
		<p class="truncate text-sm font-medium leading-5 text-foreground transition-colors group-hover:text-primary">{item.title}</p>
		<p class="truncate text-xs leading-4 text-muted-foreground">{item.artist}</p>
		{#if item.listen_count}
			<p class="mt-0.5 text-[10px] text-muted-foreground/70">{compactCount(item.listen_count)} weekly listens</p>
		{:else if item.album}
			<p class="mt-0.5 truncate text-[10px] text-muted-foreground/70">{item.album}</p>
		{:else if item.context}
			<p class="mt-0.5 truncate text-[10px] text-muted-foreground/70">{item.context}</p>
		{/if}
	</div>
</button>
