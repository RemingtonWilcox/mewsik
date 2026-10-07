<script lang="ts">
	import '../app.css';
	import { Toaster } from '$lib/components/ui/sonner';
	import AppSidebar from '$lib/components/app-sidebar.svelte';
	import PlayerBar from '$lib/components/player/player-bar.svelte';
	import CommandSearch from '$lib/components/search/command-search.svelte';
	import MobileLayout from '$lib/components/mobile/mobile-layout.svelte';
	import { SidebarProvider, SidebarInset } from '$lib/components/ui/sidebar';
	import { ModeWatcher } from 'mode-watcher';
	import { IsMobile } from '$lib/hooks/is-mobile.svelte';

	let { children } = $props();

	// Mobile breakpoint matches Tailwind's `md` (768px). iOS phones always
	// match this; iPad portrait does too.
	const isMobile = new IsMobile();
</script>

<ModeWatcher />

<svelte:window
	onkeydown={(e) => {
		const target = e.target as HTMLElement;
		const isInput =
			target.tagName === 'INPUT' ||
			target.tagName === 'TEXTAREA' ||
			target.isContentEditable;

		if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
			e.preventDefault();
			const event = new CustomEvent('toggle-command', { bubbles: true });
			window.dispatchEvent(event);
		}

		if (!isInput && e.key === ' ') {
			e.preventDefault();
			const event = new CustomEvent('toggle-playback', { bubbles: true });
			window.dispatchEvent(event);
		}
	}}
/>

{#if isMobile.current}
	<MobileLayout>
		{@render children()}
	</MobileLayout>
{:else}
	<div class="flex h-screen flex-col">
		<div class="flex flex-1 overflow-hidden">
			<SidebarProvider>
				<AppSidebar />
				<SidebarInset>
					<main class="flex min-w-0 flex-1 flex-col overflow-auto p-4 pb-24">
						{@render children()}
					</main>
				</SidebarInset>
			</SidebarProvider>
		</div>
		<PlayerBar />
	</div>
{/if}

<CommandSearch />
<Toaster />
