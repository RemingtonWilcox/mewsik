import type { ExternalSearchResult } from '$lib/api/tauri';

// Kept across page changes so going back to Search shows the last results.
let query = $state('');
let online = $state<ExternalSearchResult[]>([]);
let onlineQuery = $state('');

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
		}
	};
}
