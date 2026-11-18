<script lang="ts">
	import { page } from '$app/state';
	import { Radio, Library, Search } from '@lucide/svelte';

	type Tab = {
		label: string;
		href: string;
		icon: typeof Radio;
		match: (path: string) => boolean;
	};

	// Settings lives behind the gear on the Library page, like most iPhone
	// music apps; it isn't somewhere you go every day.
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
			match: (p) =>
				p === '/' ||
				['/library', '/playlists', '/albums', '/artists', '/heard', '/downloads', '/settings'].some(
					(root) => p.startsWith(root)
				)
		},
		{ label: 'Search', href: '/search', icon: Search, match: (p) => p.startsWith('/search') }
	];
</script>

<nav class="flex w-full">
	{#each tabs as tab (tab.href)}
		{@const active = tab.match(page.url.pathname)}
		<a
			href={tab.href}
			class="flex h-[50px] flex-1 flex-col items-center justify-center gap-[3px] text-[10px] font-medium tracking-tight transition-colors {active
				? 'text-primary'
				: 'text-muted-foreground'}"
			aria-label={tab.label}
			aria-current={active ? 'page' : undefined}
		>
			<tab.icon class="size-[25px]" strokeWidth={active ? 2.3 : 1.8} />
			<span class="leading-none">{tab.label}</span>
		</a>
	{/each}
</nav>
