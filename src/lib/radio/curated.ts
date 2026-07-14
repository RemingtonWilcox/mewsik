import type { RadioBrowserStation } from '$lib/api/tauri';

export type CuratedStation = RadioBrowserStation & {
	editorial: string;
	quality: string;
	adLabel: string;
	evidenceUrl: string;
};

export type CuratedCollectionId =
	| 'night-drive'
	| 'deep-focus'
	| 'jazz-soul'
	| 'after-hours'
	| 'global-dial'
	| 'guitar-alternative'
	| 'human-radio';

export type CuratedCollection = {
	id: CuratedCollectionId;
	eyebrow: string;
	title: string;
	description: string;
	tag: string;
	accent: string;
	stations: CuratedStation[];
};

// Every entry has a real Radio Browser UUID so the native station healer can
// re-resolve a moved stream. Editorial/funding labels stay deliberately narrow:
// they only claim commercial-free or non-commercial when the station does.
export const curatedStations: CuratedStation[] = [
	{
		name: 'Liquid DnB',
		url: 'https://antares.dribbcast.com/proxy/dave1/stream/',
		homepage: 'https://liquid-dnb.com/',
		favicon: null,
		country: 'United Kingdom',
		language: 'English',
		tags: 'dnb,liquid dnb,drum and bass',
		codec: 'MP3',
		bitrate: 128,
		stationuuid: 'b8148b29-09d0-4aa1-8bfe-43d236260170',
		editorial: 'Warm liquid selections with a soulful, late-night center of gravity.',
		quality: 'Liquid drum & bass',
		adLabel: 'Independent specialist stream',
		evidenceUrl: 'https://liquid-dnb.com/'
	},
	{
		name: 'Different Drumz',
		url: 'https://differentdrumz.radioca.st/electronic.mp3',
		homepage: 'https://www.differentdrumz.co.uk/',
		favicon: null,
		country: 'United Kingdom',
		language: 'English',
		tags: 'dnb,jungle,liquid dnb,drum and bass',
		codec: 'MP3',
		bitrate: 192,
		stationuuid: '4673721a-bcdc-4ee8-81d5-37a92909c010',
		editorial: 'Rotating community DJs, deeper cuts, jungle, and less predictable transitions.',
		quality: 'Live DJ culture',
		adLabel: 'Community radio',
		evidenceUrl: 'https://www.differentdrumz.co.uk/'
	},
	{
		name: 'Dutch Delite DnB',
		url: 'http://radio.dutchdelite.nl:8000/dnb',
		homepage: 'https://www.mixcloud.com/dutchdelite/',
		favicon: null,
		country: 'Netherlands',
		language: 'English',
		tags: 'dnb,drum and bass,jungle',
		codec: 'MP3',
		bitrate: 256,
		stationuuid: 'ed1fa99d-6ebf-4d2d-8016-2721f8e41269',
		editorial: 'A crisp, high-bitrate feed for the more energetic stretch of the drive.',
		quality: 'High-bitrate DnB',
		adLabel: 'Independent DJ stream',
		evidenceUrl: 'https://www.mixcloud.com/dutchdelite/'
	},
	{
		name: 'SomaFM Groove Salad',
		url: 'https://ice5.somafm.com/groovesalad-128-mp3',
		homepage: 'https://somafm.com/groovesalad/',
		favicon: null,
		country: 'United States',
		language: 'English',
		tags: 'ambient,downtempo,chillout,electronica',
		codec: 'MP3',
		bitrate: 128,
		stationuuid: '960cf833-0601-11e8-ae97-52543be04c81',
		editorial: 'Downtempo beats and soft electronic color that can carry a long work session.',
		quality: 'Hand-picked downtempo',
		adLabel: 'Commercial-free · listener-supported',
		evidenceUrl: 'https://somafm.com/home.html'
	},
	{
		name: 'SomaFM Drone Zone',
		url: 'https://ice4.somafm.com/dronezone-128-mp3',
		homepage: 'https://somafm.com/dronezone/',
		favicon: null,
		country: 'United States',
		language: 'English',
		tags: 'ambient,drone,space,meditation',
		codec: 'MP3',
		bitrate: 128,
		stationuuid: '960eb2e9-0601-11e8-ae97-52543be04c81',
		editorial: 'Long atmospheric forms with almost no rhythmic demand on your attention.',
		quality: 'Deep ambient',
		adLabel: 'Commercial-free · listener-supported',
		evidenceUrl: 'https://somafm.com/home.html'
	},
	{
		name: 'SomaFM Deep Space One',
		url: 'https://ice6.somafm.com/deepspaceone-128-mp3',
		homepage: 'https://somafm.com/deepspaceone/',
		favicon: null,
		country: 'United States',
		language: 'English',
		tags: 'ambient,experimental,space,electronic',
		codec: 'MP3',
		bitrate: 128,
		stationuuid: 'a807ecc5-8410-4704-bac4-aed64ba76742',
		editorial: 'More alien and exploratory than ordinary focus radio, without becoming abrasive.',
		quality: 'Experimental space music',
		adLabel: 'Commercial-free · listener-supported',
		evidenceUrl: 'https://somafm.com/home.html'
	},
	{
		name: 'Radio Swiss Classic',
		url: 'https://stream.srg-ssr.ch/srgssr/rsc_de/mp3/128',
		homepage: 'https://www.radioswissclassic.ch/en',
		favicon: null,
		country: 'Switzerland',
		language: 'German',
		tags: 'classical,orchestral,chamber music',
		codec: 'MP3',
		bitrate: 128,
		stationuuid: '96077079-0601-11e8-ae97-52543be04c81',
		editorial: 'A broad classical library with only short recorded introductions between works.',
		quality: 'Minimal-talk classical',
		adLabel: 'Commercial-free public radio',
		evidenceUrl: 'https://www.radioswissclassic.ch/de/faq'
	},
	{
		name: 'Radio Swiss Jazz',
		url: 'https://stream.srg-ssr.ch/srgssr/rsj/mp3/128',
		homepage: 'https://www.radioswissjazz.ch/en',
		favicon: null,
		country: 'Switzerland',
		language: 'English',
		tags: 'jazz,soul,blues,latin,world',
		codec: 'MP3',
		bitrate: 128,
		stationuuid: '961ac56b-0601-11e8-ae97-52543be04c81',
		editorial: 'Melodic jazz, soul, blues, and Latin selections with no presenter interruptions.',
		quality: 'Music-only jazz',
		adLabel: 'Commercial-free public radio',
		evidenceUrl: 'https://www.radioswissjazz.ch/de/faq'
	},
	{
		name: 'Jazz24',
		url: 'https://knkx-live-a.edge.audiocdn.com/6285_128k',
		homepage: 'https://www.jazz24.org/',
		favicon: null,
		country: 'United States',
		language: 'English',
		tags: 'jazz,blues,funk,latin jazz',
		codec: 'MP3',
		bitrate: 128,
		stationuuid: 'c60cb1ef-b88f-4bbc-a24b-e911a534259f',
		editorial: 'A welcoming jazz backbone with enough blues, funk, and Latin color to keep moving.',
		quality: 'Seattle jazz service',
		adLabel: 'Listener-supported nonprofit',
		evidenceUrl: 'https://www.jazz24.org/about'
	},
	{
		name: 'FIP Jazz',
		url: 'https://icecast.radiofrance.fr/fipjazz-hifi.aac',
		homepage: 'https://www.radiofrance.fr/fip/radio-jazz',
		favicon: null,
		country: 'France',
		language: 'French',
		tags: 'jazz,spiritual jazz,fusion,soul',
		codec: 'AAC',
		bitrate: 192,
		stationuuid: '5b9ceedf-eb85-11e9-a96c-52543be04c81',
		editorial: 'French-curated jazz that moves freely between eras instead of looping standards.',
		quality: 'Human-curated jazz',
		adLabel: 'Ad-free public radio audio',
		evidenceUrl: 'https://www.radiofrance.com/presentation-antennes?page=1'
	},
	{
		name: 'Kiosk Radio',
		url: 'https://kioskradiobxl.out.airtime.pro/kioskradiobxl_b',
		homepage: 'https://www.kioskradio.com/',
		favicon: null,
		country: 'Belgium',
		language: 'English',
		tags: 'electronic,jazz,ambient,hip hop,experimental',
		codec: 'MP3',
		bitrate: 192,
		stationuuid: 'bae70c5c-9f3f-42fc-a83d-6c13920590e0',
		editorial: 'Brussels selectors crossing club music, jazz, ambient, hip-hop, and experiments.',
		quality: 'Live community selectors',
		adLabel: 'Nonprofit community radio',
		evidenceUrl: 'https://www.kioskradio.com/about'
	},
	{
		name: 'FIP Groove',
		url: 'https://icecast.radiofrance.fr/fipgroove-hifi.aac',
		homepage: 'https://www.radiofrance.fr/fip/radio-groove',
		favicon: null,
		country: 'France',
		language: 'French',
		tags: 'funk,soul,disco,groove,hip hop',
		codec: 'AAC',
		bitrate: 192,
		stationuuid: 'c454908c-eb81-11e9-a96c-52543be04c81',
		editorial: 'Funk, soul, disco, and hip-hop selected for flow rather than maximum familiarity.',
		quality: 'Funk and soul current',
		adLabel: 'Ad-free public radio audio',
		evidenceUrl: 'https://www.radiofrance.com/presentation-antennes?page=1'
	},
	{
		name: 'SomaFM Beat Blender',
		url: 'https://ice6.somafm.com/beatblender-128-aac',
		homepage: 'https://somafm.com/beatblender/',
		favicon: null,
		country: 'United States',
		language: 'English',
		tags: 'deep house,downtempo,electronic,chill',
		codec: 'AAC',
		bitrate: 128,
		stationuuid: '39a19b72-7c6d-11e9-aa30-52543be04c81',
		editorial: 'A low-lit meeting point between deep house momentum and downtempo restraint.',
		quality: 'Steady electronic pulse',
		adLabel: 'Commercial-free · listener-supported',
		evidenceUrl: 'https://somafm.com/home.html'
	},
	{
		name: 'NTS Radio 1',
		url: 'https://stream-relay-geo.ntslive.net/stream',
		homepage: 'https://www.nts.live/',
		favicon: null,
		country: 'United Kingdom',
		language: 'English',
		tags: 'global,experimental,electronic,hip hop,jazz',
		codec: 'MP3',
		bitrate: 256,
		stationuuid: '961e6cac-0601-11e8-ae97-52543be04c81',
		editorial: 'The broadest leftfield dial here: resident DJs and guests from scenes worldwide.',
		quality: 'Global human curation',
		adLabel: 'No on-air ads · supporter-funded',
		evidenceUrl: 'https://www.nts.live/about'
	},
	{
		name: 'FIP',
		url: 'https://icecast.radiofrance.fr/fip-hifi.aac',
		homepage: 'https://www.radiofrance.fr/fip',
		favicon: null,
		country: 'France',
		language: 'French',
		tags: 'eclectic,world,jazz,rock,electronic,classical',
		codec: 'AAC',
		bitrate: 192,
		stationuuid: '932eb148-e6f6-11e9-a96c-52543be04c81',
		editorial: 'An unusually coherent trip through jazz, chanson, rock, classical, and the world.',
		quality: 'Eclectic public radio',
		adLabel: 'Ad-free public radio audio',
		evidenceUrl: 'https://www.radiofrance.com/presentation-antennes?page=1'
	},
	{
		name: 'FIP World',
		url: 'https://icecast.radiofrance.fr/fipworld-hifi.aac',
		homepage: 'https://www.radiofrance.fr/fip/radio-monde',
		favicon: null,
		country: 'France',
		language: 'French',
		tags: 'world,african,latin,global,folk',
		codec: 'AAC',
		bitrate: 192,
		stationuuid: 'cbc50678-e70e-11e9-a96c-52543be04c81',
		editorial: 'A borderless music stream built for discovery rather than a generic world playlist.',
		quality: 'Worldwide selections',
		adLabel: 'Ad-free public radio audio',
		evidenceUrl: 'https://www.radiofrance.com/presentation-antennes?page=1'
	},
	{
		name: 'KEXP',
		url: 'https://kexp.streamguys1.com/kexp160.aac',
		homepage: 'https://www.kexp.org/',
		favicon: null,
		country: 'United States',
		language: 'English',
		tags: 'indie,alternative,rock,electronic,global,live',
		codec: 'AAC',
		bitrate: 160,
		stationuuid: '445cbb3a-1c4e-49aa-a268-f5b6acfa8f2e',
		editorial: 'Present-tense independent music with real DJs, local context, and global curiosity.',
		quality: 'Seattle music discovery',
		adLabel: 'Non-commercial · listener-powered',
		evidenceUrl: 'https://www.kexp.org/about/'
	},
	{
		name: 'WFMU',
		url: 'https://stream2.wfmu.org/freeform-128k',
		homepage: 'https://wfmu.org/',
		favicon: null,
		country: 'United States',
		language: 'English',
		tags: 'freeform,experimental,rock,jazz,global,spoken word',
		codec: 'MP3',
		bitrate: 128,
		stationuuid: '9618344a-0601-11e8-ae97-52543be04c81',
		editorial: 'The wildcard: fiercely freeform shows that can move from punk to field recordings.',
		quality: 'Independent freeform',
		adLabel: 'Non-commercial · listener-supported',
		evidenceUrl: 'https://freeform.wfmu.org/about/'
	},
	{
		name: 'Radio Paradise Rock Mix',
		url: 'https://stream.radioparadise.com/rock-320',
		homepage: 'https://radioparadise.com/',
		favicon: null,
		country: 'United States',
		language: 'English',
		tags: 'rock,alternative,classic rock,indie',
		codec: 'AAC',
		bitrate: 320,
		stationuuid: '5681d06a-f5af-11e9-bbf2-52543be04c81',
		editorial: 'A broad rock lane assembled for transitions, not a pile of disconnected singles.',
		quality: 'Human-sequenced rock',
		adLabel: 'Commercial-free · listener-supported',
		evidenceUrl: 'https://www3.radioparadise.com/content.php?name=Home'
	},
	{
		name: 'Radio Paradise Main Mix',
		url: 'https://stream.radioparadise.com/mp3-192',
		homepage: 'https://radioparadise.com/',
		favicon: null,
		country: 'United States',
		language: 'English',
		tags: 'eclectic,rock,world,electronic,jazz,classical',
		codec: 'MP3',
		bitrate: 192,
		stationuuid: '5677f92c-1220-11ea-a87e-52543be04c81',
		editorial: 'Two human curators blend genres with unusually thoughtful pacing and continuity.',
		quality: 'Human-sequenced eclectic',
		adLabel: 'Commercial-free · listener-supported',
		evidenceUrl: 'https://www3.radioparadise.com/content.php?name=Home'
	},
	{
		name: 'NTS Radio 2',
		url: 'https://stream-relay-geo.ntslive.net/stream2',
		homepage: 'https://www.nts.live/',
		favicon: null,
		country: 'United Kingdom',
		language: 'English',
		tags: 'global,experimental,ambient,club,jazz',
		codec: 'MP3',
		bitrate: 256,
		stationuuid: '9634ab94-0601-11e8-ae97-52543be04c81',
		editorial: 'The more exploratory NTS lane, often slower, stranger, and less anchored to genre.',
		quality: 'Leftfield resident radio',
		adLabel: 'No on-air ads · supporter-funded',
		evidenceUrl: 'https://www.nts.live/about'
	},
	{
		name: 'dublab',
		url: 'https://dublab.out.airtime.pro/dublab_a',
		homepage: 'https://www.dublab.com/',
		favicon: null,
		country: 'United States',
		language: 'English',
		tags: 'eclectic,experimental,electronic,jazz,global',
		codec: 'MP3',
		bitrate: 192,
		stationuuid: '0bb84fe1-e899-11e9-a96c-52543be04c81',
		editorial: 'Los Angeles artists and DJs following ideas across eras, borders, and formats.',
		quality: 'Future-roots radio',
		adLabel: 'Listener-powered nonprofit',
		evidenceUrl: 'https://www.dublab.com/support'
	}
];

const stationsByUuid = new Map(curatedStations.map((station) => [station.stationuuid, station]));

function stationsFor(ids: string[]): CuratedStation[] {
	return ids.map((id) => {
		const station = stationsByUuid.get(id);
		if (!station) throw new Error(`Unknown curated station UUID: ${id}`);
		return station;
	});
}

export const curatedCollections: CuratedCollection[] = [
	{
		id: 'night-drive',
		eyebrow: 'Liquid & atmospheric',
		title: 'Night drive',
		description: 'The original liquid-DnB lane: melodic motion, community DJs, and clean momentum.',
		tag: 'liquid dnb',
		accent: 'from-cyan-400/24 via-blue-500/10 to-transparent',
		stations: stationsFor([
			'b8148b29-09d0-4aa1-8bfe-43d236260170',
			'4673721a-bcdc-4ee8-81d5-37a92909c010',
			'ed1fa99d-6ebf-4d2d-8016-2721f8e41269'
		])
	},
	{
		id: 'deep-focus',
		eyebrow: 'Ambient & timeless',
		title: 'Deep focus',
		description: 'Four low-interruption streams for making, reading, thinking, or disappearing.',
		tag: 'ambient',
		accent: 'from-violet-400/24 via-fuchsia-500/10 to-transparent',
		stations: stationsFor([
			'960cf833-0601-11e8-ae97-52543be04c81',
			'960eb2e9-0601-11e8-ae97-52543be04c81',
			'a807ecc5-8410-4704-bac4-aed64ba76742',
			'96077079-0601-11e8-ae97-52543be04c81'
		])
	},
	{
		id: 'jazz-soul',
		eyebrow: 'Jazz, soul & blues',
		title: 'Warm room',
		description: 'Three distinct approaches to jazz: music-only, public-service, and French-curated.',
		tag: 'jazz',
		accent: 'from-amber-300/22 via-rose-500/10 to-transparent',
		stations: stationsFor([
			'961ac56b-0601-11e8-ae97-52543be04c81',
			'c60cb1ef-b88f-4bbc-a24b-e911a534259f',
			'5b9ceedf-eb85-11e9-a96c-52543be04c81'
		])
	},
	{
		id: 'after-hours',
		eyebrow: 'Club-adjacent & low-lit',
		title: 'After hours',
		description: 'Selectors and deep electronic currents with more patience than peak-time radio.',
		tag: 'deep house',
		accent: 'from-emerald-400/24 via-teal-500/10 to-transparent',
		stations: stationsFor([
			'bae70c5c-9f3f-42fc-a83d-6c13920590e0',
			'c454908c-eb81-11e9-a96c-52543be04c81',
			'39a19b72-7c6d-11e9-aa30-52543be04c81'
		])
	},
	{
		id: 'global-dial',
		eyebrow: 'Scenes without borders',
		title: 'Global dial',
		description: 'Human selectors connecting local scenes, overlooked eras, and sounds across borders.',
		tag: 'world',
		accent: 'from-sky-400/22 via-emerald-500/10 to-transparent',
		stations: stationsFor([
			'961e6cac-0601-11e8-ae97-52543be04c81',
			'932eb148-e6f6-11e9-a96c-52543be04c81',
			'cbc50678-e70e-11e9-a96c-52543be04c81'
		])
	},
	{
		id: 'guitar-alternative',
		eyebrow: 'Guitars with a point of view',
		title: 'Alternative current',
		description: 'Independent, freeform, and carefully sequenced rock beyond a greatest-hits loop.',
		tag: 'alternative rock',
		accent: 'from-orange-400/24 via-red-500/10 to-transparent',
		stations: stationsFor([
			'445cbb3a-1c4e-49aa-a268-f5b6acfa8f2e',
			'9618344a-0601-11e8-ae97-52543be04c81',
			'5681d06a-f5af-11e9-bbf2-52543be04c81'
		])
	},
	{
		id: 'human-radio',
		eyebrow: 'Follow the selector',
		title: 'Human radio',
		description: 'Three stations where pacing, surprise, and a curator\'s perspective are the product.',
		tag: 'eclectic',
		accent: 'from-pink-400/22 via-purple-500/10 to-transparent',
		stations: stationsFor([
			'5677f92c-1220-11ea-a87e-52543be04c81',
			'9634ab94-0601-11e8-ae97-52543be04c81',
			'0bb84fe1-e899-11e9-a96c-52543be04c81'
		])
	}
];
