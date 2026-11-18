import { getStationLogo, type StationLogoKey } from '$lib/api/tauri';

// Station logos come from the backend cache (`get_station_logo`) as data:
// URLs. Each station is asked for at most once per session, and only a few
// requests run at a time so a long grid scrolling into view cannot flood
// the backend with favicon fetches.
const MAX_CONCURRENT = 4;

const pending = new Map<string, Promise<string | null>>();
const resolved = new Map<string, string | null>();
const waiting: Array<() => void> = [];
let active = 0;

/** Stable memo key for a logo request, or null when it names no station. */
export function stationLogoMemoKey(key: StationLogoKey | null | undefined): string | null {
	if (!key) return null;
	const uuid = key.stationUuid?.trim().toLowerCase();
	if (uuid) return `rb:${uuid}`;
	const id = key.stationId?.trim();
	return id ? `id:${id}` : null;
}

/** A logo already settled this session: a data URL, null for none, or
 *  undefined when it has not been asked for yet. */
export function peekStationLogo(memoKey: string): string | null | undefined {
	return resolved.get(memoKey);
}

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
	if (active >= MAX_CONCURRENT) {
		// The finishing request hands its slot straight to us.
		await new Promise<void>((resume) => waiting.push(resume));
	} else {
		active += 1;
	}
	try {
		return await task();
	} finally {
		const next = waiting.shift();
		if (next) next();
		else active -= 1;
	}
}

export function loadStationLogo(key: StationLogoKey): Promise<string | null> {
	const memoKey = stationLogoMemoKey(key);
	if (!memoKey) return Promise.resolve(null);
	const known = resolved.get(memoKey);
	if (known !== undefined) return Promise.resolve(known);
	const inFlight = pending.get(memoKey);
	if (inFlight) return inFlight;

	const request = withSlot(() => getStationLogo(key))
		.then((url) => (typeof url === 'string' && url.startsWith('data:image/') ? url : null))
		.catch(() => null)
		.then((url) => {
			resolved.set(memoKey, url);
			pending.delete(memoKey);
			return url;
		});
	pending.set(memoKey, request);
	return request;
}
