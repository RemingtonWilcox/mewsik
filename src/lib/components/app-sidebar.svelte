<script lang="ts">
	import {
		Sidebar,
		SidebarContent,
		SidebarHeader,
		SidebarGroup,
		SidebarGroupLabel,
		SidebarGroupContent,
		SidebarMenu,
		SidebarMenuItem,
		SidebarMenuButton,
		SidebarFooter,
		SidebarRail
	} from '$lib/components/ui/sidebar';
	import Logo from '$lib/components/logo.svelte';
	import {
		Library,
		Search,
		ListMusic,
		Radio,
		Compass,
		Download,
		Settings,
		Plus
	} from '@lucide/svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import * as api from '$lib/api/tauri';
	import { toast } from 'svelte-sonner';
	import { useActiveDownloads } from '$lib/state/downloads.svelte';
	import type { Playlist } from '$lib/types';

	const activeDownloads = useActiveDownloads();

	let playlists = $state<Playlist[]>([]);

	$effect(() => {
		loadPlaylists();
	});

	$effect(() => {
		const handler = () => void loadPlaylists();
		window.addEventListener('playlists-changed', handler);
		return () => window.removeEventListener('playlists-changed', handler);
	});

	async function loadPlaylists() {
		try {
			playlists = await api.getPlaylists();
		} catch {
			// ignore
		}
	}

	async function handleCreatePlaylist() {
		try {
			const pl = await api.createPlaylist('New Playlist');
			playlists = [...playlists, pl];
			window.dispatchEvent(new CustomEvent('playlists-changed'));
			await goto(`/playlists/${pl.id}`);
			toast.success('Playlist created');
		} catch (e) {
			toast.error('Failed to create playlist');
		}
	}

	const navItems = [
		{ href: '/library', label: 'Library', icon: Library },
		{ href: '/search', label: 'Search', icon: Search },
		{ href: '/stations', label: 'Stations', icon: Radio },
		{ href: '/discover', label: 'Discover', icon: Compass },
		{ href: '/downloads', label: 'Downloads', icon: Download },
		{ href: '/settings', label: 'Settings', icon: Settings }
	];
</script>

<Sidebar>
	<SidebarHeader>
		<a href="/" class="flex items-center gap-3 px-3 py-5">
			<Logo size={56} class="shrink-0 text-primary" />
			<span class="text-2xl font-bold tracking-tight">mewsik</span>
		</a>
	</SidebarHeader>

	<SidebarContent>
		<SidebarGroup>
			<SidebarGroupLabel>Menu</SidebarGroupLabel>
			<SidebarGroupContent>
				<SidebarMenu>
					{#each navItems as item}
						<SidebarMenuItem>
							<SidebarMenuButton
								isActive={page.url.pathname.startsWith(item.href)}
							>
								{#snippet child({ props })}
									<a href={item.href} {...props}>
										<item.icon class="size-4" />
										<span>{item.label}</span>
										{#if item.href === '/downloads' && activeDownloads.count > 0}
											<span class="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold leading-none text-primary-foreground">{activeDownloads.count}</span>
										{/if}
									</a>
								{/snippet}
							</SidebarMenuButton>
						</SidebarMenuItem>
					{/each}
				</SidebarMenu>
			</SidebarGroupContent>
		</SidebarGroup>

		<SidebarGroup>
			<SidebarGroupLabel>
				<span>Playlists</span>
				<button
					class="ml-auto rounded-md p-0.5 hover:bg-sidebar-accent"
					onclick={handleCreatePlaylist}
				>
					<Plus class="size-4" />
				</button>
			</SidebarGroupLabel>
			<SidebarGroupContent>
				<SidebarMenu>
					{#each playlists as playlist}
						<SidebarMenuItem>
							<SidebarMenuButton
								isActive={page.url.pathname === `/playlists/${playlist.id}`}
							>
								{#snippet child({ props })}
									<a href={`/playlists/${playlist.id}`} {...props}>
										<ListMusic class="size-4" />
										<span>{playlist.name}</span>
									</a>
								{/snippet}
							</SidebarMenuButton>
						</SidebarMenuItem>
					{/each}
				</SidebarMenu>
			</SidebarGroupContent>
		</SidebarGroup>
	</SidebarContent>

	<SidebarFooter>
		<div class="px-2 py-1 text-xs text-muted-foreground">
			mewsik v0.1.0
		</div>
	</SidebarFooter>

	<SidebarRail />
</Sidebar>
