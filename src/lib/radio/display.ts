import type { RadioBrowserStation } from '$lib/api/tauri';

// Short, human labels for station rows: "United States" rather than
// "The United States Of America", and a couple of real genre tags rather
// than the raw comma list (which often carries codecs, URLs and filler).

let regionNames: Intl.DisplayNames | null = null;
try {
	regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
} catch {
	regionNames = null;
}

export function shortCountry(country: string | null | undefined, code?: string | null): string {
	if (code && code.length === 2 && regionNames) {
		try {
			const name = regionNames.of(code.toUpperCase());
			if (name && name !== code.toUpperCase()) return name;
		} catch {
			// fall through to the long name
		}
	}
	if (!country) return '';
	return country
		.replace(/^The /i, '')
		.replace(/ Of America$/i, '')
		.replace(/ Of Great Britain And Northern Ireland$/i, '')
		.replace(/^Russian Federation$/i, 'Russia');
}

const FILLER_TAGS = new Set([
	'music',
	'radio',
	'fm',
	'am',
	'online',
	'internet',
	'web',
	'live',
	'stream',
	'webradio',
	'internet radio',
	'mp3',
	'aac',
	'aac+',
	'ogg',
	'hd',
	'hq',
	'24/7',
	'non-stop',
	'nonstop',
	'various',
	'variety',
	'misc',
	'english',
	'local'
]);

function titleCase(tag: string): string {
	if (tag.length <= 3) return tag.toUpperCase();
	return tag.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

/** Up to `count` readable genre tags from a station's tag list. */
export function genreTags(tags: string | null | undefined, count = 2): string[] {
	if (!tags) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of tags.split(',')) {
		const tag = raw.trim().toLowerCase();
		if (!tag || tag.length > 22 || FILLER_TAGS.has(tag) || seen.has(tag)) continue;
		if (/^\d+$|https?:|www\.|\.(com|net|org|fm)\b|kbps/.test(tag)) continue;
		seen.add(tag);
		out.push(titleCase(tag));
		if (out.length >= count) break;
	}
	return out;
}

// Directory tags for spoken-word stations. The station pages are for music,
// so these drop out of "popular" lists (a search still finds them).
const SPOKEN_TAGS = new Set([
	'news',
	'talk',
	'talk radio',
	'news talk',
	'news/talk',
	'sport',
	'sports',
	'sports talk',
	'sports news',
	'information',
	'info',
	'politics',
	'podcast',
	'podcasts',
	'comedy',
	'spoken word',
	'religion',
	'sermons',
	'noticias',
	'nachrichten',
	'actualités',
	'notizie',
	'public radio'
]);

/** False for news, talk and sports stations. */
export function isMusicStation(station: Pick<RadioBrowserStation, 'tags'>): boolean {
	if (!station.tags) return true;
	return !station.tags
		.split(',')
		.map((tag) => tag.trim().toLowerCase())
		.some((tag) => SPOKEN_TAGS.has(tag));
}
