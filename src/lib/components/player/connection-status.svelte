<script lang="ts">
	import type { PlaybackState } from '$lib/types';
	import { connectionMessage, connectionStage, isConnecting } from '$lib/state/player.svelte';
	import { RotateCw } from '@lucide/svelte';

	// What the stream is doing, in words: "Connecting to Radio X…",
	// "Buffering…", "Reconnecting · attempt 2 of 3", or "Couldn't connect"
	// with Retry. Live radio that is flowing shows a quiet LIVE mark.
	let {
		playback,
		onRetry,
		long = false,
		class: className = ''
	}: {
		playback: PlaybackState;
		onRetry?: () => void;
		/** Name the station while connecting. */
		long?: boolean;
		class?: string;
	} = $props();

	const stage = $derived(connectionStage(playback));
	const message = $derived(connectionMessage(playback, long));
	const waiting = $derived(isConnecting(stage));
	const live = $derived(playback.source === 'radio' && stage === 'playing');
</script>

<div
	class="flex min-w-0 items-center gap-2 {className}"
	data-connection-stage={stage}
	role="status"
	aria-live="polite"
>
	{#if waiting}
		<span class="flex shrink-0 items-end gap-[3px]" aria-hidden="true">
			{#each [0, 1, 2] as bar (bar)}
				<span
					class="connection-bar block w-[3px] rounded-full bg-current opacity-70"
					style:animation-delay={`${bar * 160}ms`}
				></span>
			{/each}
		</span>
		<span class="truncate">{message}</span>
	{:else if stage === 'failed'}
		<span class="truncate" title={playback.connection_error ?? undefined}>{message}</span>
		{#if onRetry}
			<button
				type="button"
				class="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-[11px] font-medium normal-case tracking-normal text-foreground transition-colors hover:bg-muted active:bg-muted/60"
				onclick={(event) => {
					event.stopPropagation();
					onRetry?.();
				}}
			>
				<RotateCw class="size-3" />
				Retry
			</button>
		{/if}
	{:else if live}
		<span class="size-1.5 shrink-0 rounded-full bg-red-500" aria-hidden="true"></span>
		<span class="truncate">Live</span>
	{/if}
</div>

<style>
	.connection-bar {
		height: 10px;
		transform-origin: bottom;
		animation: connection-bar 1.1s ease-in-out infinite;
	}

	@keyframes connection-bar {
		0%,
		100% {
			transform: scaleY(0.35);
		}
		50% {
			transform: scaleY(1);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.connection-bar {
			animation: none;
			transform: scaleY(0.6);
		}
	}
</style>
