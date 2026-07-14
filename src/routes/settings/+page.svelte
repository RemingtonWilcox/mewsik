<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '$lib/components/ui/card';
	import * as api from '$lib/api/tauri';
	import { useLibrary } from '$lib/state/library.svelte';
	import { toast } from 'svelte-sonner';
	import {
		CheckCircle2,
		FolderOpen,
		HardDrive,
		Laptop,
		Moon,
		RefreshCw,
		Search,
		Sun,
		X
	} from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { setMode, userPrefersMode } from 'mode-watcher';

	type ThemePreference = 'light' | 'dark' | 'system';
	type ScanSummary = {
		folders: number;
		newTracks: number;
		updatedTracks: number;
		errors: string[];
	};

	const library = useLibrary();

	let libraryPaths = $state<string[]>([]);
	let loading = $state(true);
	let scanning = $state(false);
	let providerRunning = $state(false);
	let providerLoading = $state(false);
	let settingsError = $state('');
	let lastScan = $state<ScanSummary | null>(null);

	onMount(() => {
		void loadSettings();
	});

	async function loadSettings() {
		loading = true;
		try {
			const [paths, running] = await Promise.all([
				api.getLibraryPaths(),
				api.sidecarStatus().catch(() => false)
			]);
			libraryPaths = paths;
			providerRunning = running;
			await library.loadAll();
			settingsError = '';
		} catch (error) {
			settingsError = `Could not load settings${error ? `: ${error}` : ''}`;
		} finally {
			loading = false;
		}
	}

	async function browseForFolder() {
		try {
			const path = await api.pickFolder(libraryPaths.at(-1));
			if (!path) return;
			if (libraryPaths.includes(path)) {
				toast.message('That folder is already in your library');
				return;
			}

			const updated = [...libraryPaths, path];
			await api.updateLibraryPaths(updated);
			libraryPaths = updated;
			settingsError = '';
			toast.success('Music folder added');
		} catch (error) {
			toast.error(`Could not add folder: ${error}`);
		}
	}

	async function removePath(index: number) {
		const updated = libraryPaths.filter((_, pathIndex) => pathIndex !== index);
		try {
			await api.updateLibraryPaths(updated);
			libraryPaths = updated;
			settingsError = '';
			toast.success('Folder removed from future scans');
		} catch (error) {
			toast.error(`Could not remove folder: ${error}`);
		}
	}

	async function scanAll() {
		if (libraryPaths.length === 0 || scanning) return;

		scanning = true;
		const summary: ScanSummary = {
			folders: 0,
			newTracks: 0,
			updatedTracks: 0,
			errors: []
		};

		for (const path of libraryPaths) {
			try {
				const result = await api.scanLibrary(path);
				summary.folders += 1;
				summary.newTracks += result.new_tracks;
				summary.updatedTracks += result.updated_tracks;
				summary.errors.push(...result.errors.map((error) => `${path}: ${error}`));
			} catch (error) {
				summary.errors.push(`${path}: ${error}`);
			}
		}

		try {
			await library.loadAll();
			lastScan = summary;
			if (summary.errors.length > 0) {
				toast.warning(`Scan finished with ${summary.errors.length} issue${summary.errors.length === 1 ? '' : 's'}`);
			} else {
				toast.success(`Library updated: ${summary.newTracks} new, ${summary.updatedTracks} changed`);
			}
		} finally {
			scanning = false;
		}
	}

	async function restartProviders() {
		if (providerLoading) return;
		providerLoading = true;
		try {
			await api.stopSidecar();
			await api.startSidecar();
			providerRunning = true;
			toast.success('Search providers restarted');
		} catch (error) {
			providerRunning = false;
			toast.error(`Could not restart search providers: ${error}`);
		} finally {
			providerLoading = false;
		}
	}

	function chooseTheme(preference: ThemePreference) {
		setMode(preference);
	}
</script>

<div class="flex max-w-3xl flex-col gap-6 pb-8">
	<div>
		<h1 class="text-2xl font-bold">Settings</h1>
		<p class="mt-1 text-sm text-muted-foreground">Your library, appearance, and a small set of useful repair tools.</p>
	</div>

	{#if settingsError}
		<p class="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{settingsError}
		</p>
	{/if}

	<Card>
		<CardHeader class="gap-1">
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div>
					<CardTitle>Music library</CardTitle>
					<CardDescription class="mt-1">Choose folders once, then rescan whenever the files on disk change.</CardDescription>
				</div>
				<Button variant="outline" size="sm" onclick={browseForFolder} disabled={loading}>
					<FolderOpen class="size-4" /> Add folder
				</Button>
			</div>
		</CardHeader>
		<CardContent class="flex flex-col gap-4">
			<div class="grid grid-cols-3 gap-2 rounded-xl border border-border/70 bg-muted/20 p-3 text-center">
				<div>
					<p class="text-lg font-semibold tabular-nums">{library.tracks.length}</p>
					<p class="text-[11px] text-muted-foreground">Tracks</p>
				</div>
				<div class="border-x border-border/60">
					<p class="text-lg font-semibold tabular-nums">{library.artists.length}</p>
					<p class="text-[11px] text-muted-foreground">Artists</p>
				</div>
				<div>
					<p class="text-lg font-semibold tabular-nums">{library.albums.length}</p>
					<p class="text-[11px] text-muted-foreground">Albums</p>
				</div>
			</div>

			{#if loading}
				<div class="h-14 animate-pulse rounded-lg bg-muted"></div>
			{:else if libraryPaths.length > 0}
				<div class="space-y-2">
					{#each libraryPaths as path, index}
						<div class="flex items-center gap-3 rounded-lg border border-border/70 px-3 py-2.5">
							<div class="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
								<HardDrive class="size-4" />
							</div>
							<span class="min-w-0 flex-1 truncate font-mono text-xs" title={path}>{path}</span>
							<Button
								variant="ghost"
								size="icon-sm"
								class="shrink-0 text-muted-foreground"
								onclick={() => removePath(index)}
								aria-label={`Stop scanning ${path}`}
							>
								<X class="size-4" />
							</Button>
						</div>
					{/each}
					<p class="px-1 text-[11px] text-muted-foreground">Removing a folder stops future scans; it does not delete imported tracks or files.</p>
				</div>
			{:else}
				<div class="rounded-xl border border-dashed border-border px-4 py-7 text-center">
					<FolderOpen class="mx-auto size-7 text-muted-foreground" />
					<p class="mt-2 text-sm font-medium">No local music folders yet</p>
					<p class="mt-1 text-xs text-muted-foreground">You can still search and stream music without one.</p>
				</div>
			{/if}

			<div class="flex flex-wrap items-center gap-3 border-t border-border/60 pt-4">
				<Button onclick={scanAll} disabled={scanning || libraryPaths.length === 0}>
					<RefreshCw class={`size-4 ${scanning ? 'animate-spin' : ''}`} />
					{scanning ? 'Scanning folders…' : 'Scan all folders'}
				</Button>
				{#if lastScan}
					<span class={`inline-flex items-center gap-1.5 text-xs ${lastScan.errors.length > 0 ? 'text-amber-500' : 'text-emerald-500'}`}>
						<CheckCircle2 class="size-3.5" />
						{lastScan.folders}/{libraryPaths.length} scanned · {lastScan.newTracks} new · {lastScan.updatedTracks} changed
					</span>
				{/if}
			</div>
		</CardContent>
	</Card>

	<Card>
		<CardHeader>
			<CardTitle>Appearance</CardTitle>
			<CardDescription>Use a fixed theme or follow Windows automatically.</CardDescription>
		</CardHeader>
		<CardContent>
			<div class="grid grid-cols-3 gap-2" role="group" aria-label="Theme">
				{#each [
					{ value: 'light' as const, label: 'Light', icon: Sun },
					{ value: 'dark' as const, label: 'Dark', icon: Moon },
					{ value: 'system' as const, label: 'System', icon: Laptop }
				] as option}
					<button
						type="button"
						class={`flex items-center justify-center gap-2 rounded-lg border px-3 py-3 text-sm transition-colors ${userPrefersMode.current === option.value ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground'}`}
						onclick={() => chooseTheme(option.value)}
						aria-pressed={userPrefersMode.current === option.value}
					>
						<option.icon class="size-4" /> {option.label}
					</button>
				{/each}
			</div>
		</CardContent>
	</Card>

	<details class="group rounded-xl border border-border bg-card">
		<summary class="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-4">
			<div>
				<p class="text-sm font-semibold">Search troubleshooting</p>
				<p class="mt-0.5 text-xs text-muted-foreground">External providers normally start by themselves. Open this only if Search gets stuck.</p>
			</div>
			<Search class={`size-4 shrink-0 ${providerRunning ? 'text-emerald-500' : 'text-muted-foreground'}`} />
		</summary>
		<div class="border-t border-border/60 px-6 py-4">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<p class="text-xs text-muted-foreground">
					{providerRunning ? 'Search providers are running.' : 'Providers are idle and will start with your next search.'}
				</p>
				<Button variant="outline" size="sm" onclick={restartProviders} disabled={providerLoading}>
					<RefreshCw class={`size-3.5 ${providerLoading ? 'animate-spin' : ''}`} />
					Restart providers
				</Button>
			</div>
		</div>
	</details>
</div>
