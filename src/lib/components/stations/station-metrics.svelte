<script lang="ts">
	import type { RadioBrowserStation, RadioStationSort } from '$lib/api/tauri';
	import { formatStationMetric } from '$lib/radio/signals';
	import { Activity, Gauge, ThumbsUp, TrendingDown, TrendingUp } from '@lucide/svelte';

	let {
		station,
		metric = 'smart',
		className = ''
	}: {
		station: RadioBrowserStation;
		metric?: RadioStationSort;
		className?: string;
	} = $props();

	const starts = $derived(station.clickcount ?? null);
	const votes = $derived(station.votes ?? null);
	const trend = $derived(station.clicktrend ?? null);
	const bitrate = $derived(station.bitrate ?? null);
	const hasMetric = $derived(
		metric === 'rising'
			? trend !== null
			: metric === 'loved'
				? votes !== null
				: metric === 'quality'
					? bitrate !== null && bitrate > 0
					: starts !== null
	);
</script>

{#if hasMetric}
	<div class={`text-[10px] leading-4 text-muted-foreground ${className}`}>
		{#if metric === 'rising' && trend !== null}
			<span
				class={`inline-flex items-center gap-1 ${trend > 0 ? 'text-emerald-500/90' : trend < 0 ? 'text-amber-500/90' : ''}`}
				title="Change in Radio Browser starts versus the previous day"
			>
				{#if trend > 0}<TrendingUp class="size-3" />{:else if trend < 0}<TrendingDown class="size-3" />{:else}<Activity class="size-3" />{/if}
				{trend > 0 ? '+' : trend < 0 ? '−' : ''}{formatStationMetric(Math.abs(trend))} since yesterday
			</span>
		{:else if metric === 'loved' && votes !== null}
			<span class="inline-flex items-center gap-1" title="Cumulative community votes in Radio Browser">
				<ThumbsUp class="size-3" />
				{formatStationMetric(votes)} votes
			</span>
		{:else if metric === 'quality' && bitrate !== null}
			<span class="inline-flex items-center gap-1" title="Stream bitrate reported by Radio Browser">
				<Gauge class="size-3" />
				{formatStationMetric(bitrate)} kbps
			</span>
		{:else if starts !== null}
			<span
				class="inline-flex items-center gap-1"
				title={metric === 'smart'
					? 'Starts in the last 24 hours; Smart order also considers momentum, votes, and bitrate'
					: 'Radio Browser starts during the last 24 hours — not current listeners'}
			>
				<Activity class="size-3" />
				{formatStationMetric(starts)} starts today
			</span>
		{/if}
	</div>
{/if}
