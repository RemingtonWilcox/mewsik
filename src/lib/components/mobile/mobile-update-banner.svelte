<script lang="ts">
	// A newer build is out: point at TestFlight, which installs it (the phone
	// can't update itself). Shows once per launch until dismissed.
	import { useAppUpdater } from '$lib/state/app-updater.svelte';
	import { ArrowUpRight, X } from '@lucide/svelte';

	const updater = useAppUpdater();
</script>

{#if updater.viaTestFlight && updater.showNotice && updater.availableUpdate}
	<div
		data-testid="testflight-update-banner"
		class="mb-3 flex items-center gap-3 rounded-2xl border border-primary/25 bg-primary/10 py-2.5 pl-4 pr-2"
	>
		<button class="flex min-w-0 flex-1 items-center gap-2 text-left" onclick={() => updater.openTestFlight()}>
			<span class="min-w-0 flex-1">
				<span class="block text-[15px] font-semibold">mewsik {updater.availableUpdate.version} is out</span>
				<span class="block text-[13px] text-muted-foreground">Update in TestFlight</span>
			</span>
			<ArrowUpRight class="size-5 shrink-0 text-primary" />
		</button>
		<button
			class="rounded-full p-2 text-muted-foreground"
			onclick={() => updater.dismissNotice()}
			aria-label="Dismiss update notice"
		>
			<X class="size-4" />
		</button>
	</div>
{/if}
