export const PRISM_FRAME_RATE = 60;
export const PRISM_FRAME_INTERVAL_MS = 1000 / PRISM_FRAME_RATE;
export const PRISM_MAX_INTERNAL_PIXELS = 1920 * 1080;
export const PRISM_MAX_PIXEL_RATIO = 3;

function clamp(value: number, low: number, high: number): number {
	return Math.min(high, Math.max(low, value));
}

function safeDimension(value: number): number {
	return Number.isFinite(value) ? Math.max(1, value) : 1;
}

/**
 * Resolve Prism's drawing-buffer size without allowing high-DPI or 4K displays
 * to multiply every HDR feedback texture beyond the renderer's fixed budget.
 * The CSS canvas still fills the window; only its internal working resolution
 * is reduced, with the original aspect ratio preserved.
 */
export function prismBackingSize(
	cssWidth: number,
	cssHeight: number,
	pixelRatio: number,
	maxPixels = PRISM_MAX_INTERNAL_PIXELS
): { width: number; height: number } {
	const ratio = Number.isFinite(pixelRatio)
		? clamp(pixelRatio, 1, PRISM_MAX_PIXEL_RATIO)
		: 1;
	let width = Math.max(1, Math.floor(safeDimension(cssWidth) * ratio));
	let height = Math.max(1, Math.floor(safeDimension(cssHeight) * ratio));
	const ceiling = Number.isFinite(maxPixels) ? Math.max(1, Math.floor(maxPixels)) : 1;
	const pixels = width * height;
	if (pixels > ceiling) {
		const reduction = Math.sqrt(ceiling / pixels);
		width = Math.max(1, Math.floor(width * reduction));
		height = Math.max(1, Math.floor(height * reduction));
	}
	return { width, height };
}

/**
 * Reusable fixed-rate requestAnimationFrame gate. It retains fractional display
 * timing on 75/90/120/144 Hz monitors while dropping obsolete catch-up frames
 * after a stall or background pause.
 */
export class FixedFrameScheduler {
	private tickAt: number | null = null;
	private renderBudgetMs: number;
	private lastRenderedAt: number | null = null;

	constructor(
		readonly intervalMs = PRISM_FRAME_INTERVAL_MS,
		private readonly toleranceMs = 0.25
	) {
		this.renderBudgetMs = intervalMs;
	}

	reset(): void {
		this.tickAt = null;
		this.renderBudgetMs = this.intervalMs;
		this.lastRenderedAt = null;
	}

	/** Return elapsed render seconds when a frame is due, otherwise null. */
	next(nowMs: number): number | null {
		if (!Number.isFinite(nowMs)) return null;
		if (this.tickAt === null) {
			this.tickAt = nowMs;
			this.renderBudgetMs = this.intervalMs;
		} else {
			const tickElapsed = Math.max(0, nowMs - this.tickAt);
			this.tickAt = nowMs;
			this.renderBudgetMs = Math.min(
				this.intervalMs * 4,
				this.renderBudgetMs + tickElapsed
			);
		}
		if (this.renderBudgetMs + this.toleranceMs < this.intervalMs) return null;

		let remainderMs = this.renderBudgetMs - this.intervalMs;
		if (remainderMs >= this.intervalMs) {
			const completedIntervals = Math.floor(remainderMs / this.intervalMs);
			remainderMs -= completedIntervals * this.intervalMs;
			// Exact multiples can land one floating-point epsilon below the next
			// interval. Treat that as zero rather than emitting a stale catch-up frame.
			if (remainderMs + this.toleranceMs >= this.intervalMs) remainderMs = 0;
		}
		this.renderBudgetMs = Math.max(0, remainderMs);

		const elapsedMs =
			this.lastRenderedAt === null
				? this.intervalMs
				: Math.max(1, nowMs - this.lastRenderedAt);
		this.lastRenderedAt = nowMs;
		return clamp(elapsedMs / 1000, 0.001, 1);
	}
}

function mix32(value: number): number {
	let mixed = value >>> 0;
	mixed ^= mixed >>> 16;
	mixed = Math.imul(mixed, 0x7feb352d);
	mixed ^= mixed >>> 15;
	mixed = Math.imul(mixed, 0x846ca68b);
	mixed ^= mixed >>> 16;
	return mixed >>> 0;
}

/** Stable 0..1 event value derived from the current musical journey. */
export function prismEventUnit(
	seed: number,
	sourceEpoch: number,
	eventIndex: number,
	channel = 0
): number {
	const normalizedSeed = Number.isFinite(seed) ? seed - Math.floor(seed) : 0.5;
	const seedWord = Math.floor(normalizedSeed * 0x1_0000_0000) >>> 0;
	const epochWord = Number.isFinite(sourceEpoch) ? Math.floor(sourceEpoch) | 0 : 0;
	const eventWord = Number.isFinite(eventIndex) ? Math.floor(eventIndex) | 0 : 0;
	const channelWord = Number.isFinite(channel) ? Math.floor(channel) | 0 : 0;
	return (
		mix32(
			seedWord ^
				Math.imul(epochWord + 1, 0x9e3779b1) ^
				Math.imul(eventWord + 1, 0x85ebca6b) ^
				Math.imul(channelWord + 1, 0xc2b2ae35)
		) / 0x1_0000_0000
	);
}
