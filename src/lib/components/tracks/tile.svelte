<script lang="ts">
	import Cover from './cover.svelte';
	import { Play } from '@lucide/svelte';

	let {
		href,
		title,
		subtitle = '',
		cover = null,
		round = false,
		onplay
	}: {
		href: string;
		title: string;
		subtitle?: string;
		cover?: string | null;
		round?: boolean;
		onplay?: () => void;
	} = $props();
</script>

<a {href} class="tile group block rounded-lg p-2 transition-colors hover:bg-white/5">
	<div class="relative">
		<Cover
			src={cover}
			name={title}
			class="aspect-square w-full shadow-md {round ? 'rounded-full' : 'rounded-md'}"
			textClass="text-2xl"
		/>
		{#if onplay}
			<button
				class="absolute bottom-2 right-2 flex size-10 translate-y-1 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-lg transition-all hover:scale-105 group-hover:translate-y-0 group-hover:opacity-100"
				aria-label="Play {title}"
				onclick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					onplay();
				}}
			>
				<Play class="ml-0.5 size-4 fill-current" />
			</button>
		{/if}
	</div>
	<p class="mt-2 truncate text-sm font-medium" class:text-center={round} {title}>{title}</p>
	{#if subtitle}
		<p class="truncate text-xs text-muted-foreground" class:text-center={round}>{subtitle}</p>
	{/if}
</a>

<style>
	/* Off-screen tiles skip layout and paint until they scroll into view. */
	.tile {
		content-visibility: auto;
		contain-intrinsic-size: auto 15rem;
	}
</style>
