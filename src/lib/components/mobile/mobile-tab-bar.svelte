<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Radio, Library, Search, Settings } from '@lucide/svelte';

	type Tab = {
		label: string;
		href: string;
		icon: typeof Radio;
		match: (path: string) => boolean;
	};

	const tabs: Tab[] = [
		{
			label: 'Stations',
			href: '/stations',
			icon: Radio,
			match: (p) => p.startsWith('/stations')
		},
		{
			label: 'Library',
			href: '/library',
			icon: Library,
			match: (p) => p === '/library' || p === '/' || p.startsWith('/playlists')
		},
		{ label: 'Search', href: '/search', icon: Search, match: (p) => p.startsWith('/search') },
		{
			label: 'Settings',
			href: '/settings',
			icon: Settings,
			match: (p) => p.startsWith('/settings')
		}
	];
</script>

<nav class="flex w-full">
	{#each tabs as tab}
		{@const active = tab.match(page.url.pathname)}
		<button
			class="flex flex-1 flex-col items-center justify-center gap-1 py-1.5 text-[10px] font-medium transition-colors {active
				? 'text-primary'
				: 'text-muted-foreground hover:text-foreground'}"
			onclick={() => goto(tab.href)}
			aria-label={tab.label}
			aria-current={active ? 'page' : undefined}
		>
			<tab.icon class="size-6" strokeWidth={active ? 2.4 : 2} />
			<span class="leading-none">{tab.label}</span>
		</button>
	{/each}
</nav>
