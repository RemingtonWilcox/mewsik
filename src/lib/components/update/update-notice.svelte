<script lang="ts">
	import { useAppUpdater } from '$lib/state/app-updater.svelte';
	import { Button } from '$lib/components/ui/button';
	import { page } from '$app/state';
	import { ArrowUpRight, Sparkles, X } from '@lucide/svelte';

	const updater = useAppUpdater();
	const settingsOpen = $derived(page.url.pathname === '/settings');
</script>

{#if updater.showNotice && updater.availableUpdate && !settingsOpen}
	<aside
		data-testid="update-available-notice"
		aria-label="Update available"
		class="fixed right-4 top-4 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-primary/25 bg-card/95 p-4 shadow-xl backdrop-blur"
	>
		<div class="flex items-start gap-3">
			<div class="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
				<Sparkles class="size-4" />
			</div>
			<div class="min-w-0 flex-1">
				<p class="text-sm font-semibold">mewsik {updater.availableUpdate.version} is ready</p>
				<p class="mt-1 text-xs leading-relaxed text-muted-foreground">
					Your current version keeps working until you choose to update.
				</p>
				<Button class="mt-3" size="sm" href="/settings#app-updates">
					Review update <ArrowUpRight class="size-3.5" />
				</Button>
			</div>
			<button
				type="button"
				class="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
				onclick={() => updater.dismissNotice()}
				aria-label="Dismiss update notice"
			>
				<X class="size-4" />
			</button>
		</div>
	</aside>
{/if}
