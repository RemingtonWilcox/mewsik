<script lang="ts">
	import '../app.css';
	import { Toaster } from '$lib/components/ui/sonner';
	import AppSidebar from '$lib/components/app-sidebar.svelte';
	import PlayerBar from '$lib/components/player/player-bar.svelte';
	import CommandSearch from '$lib/components/search/command-search.svelte';
	import UpdateNotice from '$lib/components/update/update-notice.svelte';
	import VisualizerHost from '$lib/components/visualizer/visualizer-host.svelte';
	import { useAppUpdater } from '$lib/state/app-updater.svelte';
	import { useVisualizer } from '$lib/state/visualizer.svelte';
	import { page } from '$app/state';
	import {
		SidebarProvider,
		SidebarInset
	} from '$lib/components/ui/sidebar';
	import { ModeWatcher } from 'mode-watcher';
	import { onMount } from 'svelte';

	let { children } = $props();
	const visualizer = useVisualizer();
	const updater = useAppUpdater();

	onMount(() => {
		updater.startLaunchCheck();
	});

	const isVisualizerLab = $derived(page.url.pathname.startsWith('/visualizer-test'));

	const interactiveKeyboardTarget = [
		'a[href]',
		'button',
		'input',
		'textarea',
		'select',
		'summary',
		'audio[controls]',
		'video[controls]',
		'[contenteditable]:not([contenteditable="false"])',
		'[tabindex]:not([tabindex="-1"])',
		'[role="button"]',
		'[role="link"]',
		'[role="checkbox"]',
		'[role="radio"]',
		'[role="switch"]',
		'[role="slider"]',
		'[role="spinbutton"]',
		'[role="scrollbar"]',
		'[role="textbox"]',
		'[role="searchbox"]',
		'[role="combobox"]',
		'[role="listbox"]',
		'[role="option"]',
		'[role="menuitem"]',
		'[role="menuitemcheckbox"]',
		'[role="menuitemradio"]',
		'[role="tab"]',
		'[role="treeitem"]',
		'[role="gridcell"]',
		'[role="row"]',
		'[role="rowheader"]',
		'[role="columnheader"]'
	].join(',');

	function isInteractiveKeyboardTarget(event: KeyboardEvent): boolean {
		return event
			.composedPath()
			.some((node) => node instanceof Element && node.matches(interactiveKeyboardTarget));
	}
</script>

<ModeWatcher />

<svelte:window
	onkeydown={(e) => {
		if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
			e.preventDefault();
			if (visualizer.active) return;
			const event = new CustomEvent('toggle-command', { bubbles: true });
			window.dispatchEvent(event);
			return;
		}

		if (
			e.key === ' ' &&
			!e.altKey &&
			!e.ctrlKey &&
			!e.metaKey &&
			!isInteractiveKeyboardTarget(e)
		) {
			e.preventDefault();
			const event = new CustomEvent('toggle-playback', { bubbles: true });
			window.dispatchEvent(event);
		}
	}}
/>

{#if isVisualizerLab}
	{@render children()}
{:else}
	<div class="flex h-screen flex-col">
		<div
			data-app-content
			class="flex flex-1 overflow-hidden"
			inert={visualizer.active}
			aria-hidden={visualizer.active ? 'true' : undefined}
		>
			<UpdateNotice />
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

	<CommandSearch />
	<VisualizerHost />
	<Toaster />
{/if}
