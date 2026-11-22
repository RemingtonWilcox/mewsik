<script lang="ts">
	// Settings on the phone: only what applies there. Music folders and the
	// download folder are desktop things; TestFlight updates the phone.
	import { onMount } from 'svelte';
	import * as api from '$lib/api/tauri';
	import type { Download } from '$lib/types';
	import { useSearchState, type SearchSource } from '$lib/state/search.svelte';
	import { useAppUpdater } from '$lib/state/app-updater.svelte';
	import {
		ArrowUpRight,
		ChevronRight,
		Download as DownloadIcon,
		FileText,
		History,
		Check,
		LoaderCircle
	} from '@lucide/svelte';
	import { toast } from 'svelte-sonner';

	const search = useSearchState();
	const updater = useAppUpdater();

	let downloads = $state<Download[]>([]);
	const saved = $derived(downloads.filter((d) => d.status === 'completed').length);
	let savingLog = $state(false);

	async function saveLog() {
		savingLog = true;
		try {
			await api.saveLogFile();
			toast.success('Log saved', { description: 'Files → On My iPhone → mewsik' });
		} catch (error) {
			toast.error(`Couldn't save the log: ${error}`);
		} finally {
			savingLog = false;
		}
	}

	onMount(() => {
		void api
			.getDownloads()
			.then((list) => (downloads = list))
			.catch(() => {});
	});

	const sources: { id: SearchSource; label: string; note: string }[] = [
		{ id: 'soundcloud', label: 'SoundCloud', note: 'Artist uploads, remixes, underground' },
		{ id: 'youtube', label: 'YouTube', note: 'Almost everything, including major labels' }
	];
</script>

<div class="flex flex-col gap-7 pb-4">
	<h1 class="text-[34px] font-bold leading-tight tracking-tight">Settings</h1>

	<section>
		<p class="ios-caption">On this iPhone</p>
		<div class="ios-group">
			<a href="/downloads" class="ios-row">
				<DownloadIcon class="size-5 text-primary" />
				<span class="flex-1">Downloaded songs</span>
				<span class="text-muted-foreground tabular-nums">{saved}</span>
				<ChevronRight class="size-4 text-muted-foreground" />
			</a>
			<a href="/heard" class="ios-row">
				<History class="size-5 text-primary" />
				<span class="flex-1">Heard on radio</span>
				<ChevronRight class="size-4 text-muted-foreground" />
			</a>
		</div>
		<p class="ios-footnote">Downloads are kept inside mewsik and play without a connection.</p>
	</section>

	<section>
		<p class="ios-caption">Search shows first</p>
		<div class="ios-group">
			{#each sources as source (source.id)}
				<button class="ios-row" onclick={() => (search.source = source.id)}>
					<span class="flex-1">
						<span class="block">{source.label}</span>
						<span class="block text-[13px] text-muted-foreground">{source.note}</span>
					</span>
					{#if search.source === source.id}
						<Check class="size-5 text-primary" />
					{/if}
				</button>
			{/each}
		</div>
		<p class="ios-footnote">You can switch any time at the top of Search.</p>
	</section>

	<section>
		<p class="ios-caption">About</p>
		<div class="ios-group">
			<div class="ios-row">
				<span class="flex-1">Version</span>
				<span class="text-muted-foreground tabular-nums">{updater.currentVersion}</span>
			</div>
			{#if updater.viaTestFlight && updater.availableUpdate}
				<button class="ios-row" onclick={() => updater.openTestFlight()}>
					<span class="flex-1">Update to {updater.availableUpdate.version}</span>
					<span class="text-muted-foreground">TestFlight</span>
					<ArrowUpRight class="size-4 text-primary" />
				</button>
			{/if}
			<button class="ios-row" onclick={saveLog} disabled={savingLog} data-testid="save-log">
				<FileText class="size-5 text-primary" />
				<span class="flex-1 text-left">Save log file</span>
				{#if savingLog}<LoaderCircle class="size-4 animate-spin text-muted-foreground" />{/if}
			</button>
		</div>
		<p class="ios-footnote">Something not working? Save the log, then send it from Files → On My iPhone → mewsik. It stays on your phone until you send it.</p>
	</section>
</div>
