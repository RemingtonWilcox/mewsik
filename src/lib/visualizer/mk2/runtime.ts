export type SomaQualityTier = 'eco' | 'balanced' | 'ultra';

export interface SomaQualityProfile {
	readonly tier: SomaQualityTier;
	/** Fraction of the display's bounded physical resolution rendered internally. */
	readonly scale: number;
	/** Absolute ceiling for every full-resolution HDR target. */
	readonly maxPixels: number;
	readonly frameRate: number;
	readonly raymarchSteps: number;
}

export const SOMA_MAX_PIXEL_RATIO = 1.5;

export const SOMA_QUALITY_PROFILES = {
	eco: {
		tier: 'eco',
		scale: 0.68,
		maxPixels: 1280 * 720,
		frameRate: 40,
		raymarchSteps: 46
	},
	balanced: {
		tier: 'balanced',
		scale: 0.84,
		maxPixels: 1600 * 900,
		frameRate: 50,
		raymarchSteps: 56
	},
	ultra: {
		tier: 'ultra',
		scale: 1,
		maxPixels: 1920 * 1080,
		frameRate: 60,
		raymarchSteps: 64
	}
} as const satisfies Record<SomaQualityTier, SomaQualityProfile>;

const SOMA_QUALITY_ORDER = ['eco', 'balanced', 'ultra'] as const;
const ADAPTIVE_EMA_ALPHA = 0.06;
const ADAPTIVE_DOWN_RATIO = 1.18;
const ADAPTIVE_STABLE_RATIO = 1.06;
const ADAPTIVE_DOWN_HOLD_MS = 2_400;
const ADAPTIVE_UP_HOLD_MS = 30_000;
const ADAPTIVE_MIN_WINDOW_MS = 1_200;
const ADAPTIVE_MAX_FOREGROUND_GAP_MS = 750;

const ECO_WORKLOAD_PIXELS = 6_000_000;
const BALANCED_WORKLOAD_PIXELS = 2_600_000;
const DEFAULT_HARDWARE_CONCURRENCY = 8;
const DEFAULT_DEVICE_MEMORY_GB = 8;

function clamp(value: number, low: number, high: number): number {
	return Math.min(high, Math.max(low, value));
}

function safeDimension(value: number): number {
	// A real CSS viewport will never approach this guard. It simply prevents a
	// malformed dimension from overflowing the workload and reduction math.
	return Number.isFinite(value) ? clamp(value, 1, 1_000_000) : 1;
}

function safePixelRatio(value: number): number {
	return Number.isFinite(value) ? clamp(value, 0.5, SOMA_MAX_PIXEL_RATIO) : 1;
}

function safeHardwareValue(value: number | undefined, fallback: number): number {
	return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function qualityIndex(tier: SomaQualityTier): number {
	switch (tier) {
		case 'eco':
			return 0;
		case 'balanced':
			return 1;
		case 'ultra':
			return 2;
	}
}

/**
 * Allocation-free frame-time governor for Soma's Auto mode. Hardware and
 * viewport selection remains the quality ceiling; runtime adaptation can only
 * step below it while a machine is missing frames. A downgrade needs sustained
 * pressure, while an upgrade is deliberately much slower so the renderer
 * cannot bounce between tiers around a threshold.
 */
export class SomaAutoQualityController {
	private tierIndex = 0;
	private ceilingIndex = 0;
	private rollingFrameRatio = 1;
	private observedMs = 0;
	private overloadedMs = 0;
	private stableMs = 0;

	constructor(initialTier: SomaQualityTier) {
		this.reset(initialTier);
	}

	get tier(): SomaQualityTier {
		return SOMA_QUALITY_ORDER[this.tierIndex];
	}

	get profile(): SomaQualityProfile {
		return SOMA_QUALITY_PROFILES[this.tier];
	}

	/** Start Auto from the normal hardware/viewport-selected tier. */
	reset(initialTier: SomaQualityTier): void {
		this.tierIndex = qualityIndex(initialTier);
		this.ceilingIndex = this.tierIndex;
		this.resetWindow();
	}

	/**
	 * Update Auto's hardware/viewport ceiling. A lower ceiling takes effect
	 * immediately; a higher one only becomes eligible after a fresh stable run.
	 */
	setCeiling(tier: SomaQualityTier): SomaQualityTier {
		const nextCeiling = qualityIndex(tier);
		if (nextCeiling === this.ceilingIndex) return this.tier;
		this.ceilingIndex = nextCeiling;
		if (this.tierIndex > nextCeiling) this.tierIndex = nextCeiling;
		this.resetWindow();
		return this.tier;
	}

	/**
	 * Record the interval between two frames Soma actually rendered. Returns the
	 * active tier so callers can switch profiles without allocating a result.
	 */
	observeFrame(elapsedMs: number): SomaQualityTier {
		if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return this.tier;

		// A hidden window, debugger stop, sleep, or long task resume is not useful
		// evidence of GPU throughput. Forget the partial vote instead of punishing it.
		if (elapsedMs > ADAPTIVE_MAX_FOREGROUND_GAP_MS) {
			this.resetWindow();
			return this.tier;
		}

		const expectedMs = 1000 / this.profile.frameRate;
		const frameRatio = clamp(elapsedMs / expectedMs, 0.5, 3);
		this.rollingFrameRatio +=
			(frameRatio - this.rollingFrameRatio) * ADAPTIVE_EMA_ALPHA;

		// Cap one sample's voting power. A single hitch should neither downgrade
		// immediately nor count as seconds of stability after the scheduler resumes.
		const voteMs = Math.min(elapsedMs, expectedMs * 2);
		this.observedMs += voteMs;

		if (this.rollingFrameRatio >= ADAPTIVE_DOWN_RATIO) {
			this.overloadedMs += voteMs;
			this.stableMs = 0;
		} else if (this.rollingFrameRatio <= ADAPTIVE_STABLE_RATIO) {
			this.overloadedMs = Math.max(0, this.overloadedMs - voteMs);
			this.stableMs += voteMs;
		} else {
			// The hysteresis band slowly erases both votes. Borderline jitter therefore
			// cannot preserve a nearly-complete decision forever.
			this.overloadedMs = Math.max(0, this.overloadedMs - voteMs * 0.35);
			this.stableMs = Math.max(0, this.stableMs - voteMs * 0.2);
		}

		if (
			this.observedMs >= ADAPTIVE_MIN_WINDOW_MS &&
			this.overloadedMs >= ADAPTIVE_DOWN_HOLD_MS &&
			this.tierIndex > 0
		) {
			this.tierIndex--;
			this.resetWindow();
		} else if (
			this.stableMs >= ADAPTIVE_UP_HOLD_MS &&
			this.tierIndex < this.ceilingIndex
		) {
			this.tierIndex++;
			this.resetWindow();
		}

		return this.tier;
	}

	private resetWindow(): void {
		this.rollingFrameRatio = 1;
		this.observedMs = 0;
		this.overloadedMs = 0;
		this.stableMs = 0;
	}
}

/**
 * Choose a conservative automatic tier from viewport workload and the small,
 * privacy-safe hardware hints available in Chromium/WebView. Display workload
 * wins over CPU hints: a 4K canvas must not allocate an ultra HDR graph merely
 * because it is connected to a high-core-count machine.
 */
export function selectSomaQuality(
	cssWidth: number,
	cssHeight: number,
	pixelRatio: number,
	hardwareConcurrency = DEFAULT_HARDWARE_CONCURRENCY,
	deviceMemoryGb = DEFAULT_DEVICE_MEMORY_GB
): SomaQualityProfile {
	const ratio = safePixelRatio(pixelRatio);
	const workloadPixels = safeDimension(cssWidth) * safeDimension(cssHeight) * ratio * ratio;
	const cores = safeHardwareValue(hardwareConcurrency, DEFAULT_HARDWARE_CONCURRENCY);
	const memoryGb = safeHardwareValue(deviceMemoryGb, DEFAULT_DEVICE_MEMORY_GB);

	if (cores <= 4 || memoryGb <= 4 || workloadPixels > ECO_WORKLOAD_PIXELS) {
		return SOMA_QUALITY_PROFILES.eco;
	}
	if (cores <= 8 || memoryGb < 8 || workloadPixels > BALANCED_WORKLOAD_PIXELS) {
		return SOMA_QUALITY_PROFILES.balanced;
	}
	return SOMA_QUALITY_PROFILES.ultra;
}

/**
 * Resolve Soma's drawing-buffer size while preserving the CSS aspect ratio and
 * enforcing the selected tier's absolute HDR pixel budget. The canvas still
 * fills the viewport; only its internal render resolution is bounded.
 */
export function somaBackingSize(
	cssWidth: number,
	cssHeight: number,
	pixelRatio: number,
	quality: SomaQualityTier | SomaQualityProfile = 'balanced'
): { width: number; height: number } {
	const profile = typeof quality === 'string' ? SOMA_QUALITY_PROFILES[quality] : quality;
	const ratio = safePixelRatio(pixelRatio) * profile.scale;
	let width = Math.max(1, Math.floor(safeDimension(cssWidth) * ratio));
	let height = Math.max(1, Math.floor(safeDimension(cssHeight) * ratio));
	const ceiling = Number.isFinite(profile.maxPixels)
		? Math.max(1, Math.floor(profile.maxPixels))
		: 1;
	const pixels = width * height;
	if (pixels > ceiling) {
		const reduction = Math.sqrt(ceiling / pixels);
		width = Math.max(1, Math.floor(width * reduction));
		height = Math.max(1, Math.floor(height * reduction));
	}
	return { width, height };
}
