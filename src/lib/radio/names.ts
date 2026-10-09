// Station names on radio-browser are free text, and many stations stuff them
// with slogans, genre lists, URLs and bitrate tags ("RADIO X :: Hip Hop, Rap,
// Trap, Techno, House | www.radiox.com [128kbps]"). Everything user-facing
// (cards, the player, toasts, the lock screen) shows `cleanStationName`, and
// placeholder art derives its colours from `stationSeed`.

const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;
const BRACKETED_NOISE =
	/[[(][^\])]*\b(?:kbps|kbit|kb\/s|mp3|aac\+?|ogg|opus|flac|hd|hq|stream|online|live|24\/7|\d{2,3}k)\b[^\])]*[\])]/gi;
const SEPARATORS = /\s+(?:[|•·~]|::|-{1,2}|—|–|\/\/)\s+/;
const EDGE_PUNCTUATION = /^[\s\-–—|•·~:;,.!*#_=+]+|[\s\-–—|•·~:;,!*#_=+]+$/g;

export const UNKNOWN_STATION = 'Unknown station';

/**
 * A short, human name for a station. Keeps the leading segments of a
 * separator-delimited name until `max` characters, drops URLs and bracketed
 * format tags, and cuts at a word boundary as a last resort.
 */
export function cleanStationName(raw: string | null | undefined, max = 42): string {
	let name = (raw ?? '').normalize('NFKC').replace(URL_PATTERN, ' ').replace(BRACKETED_NOISE, ' ');
	name = name.replace(/\s+/g, ' ').replace(EDGE_PUNCTUATION, '').trim();
	if (!name) return UNKNOWN_STATION;

	// Shouty all-caps names read as spam; title-case them when they are long.
	const letters = name.replace(/[^A-Za-z]/g, '');
	if (letters.length > 10 && letters === letters.toUpperCase()) {
		name = name.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
	}

	if (name.length > max) {
		const segments = name
			.split(SEPARATORS)
			.map((segment) => segment.replace(EDGE_PUNCTUATION, '').trim())
			.filter(Boolean);
		let kept = segments[0] ?? name;
		for (const segment of segments.slice(1)) {
			if (`${kept} · ${segment}`.length > max) break;
			kept = `${kept} · ${segment}`;
		}
		name = kept;
	}

	if (name.length > max) {
		const cut = name.slice(0, max - 1);
		const boundary = cut.lastIndexOf(' ');
		name = `${(boundary > max * 0.5 ? cut.slice(0, boundary) : cut).replace(EDGE_PUNCTUATION, '')}…`;
	}
	return name || UNKNOWN_STATION;
}

/** One or two characters for a monogram tile. */
export function stationMonogram(raw: string | null | undefined): string {
	const words = cleanStationName(raw)
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.split(/\s+/)
		.filter(Boolean);
	if (words.length === 0) return '?';
	if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
	return (words[0][0] + words[1][0]).toUpperCase();
}

/** Stable 0..1 seed from a station identity (uuid preferred, else the name). */
export function stationSeed(identity: string | null | undefined): number {
	let hash = 0x811c9dc5;
	for (const char of identity ?? '') {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash / 0xffffffff;
}
