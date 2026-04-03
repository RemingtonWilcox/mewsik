<script lang="ts">
	interface Props {
		source: string;
		class?: string;
		size?: number;
	}

	let { source, class: className = '', size = 16 }: Props = $props();
</script>

{#if source === 'youtube'}
	<svg width={size} height={size} viewBox="0 0 24 24" fill="none" class={className}>
		<path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31.5 31.5 0 0 0 0 12a31.5 31.5 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31.5 31.5 0 0 0 24 12a31.5 31.5 0 0 0-.5-5.8zM9.6 15.6V8.4l6.3 3.6-6.3 3.6z" fill="#FF0000"/>
	</svg>
{:else if source === 'soundcloud'}
	<svg width={size} height={size} viewBox="0 0 24 24" fill="none" class={className}>
		<path d="M1.2 14.4c-.1 0-.2-.1-.2-.2v-2.6c0-.1.1-.2.2-.2s.2.1.2.2v2.6c0 .1-.1.2-.2.2zm1.3.7c-.1 0-.2-.1-.2-.2V10.8c0-.1.1-.2.2-.2s.2.1.2.2v4.1c0 .1-.1.2-.2.2zm1.3.2c-.1 0-.2-.1-.2-.2V10c0-.1.1-.2.2-.2s.2.1.2.2v5.1c0 .1-.1.2-.2.2zm1.3.1c-.1 0-.2-.1-.2-.2V9.4c0-.1.1-.2.2-.2s.2.1.2.2v5.8c0 .1-.1.2-.2.2zm1.3-.1c-.1 0-.2-.1-.2-.2V9.8c0-.1.1-.2.2-.2s.2.1.2.2v5.1c0 .2-.1.2-.2.2zm1.3.1c-.1 0-.2-.1-.2-.2V8.6c0-.1.1-.2.2-.2s.2.1.2.2v6.6c0 .1-.1.2-.2.2zm1.3-.2c-.1 0-.2-.1-.2-.2V8.2c0-.1.1-.2.2-.2s.2.1.2.2v6.8c0 .1-.1.2-.2.2zm1.5.2c-.1 0-.2-.1-.2-.2V7.2c0-.1.1-.2.2-.2s.2.1.2.2v8c0 .1-.1.2-.2.2zm1.3-.2c-.1 0-.2-.1-.2-.2V6c0-.1.1-.2.2-.2s.2.1.2.2v9c0 .1-.1.2-.2.2zm5.8.2h-4.1c-.1 0-.2-.1-.2-.2V5.4c0-.1.1-.2.2-.2a5.2 5.2 0 0 1 5.2 4.5 2.8 2.8 0 0 1-.5 5.6h-.6z" fill="#FF5500"/>
	</svg>
{:else if source === 'bandcamp'}
	<svg width={size} height={size} viewBox="0 0 24 24" fill="none" class={className}>
		<path d="M0 18h13.7L24 6H10.3L0 18z" fill="#629aa9"/>
	</svg>
{:else if source === 'jamendo'}
	<svg width={size} height={size} viewBox="0 0 24 24" fill="none" class={className}>
		<circle cx="12" cy="12" r="10" fill="#F59E0B"/>
		<circle cx="12" cy="12" r="4" fill="#111"/>
	</svg>
{:else}
	<span class="inline-block size-4 rounded-full bg-muted-foreground/30" title={source}></span>
{/if}
