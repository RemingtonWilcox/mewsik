// Directory genre chips. radio-browser tags are lowercase free text and its
// tag search is case-sensitive, so a chip label like "Hip Hop" matched
// nothing. Each chip instead names the real tags stations actually use; the
// backend queries them together (exact tag match) and merges the results.
//
// `scripts/check-station-tags.mjs` imports this file and checks that every
// tag still returns enough playable stations. Keep this module free of
// imports so Node can load it directly.

export interface DirectoryGenre {
	label: string;
	tags: string[];
}

export const DIRECTORY_GENRES: DirectoryGenre[] = [
	{ label: 'Hip-hop', tags: ['hip hop', 'hiphop', 'hip-hop', 'rap'] },
	{ label: 'DnB', tags: ['drum and bass', 'dnb', 'drum & bass', 'jungle'] },
	{ label: 'Techno', tags: ['techno', 'minimal techno', 'minimal'] },
	{ label: 'House', tags: ['house', 'deep house', 'tech house'] },
	{ label: 'Jazz', tags: ['jazz', 'smooth jazz', 'jazz fusion'] },
	{ label: 'Lo-fi', tags: ['lofi', 'lo-fi', 'lofi hip hop', 'chillhop'] },
	{ label: 'Ambient', tags: ['ambient', 'dark ambient', 'drone'] },
	{ label: 'Classical', tags: ['classical', 'classical music', 'baroque', 'opera'] },
	{ label: 'Rock', tags: ['rock', 'classic rock', 'alternative rock', 'hard rock'] },
	{ label: 'Metal', tags: ['metal', 'heavy metal', 'death metal', 'black metal'] },
	{ label: 'Reggae', tags: ['reggae', 'dub', 'dancehall', 'roots reggae'] },
	{ label: 'Soul', tags: ['soul', 'funk', 'neo soul', 'motown'] },
	{ label: 'R&B', tags: ['rnb', 'r&b', "r'n'b"] },
	{ label: 'Pop', tags: ['pop', 'top 40', 'hits', 'pop music'] },
	{ label: 'Trance', tags: ['trance', 'psytrance', 'progressive trance', 'uplifting trance'] },
	{ label: 'Chillout', tags: ['chillout', 'chill', 'lounge', 'downtempo'] },
	{ label: 'Latin', tags: ['latin', 'reggaeton', 'salsa', 'latin pop'] },
	{ label: 'Blues', tags: ['blues', 'blues rock', 'rhythm and blues'] },
	{ label: 'News', tags: ['news', 'public radio', 'news talk'] },
	{ label: 'Talk', tags: ['talk', 'news talk', 'talk radio', 'public radio'] },
	{ label: 'Sports', tags: ['sports', 'sport', 'football'] }
];

/** The tag set for a chip label or a typed query that names a chip. */
export function genreTagsFor(query: string): string[] | null {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return null;
	const collapsed = normalized.replace(/[\s_-]+/g, '');
	for (const genre of DIRECTORY_GENRES) {
		const label = genre.label.toLowerCase();
		if (
			label === normalized ||
			label.replace(/[\s_-]+/g, '') === collapsed ||
			genre.tags.some((tag) => tag === normalized || tag.replace(/[\s_-]+/g, '') === collapsed)
		) {
			return genre.tags;
		}
	}
	return null;
}
