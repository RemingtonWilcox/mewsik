// Phosphor families. Each family is a real (or plausible) tube chemistry or
// display convention with fixed roles, so colour always means the same thing
// across the instrument:
//   hero    - the XY figure, the beam that everything else is drawn from
//   trace   - the channel traces that feed the figure
//   horizon - the figure's history on the floor (cools from hero to this)
//   hot     - write heads, beat packets and fresh stamps
// Families are authored colours, never a cosine or hue-sweep palette. Key and
// mode lean a family a few degrees, energy lifts its hot role, and family
// changes crossfade in OKLab so a swap passes through no muddy midpoint.

export type Rgb = readonly [number, number, number];

export type SignalPaletteFamily = {
	name: string;
	hero: Rgb;
	trace: Rgb;
	horizon: Rgb;
	hot: Rgb;
	/** Overall emissive trim; pale families run lower so the frame stays dark. */
	gain: number;
};

export const SIGNAL_PALETTES: readonly SignalPaletteFamily[] = [
	{ name: 'P31 bench', hero: [0.3, 1.0, 0.62], trace: [1.0, 0.56, 0.18], horizon: [0.32, 0.8, 1.0], hot: [1.0, 0.42, 0.32], gain: 1 },
	{ name: 'P1 green', hero: [0.32, 1.0, 0.38], trace: [0.62, 1.0, 0.3], horizon: [0.12, 0.62, 0.36], hot: [0.88, 1.0, 0.7], gain: 1 },
	{ name: 'P4 white', hero: [0.9, 0.94, 1.0], trace: [0.66, 0.76, 1.0], horizon: [0.46, 0.55, 0.86], hot: [1.0, 0.9, 0.72], gain: 0.78 },
	{ name: 'P7 blue-yellow', hero: [0.42, 0.6, 1.0], trace: [1.0, 0.84, 0.28], horizon: [0.86, 0.7, 0.2], hot: [0.82, 0.92, 1.0], gain: 1 },
	{ name: 'amber terminal', hero: [1.0, 0.6, 0.12], trace: [1.0, 0.42, 0.06], horizon: [0.78, 0.3, 0.05], hot: [1.0, 0.86, 0.52], gain: 0.95 },
	{ name: 'scope cyan', hero: [0.18, 0.94, 1.0], trace: [0.34, 0.66, 1.0], horizon: [0.08, 0.5, 0.72], hot: [0.86, 1.0, 1.0], gain: 1 },
	{ name: 'vector overlay', hero: [1.0, 0.93, 0.9], trace: [1.0, 0.18, 0.16], horizon: [0.82, 0.1, 0.14], hot: [1.0, 0.55, 0.42], gain: 0.82 },
	{ name: 'infrared', hero: [1.0, 0.2, 0.08], trace: [0.78, 0.05, 0.22], horizon: [0.48, 0.04, 0.14], hot: [1.0, 0.6, 0.22], gain: 1 },
	{ name: 'ultraviolet', hero: [0.62, 0.32, 1.0], trace: [0.34, 0.26, 1.0], horizon: [0.84, 0.24, 0.9], hot: [0.88, 0.78, 1.0], gain: 1 },
	{ name: 'sodium', hero: [1.0, 0.68, 0.2], trace: [1.0, 0.84, 0.46], horizon: [0.58, 0.46, 0.3], hot: [1.0, 0.96, 0.74], gain: 0.92 },
	{ name: 'plasma pink', hero: [1.0, 0.34, 0.7], trace: [0.62, 0.4, 1.0], horizon: [0.26, 0.72, 1.0], hot: [1.0, 0.82, 0.9], gain: 1 },
	{ name: 'mono white', hero: [0.95, 0.95, 0.95], trace: [0.74, 0.74, 0.74], horizon: [0.5, 0.5, 0.5], hot: [1.0, 1.0, 1.0], gain: 0.72 },
	{ name: 'radar P7', hero: [0.6, 1.0, 0.24], trace: [0.3, 0.8, 0.16], horizon: [0.7, 0.86, 0.18], hot: [0.94, 1.0, 0.62], gain: 1 },
	{ name: 'arctic', hero: [0.66, 0.86, 1.0], trace: [0.38, 1.0, 0.86], horizon: [0.28, 0.46, 1.0], hot: [1.0, 1.0, 1.0], gain: 0.86 },
	{ name: 'copper', hero: [1.0, 0.5, 0.34], trace: [0.96, 0.76, 0.54], horizon: [0.56, 0.28, 0.24], hot: [1.0, 0.86, 0.7], gain: 0.95 },
	{ name: 'abyss lime', hero: [0.14, 1.0, 0.76], trace: [0.76, 1.0, 0.2], horizon: [0.04, 0.48, 0.6], hot: [0.92, 1.0, 0.6], gain: 1 },
	{ name: 'magenta duotone', hero: [1.0, 0.24, 0.86], trace: [0.3, 1.0, 0.46], horizon: [0.62, 0.2, 0.76], hot: [1.0, 0.86, 1.0], gain: 1 },
	{ name: 'cobalt ember', hero: [0.26, 0.46, 1.0], trace: [1.0, 0.5, 0.12], horizon: [0.18, 0.28, 0.82], hot: [1.0, 0.8, 0.5], gain: 1 },
	{ name: 'P22 triad', hero: [1.0, 0.3, 0.24], trace: [0.3, 1.0, 0.36], horizon: [0.3, 0.46, 1.0], hot: [1.0, 1.0, 0.88], gain: 0.95 },
	{ name: 'bone', hero: [1.0, 0.88, 0.7], trace: [0.86, 0.64, 0.44], horizon: [0.5, 0.38, 0.28], hot: [1.0, 0.96, 0.86], gain: 0.8 },
	{ name: 'acid violet', hero: [0.88, 1.0, 0.2], trace: [0.6, 0.36, 1.0], horizon: [0.44, 0.6, 0.14], hot: [1.0, 1.0, 0.72], gain: 0.95 },
	{ name: 'emerald gold', hero: [0.1, 0.96, 0.46], trace: [1.0, 0.78, 0.26], horizon: [0.06, 0.54, 0.34], hot: [1.0, 0.95, 0.62], gain: 1 }
];

// sRGB-ish authored values are used as linear emissive light; OKLab only
// governs how two families blend.
type Lab = [number, number, number];

function toLab([r, g, b]: Rgb): Lab {
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
	];
}

function fromLab([L, a, b]: Lab): [number, number, number] {
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		Math.max(0, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
		Math.max(0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
		Math.max(0, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
	];
}

/** Rotate a colour's hue in OKLab by `angle` radians and scale its chroma. */
function lean(lab: Lab, angle: number, chroma: number): Lab {
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	return [lab[0], (lab[1] * c - lab[2] * s) * chroma, (lab[1] * s + lab[2] * c) * chroma];
}

export type SignalPaletteOut = {
	hero: [number, number, number];
	trace: [number, number, number];
	horizon: [number, number, number];
	hot: [number, number, number];
	/** Very dark room tint (display-referred). */
	room: [number, number, number];
	gain: number;
};

export function createSignalPaletteOut(): SignalPaletteOut {
	return { hero: [0, 0, 0], trace: [0, 0, 0], horizon: [0, 0, 0], hot: [0, 0, 0], room: [0, 0, 0], gain: 1 };
}

export type SignalPaletteContext = {
	/** -1..1 genome lean within the family. */
	hueLean: number;
	/** -1 minor .. 1 major. */
	mode: number;
	/** 0..1 */
	energy: number;
	/** -1 cool .. 1 warm era grade. */
	warmth: number;
	/**
	 * -1 cool .. 1 warm phosphor temperature from the music (see voice.ts).
	 * Unlike the hue lean this pulls every role toward one warm or cool hue,
	 * so an acoustic set burns amber-ish and an ambient one runs cold in any
	 * family. Optional; 0 leaves the family as authored.
	 */
	temperature?: number;
};

// OKLab chroma directions the temperature pulls toward: sodium amber and a
// cold cyan-blue.
const WARM_AB: readonly [number, number] = [0.32, 0.95];
const COOL_AB: readonly [number, number] = [-0.55, -0.83];

const ROLES = ['hero', 'trace', 'horizon', 'hot'] as const;

export function resolveSignalPalette(
	from: number,
	to: number,
	mix: number,
	context: SignalPaletteContext,
	out: SignalPaletteOut
): SignalPaletteOut {
	const a = SIGNAL_PALETTES[((from % SIGNAL_PALETTES.length) + SIGNAL_PALETTES.length) % SIGNAL_PALETTES.length];
	const b = SIGNAL_PALETTES[((to % SIGNAL_PALETTES.length) + SIGNAL_PALETTES.length) % SIGNAL_PALETTES.length];
	const t = Math.min(1, Math.max(0, mix));
	// Major keys lean warm, minor cool; the genome adds its own small lean.
	const angle = context.hueLean * 0.16 + context.mode * 0.05 + context.warmth * 0.06;
	const chroma = 1 + context.energy * 0.12;
	for (const role of ROLES) {
		const la = toLab(a[role]);
		const lb = toLab(b[role]);
		const blended: Lab = [la[0] + (lb[0] - la[0]) * t, la[1] + (lb[1] - la[1]) * t, la[2] + (lb[2] - la[2]) * t];
		const temperature = Math.max(-1, Math.min(1, context.temperature ?? 0));
		if (temperature !== 0) {
			// Turn the hue toward amber or cold blue along the shorter arc and
			// keep the colourfulness, so the lean never passes through grey.
			const direction = temperature > 0 ? WARM_AB : COOL_AB;
			const pull = Math.abs(temperature) * (role === 'hot' ? 0.3 : 0.6);
			// Near-grey roles gain a little colour as the lean grows (from zero,
			// so the lean never switches on with a jump).
			const own = Math.hypot(blended[1], blended[2]);
			const c = own + Math.max(0, 0.09 - own) * pull;
			const hue = Math.atan2(blended[2], blended[1]);
			const goal = Math.atan2(direction[1], direction[0]);
			const delta = Math.atan2(Math.sin(goal - hue), Math.cos(goal - hue));
			const turned = hue + delta * pull;
			blended[1] = Math.cos(turned) * c;
			blended[2] = Math.sin(turned) * c;
		}
		const rgb = fromLab(lean(blended, role === 'hot' ? angle * 0.5 : angle, role === 'hot' ? 1 : chroma));
		const peak = Math.max(rgb[0], rgb[1], rgb[2], 1e-4);
		// Keep each role at full value so the shader owns brightness.
		const target = out[role];
		target[0] = rgb[0] / peak;
		target[1] = rgb[1] / peak;
		target[2] = rgb[2] / peak;
	}
	out.gain = a.gain + (b.gain - a.gain) * t;
	// The room is dark: only the light the instrument throws lights it (the
	// composite does that). This is the faint floor of a real blackout room,
	// a breath of the horizon role so the black is not digital zero.
	out.room[0] = 0.0015 + out.horizon[0] * 0.0015;
	out.room[1] = 0.0018 + out.horizon[1] * 0.0018;
	out.room[2] = 0.002 + out.horizon[2] * 0.0018;
	return out;
}
