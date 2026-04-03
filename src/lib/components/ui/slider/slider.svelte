<script lang="ts">
	import { Slider as SliderPrimitive } from "bits-ui";
	import type { SliderMultipleRootProps } from "bits-ui";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";

	type SliderProps = Omit<WithoutChildrenOrChild<SliderMultipleRootProps>, "type" | "value"> & {
		type?: "multiple";
		value?: number[];
		ref?: HTMLElement | null;
	};

	let {
		ref = $bindable(null),
		value = $bindable<number[]>([]),
		type = "multiple",
		orientation = "horizontal",
		class: className,
		...restProps
	}: SliderProps = $props();
</script>

<!--
Discriminated Unions + Destructing (required for bindable) do not
get along, so we shut typescript up by casting `value` to `never`.
-->
<SliderPrimitive.Root
	bind:ref
	bind:value={value as never}
	data-slot="slider"
	{type}
	{orientation}
	class={cn(
		"data-vertical:min-h-40 relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:w-auto data-vertical:flex-col",
		className
	)}
	{...restProps}
>
	{#snippet children({ thumbItems })}
		<span
			data-slot="slider-track"
			data-orientation={orientation}
			style="background-color: #4a4a5a; height: 8px; width: 100%; border-radius: 9999px; position: relative; overflow: hidden; flex-grow: 1;"
		>
			<SliderPrimitive.Range
				data-slot="slider-range"
				style="background-color: oklch(0.75 0.18 160); height: 100%; position: absolute;"
			/>
		</span>
		{#each thumbItems as thumb (thumb)}
			<SliderPrimitive.Thumb
				data-slot="slider-thumb"
				index={thumb.index}
				class="border-white/80 ring-ring/50 relative size-4 rounded-full border-2 bg-white shadow-md transition-[color,box-shadow] after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 block shrink-0 select-none disabled:pointer-events-none disabled:opacity-50"
			/>
		{/each}
	{/snippet}
</SliderPrimitive.Root>
