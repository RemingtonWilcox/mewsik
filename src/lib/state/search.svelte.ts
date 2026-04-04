// Persistent search state — survives navigation between pages
let _query = $state('');
let _results: any[] = $state([]);
let _sourcePreference = $state<string>('all');

export function useSearchState() {
	return {
		get query() { return _query; },
		set query(v: string) { _query = v; },
		get results() { return _results; },
		set results(v: any[]) { _results = v; },
		get sourcePreference() { return _sourcePreference; },
		set sourcePreference(v: string) { _sourcePreference = v; },
	};
}
