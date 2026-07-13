// Signal stays intentionally small on the GPU: decay + trace in one phosphor
// pass, then one presentation pass. Musical range comes from the conductor and
// vertex geometry, not from stacking post-processing layers.

export const SIGNAL_SEGMENTS = 640;
export const SIGNAL_VERTEX_COUNT = SIGNAL_SEGMENTS * 6;
export const SIGNAL_TRACE_INSTANCES = 3;

const PARAMS_WGSL = /* wgsl */ `
struct Params {
	// xy: render resolution, z: elapsed seconds, w: frame delta
	resolutionTimeDt: vec4<f32>,
	// corrected bass, mid, treble, waveform RMS
	audio: vec4<f32>,
	// transient, raw beat phase, spectral centroid, chroma pitch class
	musical: vec4<f32>,
	// chroma strength, phosphor persistence, silence, integrated journey phase
	shape: vec4<f32>,
	// line width, directed energy, crest factor, spectral motion
	style: vec4<f32>,
	// beat pulse, phrase position, normalized tempo, downbeat gate
	clock: vec4<f32>,
	// tension, release, openness, boundary/impact pulse
	journey: vec4<f32>,
	// ellipse, Lissajous, ribbon, rosette weights
	forms: vec4<f32>,
	// base, accent, rim hue and saturation from the Tonnetz palette
	palette: vec4<f32>,
	// sub, kick, low body, musical mids
	bandsA: vec4<f32>,
	// presence, air, centroid velocity, harmonic/section asymmetry
	bandsB: vec4<f32>,
	// section progress, energy slope, lookahead energy, section energy
	context: vec4<f32>,
};
`;

const FULLSCREEN_WGSL = /* wgsl */ `
struct FullscreenOut {
	@builtin(position) position: vec4<f32>,
	@location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> FullscreenOut {
	var positions = array<vec2<f32>, 3>(
		vec2<f32>(-1.0, -1.0),
		vec2<f32>( 3.0, -1.0),
		vec2<f32>(-1.0,  3.0)
	);
	let position = positions[index];
	var out: FullscreenOut;
	out.position = vec4<f32>(position, 0.0, 1.0);
	out.uv = vec2<f32>(position.x * 0.5 + 0.5, 1.0 - (position.y * 0.5 + 0.5));
	return out;
}
`;

export const SIGNAL_DECAY_WGSL = /* wgsl */ `
${PARAMS_WGSL}
${FULLSCREEN_WGSL}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var phosphorSampler: sampler;
@group(0) @binding(2) var previousFrame: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let previous = textureSampleLevel(previousFrame, phosphorSampler, in.uv, 0.0).rgb;
	let persistencePerSixtieth = clamp(params.shape.y, 0.78, 0.955);
	let elapsedSixtieths = clamp(params.resolutionTimeDt.w * 60.0, 0.0, 60.0);
	let persistence = pow(persistencePerSixtieth, elapsedSixtieths);

	// Closed-form time-correct decay: identical trail duration on 60/90/144 Hz.
	let blackCutPerSixtieth = mix(0.0037, 0.0010, persistencePerSixtieth);
	let blackCut = blackCutPerSixtieth * (1.0 - persistence)
		/ max(1.0 - persistencePerSixtieth, 0.0001);
	let decayed = max(previous * persistence - vec3<f32>(blackCut), vec3<f32>(0.0));
	return vec4<f32>(decayed, 1.0);
}
`;

export const SIGNAL_TRACE_WGSL = /* wgsl */ `
${PARAMS_WGSL}

const TAU: f32 = 6.28318530718;
const SEGMENTS: u32 = ${SIGNAL_SEGMENTS}u;

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> bins: array<f32, 64>;

struct TraceOut {
	@builtin(position) position: vec4<f32>,
	@location(0) local: vec2<f32>,
	@location(1) color: vec3<f32>,
	@location(2) intensity: f32,
};

fn rotate2(point: vec2<f32>, angle: f32) -> vec2<f32> {
	let c = cos(angle);
	let s = sin(angle);
	return vec2<f32>(c * point.x - s * point.y, s * point.x + c * point.y);
}

fn hsvToRgb(hsv: vec3<f32>) -> vec3<f32> {
	let p = abs(fract(hsv.xxx + vec3<f32>(0.0, 0.6666667, 0.3333333)) * 6.0 - 3.0);
	return hsv.z * mix(vec3<f32>(1.0), clamp(p - 1.0, vec3<f32>(0.0), vec3<f32>(1.0)), hsv.y);
}

// Four closed contours form one continuous instrument. The CPU eases their
// weights over phrases/sections, so topology evolves without preset cuts.
fn orbitForm(t: f32, phase: f32, mid: f32) -> vec2<f32> {
	var p = vec2<f32>(
		sin(t * 3.0 + phase),
		sin(t * 2.0 - phase * 0.71 + sin(t + phase * 0.2) * mid * 0.28)
	);
	p += vec2<f32>(sin(t * 5.0 - phase * 0.42), cos(t * 7.0 + phase * 0.31))
		* mid * 0.11;
	return p;
}

fn ellipseForm(t: f32, phase: f32, body: f32) -> vec2<f32> {
	let angle = t + phase * 0.14;
	return vec2<f32>(
		cos(angle) * (0.92 + body * 0.08),
		sin(angle) * (0.72 + body * 0.16)
	);
}

fn rosetteForm(t: f32, phase: f32, mid: f32) -> vec2<f32> {
	let angle = t + phase * 0.12;
	let radius = 0.72 + cos(t * 5.0 - phase * 0.36) * (0.16 + mid * 0.07);
	return vec2<f32>(cos(angle), sin(angle)) * radius * 1.18;
}

fn ribbonForm(t: f32, phase: f32, presence: f32) -> vec2<f32> {
	let x = sin(t + phase * 0.38) + sin(t * 3.0 - phase * 0.17) * 0.13;
	let y = sin(t * 3.0 - phase * 0.52) * 0.72
		+ sin(t * 5.0 + phase * 0.23) * (0.07 + presence * 0.05);
	return vec2<f32>(x, y);
}

// The stream is mono, so this is vectorscope-inspired rather than a fake L/R
// phase plot. Frequency, rhythm, harmony and long-form context deform one trace.
fn signalPoint(index: u32, instance: u32) -> vec2<f32> {
	let fraction = f32(index) / f32(SEGMENTS);
	let t = fraction * TAU;
	let bass = params.audio.x;
	let mid = params.audio.y;
	let treble = params.audio.z;
	let rms = params.audio.w;
	let transient = params.musical.x;
	let centroid = params.musical.z;
	let chroma = params.musical.w;
	let chromaStrength = params.shape.x;
	let time = params.resolutionTimeDt.z;
	let echo = f32(instance);
	let beatPulse = params.clock.x;
	let phraseAngle = params.clock.y * TAU;
	let tempo = params.clock.z;
	let downbeat = params.clock.w;
	let tension = params.journey.x;
	let release = params.journey.y;
	let openness = params.journey.z;
	let impact = params.journey.w;
	let sub = params.bandsA.x;
	let kick = params.bandsA.y;
	let body = params.bandsA.z;
	let musicalMids = params.bandsA.w;
	let presence = params.bandsB.x;
	let air = params.bandsB.y;
	let centroidVelocity = params.bandsB.z;
	let asymmetry = params.bandsB.w;
	let spectralMotion = params.style.w;
	let phase = params.shape.w + echo * (0.025 + transient * 0.055 + impact * 0.045);

	let formTotal = max(dot(params.forms, vec4<f32>(1.0)), 0.0001);
	let formWeights = params.forms / formTotal;
	var point = ellipseForm(t, phase, body) * formWeights.x
		+ orbitForm(t, phase, musicalMids) * formWeights.y
		+ ribbonForm(t, phase, presence) * formWeights.z
		+ rosetteForm(t, phase, musicalMids) * formWeights.w;

	// Chroma/key and section asymmetry influence posture, not only hue. Gating by
	// tonal strength prevents noisy/atonal material from jerking the geometry.
	let harmonicSkew = sin(chroma * TAU + params.palette.x * TAU) * chromaStrength;
	point.x += point.y * (harmonicSkew * 0.10 + asymmetry * 0.16);
	point.y *= 1.0 - tension * 0.13 + release * 0.06;
	point.x *= 1.0 + tension * 0.08 + abs(asymmetry) * 0.08;
	point = rotate2(
		point,
		sin(phraseAngle) * (0.035 + tempo * 0.045)
			+ harmonicSkew * 0.07
			+ centroidVelocity * 0.12
			+ params.context.y * 0.055
	);

	// The spectrum travels slowly around the contour over each phrase. Neighbor
	// contrast exposes filter motion while retaining the same coherent subject.
	let spectralPosition = fract(fraction + params.clock.y * 0.125 + params.shape.w * 0.006);
	let bandIndex = min(u32(floor(spectralPosition * 64.0)), 63u);
	let previousIndex = max(bandIndex, 1u) - 1u;
	let nextIndex = min(bandIndex + 1u, 63u);
	let band = clamp(bins[bandIndex], 0.0, 1.0);
	let neighbor = (clamp(bins[previousIndex], 0.0, 1.0) + clamp(bins[nextIndex], 0.0, 1.0)) * 0.5;
	let localContrast = band - neighbor;
	let radial = normalize(point + vec2<f32>(0.0001, 0.0002));
	point += radial * (
		(band - 0.35) * (0.010 + body * 0.018 + spectralMotion * 0.014)
			+ localContrast * (0.018 + spectralMotion * 0.040)
	);

	// Presence and air etch detail. Tempo changes travel speed, while centroid
	// and its velocity make opening/closing filters visibly sweep the contour.
	let detail = band * (0.004 + presence * 0.020 + air * 0.028)
		+ abs(localContrast) * spectralMotion * 0.022;
	let detailSpeed = 0.18 + tempo * 0.42 + centroid * 0.18;
	point += vec2<f32>(
		cos(t * 17.0 + time * detailSpeed + phase + phraseAngle * 0.20),
		sin(t * 19.0 - time * detailSpeed * 0.82 - phase)
	) * detail;

	// Hierarchy: sub/body establish scale, kick/beat strike it, build tension
	// contracts it, and release/payoff opens it. This is deliberately much wider
	// than v1 while still leaving negative space around the trace.
	let opennessScale = mix(0.47, 0.68, openness);
	let impactScale = beatPulse * (0.018 + kick * 0.050)
		+ downbeat * (0.016 + params.style.z * 0.030)
		+ impact * 0.050;
	let bodyScale = opennessScale + sub * 0.055 + body * 0.040 + rms * 0.035
		- tension * 0.055 + release * 0.075 + params.context.z * 0.025
		+ params.context.w * 0.020;
	point *= bodyScale * (1.0 + impactScale);
	point *= 1.0 + sin(t + phraseAngle) * bass * (0.025 + kick * 0.025);

	if (instance > 0u) {
		let echoDrive = max(transient, max(impact, release * 0.72));
		point = rotate2(point, -echo * (0.010 + echoDrive * 0.030 + tension * 0.008));
		point *= 1.0 + echo * (0.009 + echoDrive * 0.025);
	}

	let resolution = params.resolutionTimeDt.xy;
	let aspect = resolution.x / max(resolution.y, 1.0);
	let fit = select(vec2<f32>(1.0, aspect), vec2<f32>(1.0 / aspect, 1.0), aspect >= 1.0);
	return point * fit;
}

@vertex
fn vs_main(
	@builtin(vertex_index) vertexIndex: u32,
	@builtin(instance_index) instance: u32
) -> TraceOut {
	let segment = vertexIndex / 6u;
	let corner = vertexIndex % 6u;
	let useEnd = corner == 1u || corner == 4u || corner == 5u;
	let positiveSide = corner == 2u || corner == 3u || corner == 5u;

	let start = signalPoint(segment, instance);
	let end = signalPoint(segment + 1u, instance);
	let resolution = params.resolutionTimeDt.xy;
	let startPx = start * resolution * 0.5;
	let endPx = end * resolution * 0.5;
	let tangentPx = normalize(endPx - startPx + vec2<f32>(0.0001, 0.0));
	let normalPx = vec2<f32>(-tangentPx.y, tangentPx.x);

	let echo = f32(instance);
	let widthScale = select(1.0, max(0.58, 0.84 - echo * 0.11), instance > 0u);
	let halfWidthPx = params.style.x * 2.45 * widthScale;
	let side = select(-1.0, 1.0, positiveSide);
	let offset = normalPx * halfWidthPx * side * 2.0 / resolution;
	let base = select(start, end, useEnd);

	let saturation = clamp(params.palette.w, 0.32, 0.94);
	let harmonicBase = hsvToRgb(vec3<f32>(params.palette.x, saturation * 0.82, 1.0));
	let harmonicAccent = hsvToRgb(vec3<f32>(params.palette.y, saturation, 1.0));
	let harmonicRim = hsvToRgb(vec3<f32>(params.palette.z, saturation * 0.72, 1.0));
	let phosphorGreen = vec3<f32>(0.08, 1.00, 0.72);
	let electricBlue = vec3<f32>(0.22, 0.62, 1.00);
	let signalBase = mix(phosphorGreen, electricBlue, 0.24 + params.musical.z * 0.34);
	let harmonicMix = 0.12 + params.shape.x * 0.34;
	let primary = mix(signalBase, mix(harmonicBase, harmonicRim, params.bandsB.x * 0.28), harmonicMix);
	let warmTransient = vec3<f32>(1.00, 0.31, 0.10);
	let accent = mix(warmTransient, harmonicAccent, 0.20 + params.shape.x * 0.48);

	let signalGate = (1.0 - params.shape.z) * smoothstep(0.005, 0.055, params.audio.w);
	let mainIntensity = (
		0.060 + params.style.y * 0.065 + params.bandsA.y * 0.022 + params.journey.w * 0.030
	) * signalGate;
	let firstEcho = (
		params.musical.x * 0.105 + params.journey.w * 0.075 + params.journey.y * 0.035
	) * signalGate;
	let secondEcho = (
		params.journey.w * 0.045 + params.journey.y * 0.055 + params.clock.w * 0.025
	) * signalGate;

	var out: TraceOut;
	out.position = vec4<f32>(base + offset, 0.0, 1.0);
	out.local = vec2<f32>(select(-1.0, 1.0, useEnd), side);
	if (instance == 0u) {
		out.color = primary;
		out.intensity = mainIntensity;
	} else if (instance == 1u) {
		out.color = accent;
		out.intensity = firstEcho;
	} else {
		out.color = mix(accent, harmonicRim, 0.55);
		out.intensity = secondEcho;
	}
	return out;
}

@fragment
fn fs_main(in: TraceOut) -> @location(0) vec4<f32> {
	let distanceFromCore = abs(in.local.y);
	let core = 1.0 - smoothstep(0.16, 0.29, distanceFromCore);
	let halo = exp(-distanceFromCore * distanceFromCore * 5.0) * 0.16;
	let light = (core * 1.32 + halo) * in.intensity;
	return vec4<f32>(in.color * light, 0.0);
}
`;

export const SIGNAL_COMPOSITE_WGSL = /* wgsl */ `
${PARAMS_WGSL}
${FULLSCREEN_WGSL}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var phosphorSampler: sampler;
@group(0) @binding(2) var phosphorFrame: texture_2d<f32>;

fn ringLine(radius: f32, targetRadius: f32, width: f32) -> f32 {
	return 1.0 - smoothstep(width, width * 2.2, abs(radius - targetRadius));
}

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let resolution = params.resolutionTimeDt.xy;
	let aspect = resolution.x / max(resolution.y, 1.0);
	var scopePoint = in.uv * 2.0 - vec2<f32>(1.0);
	scopePoint.x *= aspect;
	let radius = length(scopePoint);
	let pixel = 1.0 / max(resolution.y, 1.0);

	let axisX = 1.0 - smoothstep(pixel * 0.6, pixel * 1.8, abs(scopePoint.x));
	let axisY = 1.0 - smoothstep(pixel * 0.6, pixel * 1.8, abs(scopePoint.y));
	let rings = ringLine(radius, 0.25, pixel)
		+ ringLine(radius, 0.50, pixel)
		+ ringLine(radius, 0.75, pixel);
	let gridPulse = 0.86 + params.clock.x * 0.10 + params.journey.x * 0.08;
	let graticule = clamp(((axisX + axisY) * 0.45 + rings * 0.30) * gridPulse, 0.0, 1.0);

	let vignette = 1.0 - smoothstep(0.62, 1.45, radius);
	let harmonicTint = vec3<f32>(0.004, 0.010, 0.012)
		+ vec3<f32>(0.004, 0.012, 0.010) * params.shape.x;
	let background = vec3<f32>(0.0015, 0.0045, 0.0080)
		+ harmonicTint * graticule
		+ vec3<f32>(0.002, 0.008, 0.012) * vignette;

	let stored = textureSampleLevel(phosphorFrame, phosphorSampler, in.uv, 0.0).rgb;
	let exposure = 1.62 + params.style.y * 0.22 + params.journey.w * 0.20;
	let signal = vec3<f32>(1.0) - exp(-stored * exposure);
	let color = (background + signal) * (0.72 + vignette * 0.28);
	return vec4<f32>(color, 1.0);
}
`;
