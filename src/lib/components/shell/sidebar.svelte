<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import Logo from '$lib/components/logo.svelte';
	import { usePlaylists } from '$lib/state/playlists.svelte';
	import { useActiveDownloads } from '$lib/state/downloads.svelte';
	import { Library, Search, Radio, Download, Settings, Plus, ListMusic } from '@lucide/svelte';

	const playlists = usePlaylists();
	const downloads = useActiveDownloads();

	const nav = [
		{ href: '/library', label: 'Library', icon: Library },
		{ href: '/search', label: 'Search', icon: Search },
		{ href: '/stations', label: 'Stations', icon: Radio },
		{ href: '/downloads', label: 'Downloads', icon: Download },
		{ href: '/settings', label: 'Settings', icon: Settings }
	];

	const path = $derived(page.url.pathname);

	function isActive(href: string) {
		if (href === '/library') {
			return path.startsWith('/library') || path.startsWith('/albums') || path.startsWith('/artists');
		}
		return path.startsWith(href);
	}

	async function newPlaylist() {
		try {
			const playlist = await playlists.create('New playlist');
			await goto(`/playlists/${playlist.id}?rename=1`);
		} catch (error) {
			toast.error(`Couldn't create a playlist: ${error}`);
		}
	}
</script>

<aside class="flex w-60 shrink-0 flex-col border-r border-white/5 bg-sidebar">
	<a href="/library" class="flex items-center gap-2.5 px-5 pb-4 pt-5">
		<Logo size={34} class="shrink-0 text-primary" />
		<span class="text-xl font-bold tracking-tight">mewsik</span>
	</a>

	<nav class="flex flex-col gap-0.5 px-3">
		{#each nav as item (item.href)}
			<a href={item.href} class="nav-link" aria-current={isActive(item.href) ? 'page' : undefined}>
				<item.icon class="size-4" />
				<span>{item.label}</span>
				{#if item.href === '/downloads' && downloads.count > 0}
					<span
						class="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold leading-none text-primary-foreground"
						>{downloads.count}</span
					>
				{/if}
			</a>
		{/each}
	</nav>

	<div class="mt-6 flex items-center justify-between px-5 pb-1.5">
		<span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Playlists</span>
		<button
			class="rounded-md p-1 text-muted-foreground hover:bg-white/5 hover:text-foreground"
			title="New playlist"
			aria-label="New playlist"
			onclick={newPlaylist}
		>
			<Plus class="size-4" />
		</button>
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
		{#if playlists.all.length === 0}
			<p class="px-2 py-2 text-xs text-muted-foreground">
				No playlists yet. Right-click any song to start one.
			</p>
		{:else}
			{#each playlists.all as playlist (playlist.id)}
				<a
					href="/playlists/{playlist.id}"
					class="nav-link !py-1.5"
					aria-current={path === `/playlists/${playlist.id}` ? 'page' : undefined}
					title={playlist.name}
				>
					<ListMusic class="size-4 shrink-0" />
					<span class="truncate">{playlist.name}</span>
				</a>
			{/each}
		{/if}
	</div>
</aside>
