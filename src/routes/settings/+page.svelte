<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '$lib/components/ui/card';
	import { Separator } from '$lib/components/ui/separator';
	import * as api from '$lib/api/tauri';
	import { useLibrary } from '$lib/state/library.svelte';
	import { toast } from 'svelte-sonner';
	import { FolderOpen, RefreshCw, Plus, X, Sun, Moon, RadioTower, Play, Square } from '@lucide/svelte';
	import { toggleMode } from 'mode-watcher';

	const library = useLibrary();

	let libraryPaths = $state<string[]>([]);
	let newPath = $state('');
	let loading = $state(false);
	let sidecarRunning = $state(false);
	let sidecarLoading = $state(false);
	let settingsError = $state('');

	$effect(() => {
		loadSettings();
	});

	async function loadSettings() {
		try {
			const [paths, running] = await Promise.all([
				api.getLibraryPaths(),
				api.sidecarStatus().catch(() => false)
			]);
			libraryPaths = paths;
			sidecarRunning = running;
			settingsError = '';
		} catch (error) {
			settingsError = `Failed to load settings${error ? `: ${error}` : ''}`;
			toast.error(settingsError);
		}
	}

	async function addResolvedPath(path: string) {
		const trimmedPath = path.trim();
		if (!trimmedPath) return;
		if (libraryPaths.includes(trimmedPath)) {
			toast.message('That folder is already in your library');
			newPath = '';
			return;
		}

		const updated = [...libraryPaths, trimmedPath];
		try {
			await api.updateLibraryPaths(updated);
			libraryPaths = updated;
			newPath = '';
			settingsError = '';
			toast.success('Library path added');
		} catch (e) {
			toast.error(`Failed to add path: ${e}`);
		}
	}

	async function addPath() {
		await addResolvedPath(newPath);
	}

	async function browseForFolder() {
		try {
			const path = await api.pickFolder(newPath.trim() || libraryPaths.at(-1));
			if (!path) return;
			newPath = path;
			await addResolvedPath(path);
		} catch (error) {
			toast.error(`Failed to browse for a folder: ${error}`);
		}
	}

	async function removePath(index: number) {
		const updated = libraryPaths.filter((_, i) => i !== index);
		try {
			await api.updateLibraryPaths(updated);
			libraryPaths = updated;
			settingsError = '';
			toast.success('Library path removed');
		} catch {
			toast.error('Failed to remove path');
		}
	}

	async function scanAll() {
		if (libraryPaths.length === 0) {
			toast.error('Add a music folder first');
			return;
		}
		loading = true;
		try {
			for (const path of libraryPaths) {
				const result = await library.scan(path);
				toast.success(`Scanned: ${result.new_tracks} new, ${result.updated_tracks} updated`);
			}
		} catch (e) {
			toast.error(`Scan failed: ${e}`);
		} finally {
			loading = false;
		}
	}

	async function startSidecar() {
		sidecarLoading = true;
		try {
			await api.startSidecar();
			sidecarRunning = true;
			toast.success('External provider sidecar started');
		} catch (e) {
			toast.error(`Failed to start sidecar: ${e}`);
		} finally {
			sidecarLoading = false;
		}
	}

	async function stopSidecar() {
		sidecarLoading = true;
		try {
			await api.stopSidecar();
			sidecarRunning = false;
			toast.success('External provider sidecar stopped');
		} catch (e) {
			toast.error(`Failed to stop sidecar: ${e}`);
		} finally {
			sidecarLoading = false;
		}
	}
</script>

<div class="flex max-w-2xl flex-col gap-6">
	<h1 class="text-2xl font-bold">Settings</h1>

	{#if settingsError}
		<p class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{settingsError}
		</p>
	{/if}

	<Card>
		<CardHeader>
			<CardTitle>Music Library</CardTitle>
			<CardDescription>Add folders containing your local music files, then scan to import them.</CardDescription>
		</CardHeader>
		<CardContent class="flex flex-col gap-4">
			{#if libraryPaths.length > 0}
				{#each libraryPaths as path, i}
					<div class="flex items-center gap-2 rounded-md border border-border p-2">
						<FolderOpen class="size-4 shrink-0 text-muted-foreground" />
						<span class="flex-1 truncate text-sm font-mono">{path}</span>
						<Button variant="ghost" size="icon" class="size-7 shrink-0" onclick={() => removePath(i)}>
							<X class="size-4" />
						</Button>
					</div>
				{/each}
			{:else}
				<p class="text-sm text-muted-foreground">No library folders added yet.</p>
			{/if}

			<div class="flex flex-wrap gap-2">
				<Input
					placeholder="/Users/remington/Music"
					class="min-w-[16rem] flex-1"
					bind:value={newPath}
					onkeydown={(e) => { if (e.key === 'Enter') addPath(); }}
				/>
				<Button variant="outline" onclick={browseForFolder}>
					<FolderOpen class="mr-1 size-4" />
					Browse
				</Button>
				<Button variant="outline" onclick={addPath} disabled={!newPath.trim()}>
					<Plus class="mr-1 size-4" />
					Add
				</Button>
			</div>

			<Separator />

			<Button onclick={scanAll} disabled={loading || libraryPaths.length === 0} class="w-fit">
				{#if loading}
					<RefreshCw class="mr-2 size-4 animate-spin" />
					Scanning...
				{:else}
					<RefreshCw class="mr-2 size-4" />
					Scan Library
				{/if}
			</Button>
		</CardContent>
	</Card>

	<Card>
		<CardHeader>
			<CardTitle>External Providers</CardTitle>
			<CardDescription>Manage the local sidecar used for YouTube, SoundCloud, and Bandcamp search/stream resolution.</CardDescription>
		</CardHeader>
		<CardContent class="flex items-center justify-between gap-4">
			<div class="flex items-center gap-3">
				<div class={`flex size-10 items-center justify-center rounded-full ${sidecarRunning ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground'}`}>
					<RadioTower class="size-5" />
				</div>
				<div>
					<p class="text-sm font-medium">Provider sidecar</p>
					<p class="text-xs text-muted-foreground">
						{sidecarRunning ? 'Running and ready for external search' : 'Stopped. External search and streaming will not work.'}
					</p>
				</div>
			</div>
			{#if sidecarRunning}
				<Button variant="outline" size="sm" onclick={stopSidecar} disabled={sidecarLoading}>
					<Square class="mr-1 size-4" />
					Stop
				</Button>
			{:else}
				<Button size="sm" onclick={startSidecar} disabled={sidecarLoading}>
					<Play class="mr-1 size-4" />
					Start
				</Button>
			{/if}
		</CardContent>
	</Card>

	<Card>
		<CardHeader>
			<CardTitle>Appearance</CardTitle>
			<CardDescription>Customize the look of mewsik.</CardDescription>
		</CardHeader>
		<CardContent>
			<div class="flex items-center justify-between">
				<div>
					<p class="text-sm font-medium">Theme</p>
					<p class="text-xs text-muted-foreground">Toggle between dark and light mode</p>
				</div>
				<Button variant="outline" size="sm" onclick={() => toggleMode()}>
					<Sun class="mr-1 size-4 dark:hidden" />
					<Moon class="mr-1 hidden size-4 dark:block" />
					Toggle Theme
				</Button>
			</div>
		</CardContent>
	</Card>
</div>
