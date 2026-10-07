import type { SceneInfo } from '$lib/api/tauri';

// Frontend copy of the scene catalog from
// docs/station-discovery-contract-2026-10-07.md. The Rust side owns the tag
// queries; this list only exists so the scene chips render when the backend
// has nothing cached (or is absent, as in the browser lab). When a feed
// carries `scenes`, prefer that list over this one.
export const SCENE_CATALOG: SceneInfo[] = [
	{
		id: 'workout',
		title: 'Workout',
		eyebrow: 'Gym & high energy',
		description: 'Relentless tempo for lifting, running, and anything that needs a push.',
		family: 'workout',
		accent: 'from-orange-500/30 via-red-500/10 to-transparent'
	},
	{
		id: 'hip-hop',
		title: 'Hip-hop',
		eyebrow: 'Rap & beats',
		description: 'Current rap radio with the mixes, freestyles, and anthems that carry it.',
		family: 'hiphop',
		accent: 'from-amber-400/30 via-orange-500/10 to-transparent'
	},
	{
		id: 'trap',
		title: 'Trap',
		eyebrow: '808s & hi-hats',
		description: 'Heavy low end and double-time hats, from Atlanta outward.',
		family: 'hiphop',
		accent: 'from-fuchsia-500/30 via-purple-500/10 to-transparent'
	},
	{
		id: 'boom-bap',
		title: 'Boom bap',
		eyebrow: 'Golden era & underground',
		description: 'Dusty drums, chopped samples, and rappers who write in bars.',
		family: 'hiphop',
		accent: 'from-yellow-500/30 via-amber-600/10 to-transparent'
	},
	{
		id: 'lofi-hip-hop',
		title: 'Lo-fi hip-hop',
		eyebrow: 'Beats to work to',
		description: 'Hazy instrumentals with a steady pulse and no one talking over them.',
		family: 'chill',
		accent: 'from-rose-400/30 via-pink-500/10 to-transparent'
	},
	{
		id: 'uk-rap-drill',
		title: 'UK rap & drill',
		eyebrow: 'London & beyond',
		description: 'Sliding 808s, grime lineage, and the UK accent on rap radio.',
		family: 'hiphop',
		accent: 'from-slate-400/30 via-zinc-500/10 to-transparent'
	},
	{
		id: 'rnb-soul',
		title: 'R&B & soul',
		eyebrow: 'Voices first',
		description: 'Slow jams, neo-soul, and the classics that still set the room.',
		family: 'soul',
		accent: 'from-rose-500/30 via-red-500/10 to-transparent'
	},
	{
		id: 'punk',
		title: 'Punk',
		eyebrow: 'Fast & loud',
		description: 'Three chords, two minutes, and every scene from 1977 to now.',
		family: 'rock',
		accent: 'from-red-500/30 via-rose-600/10 to-transparent'
	},
	{
		id: 'metal',
		title: 'Metal',
		eyebrow: 'Heavy on purpose',
		description: 'Thrash, doom, death, and everything with a wall of guitars.',
		family: 'rock',
		accent: 'from-zinc-400/30 via-neutral-600/10 to-transparent'
	},
	{
		id: 'hardcore',
		title: 'Hardcore',
		eyebrow: 'Breakdowns & blast beats',
		description: 'Hardcore punk and its metallic offshoots at full intensity.',
		family: 'rock',
		accent: 'from-red-600/30 via-orange-700/10 to-transparent'
	},
	{
		id: 'classic-rock',
		title: 'Classic rock',
		eyebrow: 'The big riffs',
		description: 'Album rock from the sixties through the nineties, deep cuts included.',
		family: 'rock',
		accent: 'from-amber-500/30 via-yellow-600/10 to-transparent'
	},
	{
		id: 'indie-alt',
		title: 'Indie & alt',
		eyebrow: 'Guitars with ideas',
		description: 'Independent and alternative rock that still sounds like a band in a room.',
		family: 'rock',
		accent: 'from-orange-400/30 via-red-500/10 to-transparent'
	},
	{
		id: 'house',
		title: 'House',
		eyebrow: 'Four on the floor',
		description: 'Deep, soulful, and peak-time house from the clubs that keep it alive.',
		family: 'electronic',
		accent: 'from-emerald-400/30 via-teal-500/10 to-transparent'
	},
	{
		id: 'techno',
		title: 'Techno',
		eyebrow: 'Dark rooms',
		description: 'Driving, hypnotic, and industrial strands of techno around the clock.',
		family: 'electronic',
		accent: 'from-cyan-400/30 via-sky-600/10 to-transparent'
	},
	{
		id: 'drum-and-bass',
		title: 'Drum & bass',
		eyebrow: 'Liquid to jungle',
		description: 'Breakbeats at 174, from liquid rollers to jungle and neurofunk.',
		family: 'electronic',
		accent: 'from-cyan-400/30 via-blue-500/10 to-transparent'
	},
	{
		id: 'trance',
		title: 'Trance',
		eyebrow: 'Uplifting & progressive',
		description: 'Long builds, big drops, and melodies that run for miles.',
		family: 'electronic',
		accent: 'from-violet-400/30 via-indigo-500/10 to-transparent'
	},
	{
		id: 'ambient',
		title: 'Ambient',
		eyebrow: 'Slow & spacious',
		description: 'Drones, textures, and generative sound for rooms that need no beat.',
		family: 'chill',
		accent: 'from-violet-400/30 via-fuchsia-500/10 to-transparent'
	},
	{
		id: 'synthwave',
		title: 'Synthwave',
		eyebrow: 'Neon & arpeggios',
		description: 'Retrowave, outrun, and darksynth built on eighties hardware worship.',
		family: 'electronic',
		accent: 'from-pink-500/30 via-purple-600/10 to-transparent'
	},
	{
		id: 'jazz',
		title: 'Jazz',
		eyebrow: 'Standards to spiritual',
		description: 'Bebop, modal, vocal, and modern jazz stations that know the catalogue.',
		family: 'soul',
		accent: 'from-amber-300/30 via-rose-500/10 to-transparent'
	},
	{
		id: 'funk',
		title: 'Funk',
		eyebrow: 'Rhythm sections',
		description: 'Funk, boogie, and disco where the bass player is in charge.',
		family: 'soul',
		accent: 'from-yellow-400/30 via-orange-500/10 to-transparent'
	},
	{
		id: 'reggae-dub',
		title: 'Reggae & dub',
		eyebrow: 'Roots & sound system',
		description: 'Roots, rocksteady, dancehall, and dub with the bass turned up.',
		family: 'world',
		accent: 'from-green-500/30 via-yellow-500/10 to-transparent'
	},
	{
		id: 'latin',
		title: 'Latin',
		eyebrow: 'Reggaeton to salsa',
		description: 'Latin pop, reggaeton, salsa, and bachata from both sides of the Atlantic.',
		family: 'world',
		accent: 'from-red-400/30 via-amber-500/10 to-transparent'
	},
	{
		id: 'afrobeats',
		title: 'Afrobeats',
		eyebrow: 'Lagos to London',
		description: 'Afrobeats, amapiano, and the African pop wave shaping global charts.',
		family: 'world',
		accent: 'from-lime-400/30 via-emerald-500/10 to-transparent'
	},
	{
		id: 'country',
		title: 'Country',
		eyebrow: 'Twang & storytelling',
		description: 'Classic, outlaw, and modern country with real songwriting.',
		family: 'pop',
		accent: 'from-amber-600/30 via-orange-700/10 to-transparent'
	},
	{
		id: 'classical',
		title: 'Classical',
		eyebrow: 'Orchestral & chamber',
		description: 'Symphonic, chamber, opera, and early music, mostly without chatter.',
		family: 'classic',
		accent: 'from-stone-300/30 via-amber-200/10 to-transparent'
	},
	{
		id: 'pop-hits',
		title: 'Pop hits',
		eyebrow: 'Right now',
		description: 'Current chart pop and the stations that break the next single.',
		family: 'pop',
		accent: 'from-pink-400/30 via-rose-500/10 to-transparent'
	},
	{
		id: '80s-90s',
		title: '80s & 90s',
		eyebrow: 'Two decades of hits',
		description: 'New wave, synth-pop, grunge, and dance from the years that made them.',
		family: 'classic',
		accent: 'from-sky-400/30 via-violet-500/10 to-transparent'
	},
	{
		id: 'chill-study',
		title: 'Chill & study',
		eyebrow: 'Low interruption',
		description: 'Downtempo and quiet electronic sets that stay in the background.',
		family: 'chill',
		accent: 'from-teal-400/30 via-cyan-500/10 to-transparent'
	},
	{
		id: 'oldies',
		title: 'Oldies',
		eyebrow: 'Fifties to seventies',
		description: 'Doo-wop, Motown, early rock and roll, and AM-gold pop.',
		family: 'classic',
		accent: 'from-amber-200/30 via-stone-400/10 to-transparent'
	}
];

export const SCENE_BY_ID: ReadonlyMap<string, SceneInfo> = new Map(
	SCENE_CATALOG.map((scene) => [scene.id, scene])
);
