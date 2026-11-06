<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	// The library is home.
	onMount(() => void goto('/library', { replaceState: true }));
</script>
