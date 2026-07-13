// The Signal engine deliberately keeps its GPU graph small: one pass decays
// the previous phosphor buffer and draws the trace, then one pass presents it.
// Geometry is generated in the vertex shader, so there are no per-frame mesh
// uploads and no compute workload.

export const SIGNAL_SEGMENTS = 640;
export const SIGNAL_VERTEX_COUNT = SIGNAL_SEGMENTS * 6;

const PARAMS_WGSL = /* wgsl */ `
struct Params {
	// xy: render resolution, z: elapsed seconds, w: frame delta
	resolutionTimeDt: vec4<f32>,
	// bass, mid, treble, rms
	audio: vec4<f32>,
	// transient, beat phase, spectral centroid, chroma key (0..1)
	musical: vec4<f32>,
	// chroma strength, feedback persistence, silence amount, integrated phase
	shape: vec4<f32>,
	// line width in pixels, energy, reserved, reserved
	style: vec4<f32>,
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
	let persistencePerSixtieth = clamp(params.shape.y, 0.78, 0.95);
	let elapsedSixtieths = clamp(params.resolutionTimeDt.w * 60.0, 0.0, 60.0);
	let persistence = pow(persistencePerSixtieth, elapsedSixtieths);

	// A small black-level subtraction keeps persistence finite without spatial
	// blur. Scale both decay terms by elapsed time so 60, 90, and 144 Hz
	// displays produce the same trail duration. This is the closed form of
	// repeatedly applying: next = previous * persistence - blackCut.
	let blackCutPerSixtieth = mix(0.0035, 0.0012, persistencePerSixtieth);
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

// The audio feature stream currently exposes mono spectrum bands rather than
// raw stereo samples. This builds a vectorscope-like XY trace from those bands
// without pretending it is a literal left/right phase plot.
fn signalPoint(index: u32, instance: u32) -> vec2<f32> {
	let fraction = f32(index) / f32(SEGMENTS);
	let t = fraction * TAU;
	let bass = params.audio.x;
	let mid = params.audio.y;
	let treble = params.audio.z;
	let rms = params.audio.w;
	let transient = params.musical.x;
	let beatPhase = params.musical.y * TAU;
	let time = params.resolutionTimeDt.z;
	let echo = f32(instance);
	let phase = params.shape.w + echo * (0.035 + transient * 0.07);

	// Stable 3:2 Lissajous skeleton. Mids bend that one subject rather than
	// cross-fading unrelated motifs, so its identity survives every song state.
	var point = vec2<f32>(
		sin(t * 3.0 + phase),
		sin(t * 2.0 - phase * 0.71 + sin(t + phase * 0.2) * mid * 0.24)
	);
	point += vec2<f32>(
		sin(t * 5.0 - phase * 0.42),
		cos(t * 7.0 + phase * 0.31)
	) * mid * 0.105;

	// Each part of the loop samples a corresponding spectrum band. Highs only
	// etch fine detail into the main contour; they never become a second layer.
	let bandIndex = min((index * 64u) / SEGMENTS, 63u);
	let band = sqrt(clamp(bins[bandIndex], 0.0, 1.0));
	let detail = band * (0.005 + treble * 0.029);
	point += vec2<f32>(
		cos(t * 17.0 + time * 0.34 + phase),
		sin(t * 19.0 - time * 0.27 - phase)
	) * detail;

	// Bass moves the body as a whole. Beat phase supplies a restrained breathing
	// term, not an always-on camera motion.
	let beatBreath = sin(beatPhase) * bass * 0.028;
	let bodyScale = 0.55 + bass * 0.105 + rms * 0.055 + beatBreath;
	point *= bodyScale * (1.0 + sin(t + beatPhase) * bass * 0.035);

	if (instance > 0u) {
		// A single short-lived displaced echo fires on transients. It is a reading
		// of the same signal, not another competing visual motif.
		point = rotate2(point, -0.014 - transient * 0.026);
		point *= 1.012 + transient * 0.026;
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
	let halfWidthPx = params.style.x * mix(2.55, 1.95, echo);
	let side = select(-1.0, 1.0, positiveSide);
	let offset = normalPx * halfWidthPx * side * 2.0 / resolution;
	let base = select(start, end, useEnd);

	let chromaAngle = params.musical.w * TAU;
	let chromaStrength = params.shape.x;
	let palettePosition = 0.5 + 0.5 * sin(chromaAngle + 0.7);
	let phosphorGreen = vec3<f32>(0.08, 1.00, 0.72);
	let electricBlue = vec3<f32>(0.22, 0.62, 1.00);
	let primary = mix(phosphorGreen, electricBlue, 0.18 + palettePosition * chromaStrength * 0.58);
	let accent = vec3<f32>(1.00, 0.33, 0.12);
	let transient = params.musical.x;

	var out: TraceOut;
	out.position = vec4<f32>(base + offset, 0.0, 1.0);
	out.local = vec2<f32>(select(-1.0, 1.0, useEnd), side);
	out.color = mix(primary, accent, echo * (0.68 + transient * 0.22));
	let signalGate = (1.0 - params.shape.z) * smoothstep(0.006, 0.065, params.audio.w);
	let mainIntensity = (0.070 + params.style.y * 0.047) * signalGate;
	let echoIntensity = transient * (0.075 + params.audio.z * 0.075) * signalGate;
	out.intensity = mix(mainIntensity, echoIntensity, echo);
	return out;
}

@fragment
fn fs_main(in: TraceOut) -> @location(0) vec4<f32> {
	let distanceFromCore = abs(in.local.y);
	let core = 1.0 - smoothstep(0.17, 0.28, distanceFromCore);
	let halo = exp(-distanceFromCore * distanceFromCore * 5.2) * 0.14;
	let light = (core * 1.28 + halo) * in.intensity;
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

	// One restrained scope graticule gives the trace scale and precision. It is
	// intentionally near the black floor so negative space still owns the frame.
	let axisX = 1.0 - smoothstep(pixel * 0.6, pixel * 1.8, abs(scopePoint.x));
	let axisY = 1.0 - smoothstep(pixel * 0.6, pixel * 1.8, abs(scopePoint.y));
	let rings = ringLine(radius, 0.25, pixel)
		+ ringLine(radius, 0.50, pixel)
		+ ringLine(radius, 0.75, pixel);
	let graticule = clamp((axisX + axisY) * 0.45 + rings * 0.30, 0.0, 1.0);

	let vignette = 1.0 - smoothstep(0.62, 1.45, radius);
	let background = vec3<f32>(0.0015, 0.0045, 0.0080)
		+ vec3<f32>(0.005, 0.020, 0.024) * graticule
		+ vec3<f32>(0.002, 0.008, 0.012) * vignette;

	let stored = textureSampleLevel(phosphorFrame, phosphorSampler, in.uv, 0.0).rgb;
	let signal = vec3<f32>(1.0) - exp(-stored * 1.72);
	let color = (background + signal) * (0.72 + vignette * 0.28);
	return vec4<f32>(color, 1.0);
}
`;
