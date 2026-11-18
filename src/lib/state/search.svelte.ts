import type { ExternalSearchResult } from '$lib/api/tauri';

export type SearchSource = 'soundcloud' | 'youtube';

const SOURCE_KEY = 'mewsik.search.source';

function storedSource(): SearchSource {
	try {
		const value = localStorage.getItem(SOURCE_KEY);
		if (value === 'youtube' || value === 'soundcloud') return value;
	} catch {
		// No storage (private mode, tests): use the default.
	}
	return 'soundcloud';
}

// Kept across page changes so going back to Search shows the last results.
let query = $state('');
let online = $state<ExternalSearchResult[]>([]);
let onlineQuery = $state('');
let source = $state<SearchSource>(typeof window === 'undefined' ? 'soundcloud' : storedSource());

export function useSearchState() {
	return {
		get query() {
			return query;
		},
		set query(value: string) {
			query = value;
		},
		get online() {
			return online;
		},
		set online(value: ExternalSearchResult[]) {
			online = value;
		},
		/** The query `online` belongs to. */
		get onlineQuery() {
			return onlineQuery;
		},
		set onlineQuery(value: string) {
			onlineQuery = value;
		},
		/** Which provider's online results Search shows. Both are searched. */
		get source() {
			return source;
		},
		set source(value: SearchSource) {
			source = value;
			try {
				localStorage.setItem(SOURCE_KEY, value);
			} catch {
				// Not remembered; still applies for this session.
			}
		}
	};
}
