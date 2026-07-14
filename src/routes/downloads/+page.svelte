<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Download,
		RefreshCw,
		CheckCircle2,
		AlertCircle,
		LoaderCircle,
		FolderOpen,
		RotateCcw,
		CircleSlash,
		Trash2
	} from '@lucide/svelte';
	import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as api from '$lib/api/tauri';
	import type { Download as DownloadItem } from '$lib/types';
	import { toast } from 'svelte-sonner';

	let downloads = $state<DownloadItem[]>([]);
	let downloadLocation = $state<api.DownloadLocationInfo | null>(null);
	let loading = $state(true);
	// This is deliberately not reactive. A reactive in-flight guard read from a
	// $effect can retrigger that effect on every request and create a fetch loop.
	let polling = false;
	let refreshingFiles = $state(false);
	let actioning = $state<Record<string, boolean>>({});

	onMount(() => {
		// Page entry and recurring polling are DB-only. Filesystem/network health
		// checks are explicit so an offline UNC path cannot stall route loading.
		void loadDownloads();
		void loadDownloadLocation();
		const interval = setInterval(() => void loadDownloads(), 1500);
		return () => clearInterval(interval);
	});

	async function loadDownloads() {
		if (polling) return;
		polling = true;
		try {
			downloads = await api.getDownloads();
		} finally {
			polling = false;
			loading = false;
		}
	}

	async function refreshDownloadFiles(announce = true) {
		if (refreshingFiles) return;
		refreshingFiles = true;
		try {
			downloads = await api.refreshDownloadFiles();
			await loadDownloadLocation();
			if (announce) toast.success('Downloaded files checked');
		} catch (error) {
			if (announce) toast.error(`Could not check downloaded files: ${error}`);
		} finally {
			refreshingFiles = false;
			loading = false;
		}
	}

	async function loadDownloadLocation() {
		try {
			downloadLocation = await api.getDownloadLocation();
		} catch {
			downloadLocation = null;
		}
	}

	function progressLabel(progress: number): string {
		return `${Math.round(progress)}%`;
	}

	function sourceLabel(item: DownloadItem): string {
		return item.source;
	}

	async function openDownload(downloadId: string) {
		if (actioning[downloadId]) return;
		actioning = { ...actioning, [downloadId]: true };
		try {
			await api.revealDownloadPath(downloadId);
		} catch (e) {
			toast.error(`Failed to reveal download: ${e}`);
			await refreshDownloadFiles(false);
		} finally {
			const { [downloadId]: _removed, ...rest } = actioning;
			actioning = rest;
		}
	}

	async function retryDownload(item: DownloadItem) {
		if (!item.recording_id || actioning[item.id]) return;
		actioning = { ...actioning, [item.id]: true };
		try {
			const started = await api.downloadRecording(item.recording_id);
			if (started.already_active || !started.directory) {
				toast.message('Download is already queued');
			} else {
				toast.success(`Download queued again · Saving to ${started.directory}`);
			}
			await loadDownloads();
		} catch (e) {
			toast.error(`Failed to retry download: ${e}`);
		} finally {
			const { [item.id]: _removed, ...rest } = actioning;
			actioning = rest;
		}
	}

	async function cancelDownload(item: DownloadItem) {
		if (actioning[item.id]) return;
		actioning = { ...actioning, [item.id]: true };
		try {
			await api.cancelDownload(item.id);
			toast.success('Download cancelled');
			await loadDownloads();
		} catch (e) {
			toast.error(`Failed to cancel download: ${e}`);
		} finally {
			const { [item.id]: _removed, ...rest } = actioning;
			actioning = rest;
		}
	}

	async function deleteDownloadItem(item: DownloadItem) {
		if (actioning[item.id]) return;
		actioning = { ...actioning, [item.id]: true };
		try {
			await api.deleteDownload(item.id);
			toast.success('Download removed');
			await loadDownloads();
		} catch (e) {
			toast.error(`Failed to delete download: ${e}`);
		} finally {
			const { [item.id]: _removed, ...rest } = actioning;
			actioning = rest;
		}
	}
</script>

<div class="flex flex-col gap-4">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold">Downloads</h1>
			<p class="text-sm text-muted-foreground">Saved tracks and active download jobs.</p>
		</div>
		<Button
			variant="outline"
			size="sm"
			onclick={() => void refreshDownloadFiles()}
			disabled={refreshingFiles}
		>
			<RefreshCw class={`mr-1 size-4 ${refreshingFiles ? 'animate-spin' : ''}`} />
			{refreshingFiles ? 'Checking…' : 'Check files'}
		</Button>
	</div>

	{#if downloadLocation}
		<div class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs">
			<FolderOpen class="size-3.5 shrink-0 text-primary" />
			<span class="text-muted-foreground">New downloads save to</span>
			<span class="min-w-0 flex-1 truncate font-mono" title={downloadLocation.directory}>{downloadLocation.directory}</span>
			<a href="/settings" class="font-medium text-primary hover:underline">Change</a>
		</div>
	{/if}

	{#if loading}
		<Card class="border-dashed">
			<CardContent class="flex flex-col items-center gap-4 py-12">
				<LoaderCircle class="size-12 animate-spin text-muted-foreground" />
				<p class="text-sm text-muted-foreground">Loading downloads...</p>
			</CardContent>
		</Card>
	{:else if downloads.length === 0}
		<Card class="border-dashed">
			<CardContent class="flex flex-col items-center gap-4 py-12">
				<Download class="size-12 text-muted-foreground" />
				<div class="text-center">
					<h3 class="font-semibold">No Downloads Yet</h3>
					<p class="text-sm text-muted-foreground">
						Queue a download from external search results and it will appear here.
					</p>
				</div>
			</CardContent>
		</Card>
	{:else}
		<div class="flex flex-col gap-2">
			{#each downloads as item}
				{@const fileName = item.file_path?.split(/[\\/]/).pop() ?? 'Preparing file'}
				{@const isActive = item.status === 'pending' || item.status === 'downloading' || item.status === 'processing'}
				{@const isDone = item.status === 'completed'}
				{@const isFailed = item.status === 'failed' || item.status === 'cancelled' || item.status === 'missing'}
				<div class="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
					<!-- Status icon -->
					<div class="shrink-0">
						{#if isDone}
							<CheckCircle2 class="size-5 text-primary" />
						{:else if isFailed}
							<AlertCircle class="size-5 text-destructive" />
						{:else}
							<LoaderCircle class="size-5 animate-spin text-muted-foreground" />
						{/if}
					</div>

					<!-- Title + progress -->
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm font-medium">{fileName}</p>
						{#if isActive}
							<div class="mt-1.5 flex items-center gap-2">
								<div class="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
									<div
										class="h-full bg-primary transition-all"
										style={`width: ${Math.max(0, Math.min(100, item.progress))}%`}
									></div>
								</div>
								<span class="text-xs text-muted-foreground">{progressLabel(item.progress)}</span>
							</div>
						{/if}
						{#if isFailed && item.error_message}
							<p class="mt-1 truncate text-xs text-destructive">{item.error_message}</p>
						{/if}
					</div>

					<!-- Actions -->
					<div class="flex shrink-0 items-center gap-1">
						{#if isDone && item.file_path}
							<Button
								variant="ghost"
								size="sm"
								disabled={Boolean(actioning[item.id])}
								onclick={() => openDownload(item.id)}
							>
								<FolderOpen class="mr-1 size-4" />
								Show in folder
							</Button>
						{/if}
						{#if isActive}
							<Button
								variant="ghost"
								size="icon"
								class="size-8"
								aria-label="Cancel download"
								title="Cancel download"
								disabled={Boolean(actioning[item.id])}
								onclick={() => cancelDownload(item)}
							>
								<CircleSlash class="size-4" />
							</Button>
						{/if}
						{#if isFailed && item.recording_id}
							<Button
								variant="ghost"
								size="icon"
								class="size-8"
								aria-label="Retry download"
								title="Retry download"
								disabled={Boolean(actioning[item.id])}
								onclick={() => retryDownload(item)}
							>
								<RotateCcw class="size-4" />
							</Button>
						{/if}
						{#if !isActive}
							<Button
								variant="ghost"
								size="icon"
								class="size-8 text-destructive hover:text-destructive"
								aria-label="Remove download"
								title="Remove download"
								disabled={Boolean(actioning[item.id])}
								onclick={() => deleteDownloadItem(item)}
							>
								<Trash2 class="size-4" />
							</Button>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
