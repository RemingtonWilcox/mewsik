export const VISUALIZER_CHROME_IDLE_MS = 2400;

/**
 * `auto`: chrome shows on activity and fades after a short idle.
 * `locked-hidden`: the listener asked for a clean picture (H or the Hide
 * button). Activity cannot bring chrome back; only another explicit action
 * (H again, a tap/click on the picture, or Tab) does.
 */
export type VisualizerChromeMode = 'auto' | 'locked-hidden';

/** Reasons the chrome must not idle out: a pointer resting on a control
 * surface, or keyboard focus inside the controls. */
export type VisualizerChromeHold = 'engines-pointer' | 'playback-pointer' | 'focus';

/** One visibility clock for every control drawn over the visualizer. */
class VisualizerChromeState {
	visible = $state(true);
	mode = $state<VisualizerChromeMode>('auto');

	private active = false;
	private holds = new Set<VisualizerChromeHold>();
	private hideTimer: ReturnType<typeof setTimeout> | null = null;

	private clearTimer() {
		if (this.hideTimer === null) return;
		clearTimeout(this.hideTimer);
		this.hideTimer = null;
	}

	private scheduleHide() {
		this.clearTimer();
		if (!this.active || this.mode === 'locked-hidden' || this.holds.size > 0) return;
		this.hideTimer = setTimeout(() => {
			this.hideTimer = null;
			if (this.active && this.mode === 'auto' && this.holds.size === 0) this.visible = false;
		}, VISUALIZER_CHROME_IDLE_MS);
	}

	activate() {
		this.holds.clear();
		this.active = true;
		this.mode = 'auto';
		this.visible = true;
		this.scheduleHide();
	}

	deactivate() {
		this.clearTimer();
		this.holds.clear();
		this.active = false;
		this.mode = 'auto';
		this.visible = true;
	}

	/** Activity: show and restart the idle clock. Ignored while locked. */
	wake() {
		if (!this.active || this.mode === 'locked-hidden') return;
		this.visible = true;
		this.scheduleHide();
	}

	/** Hide now but stay automatic, so the next activity brings chrome back. */
	dismiss() {
		if (!this.active || this.mode === 'locked-hidden') return;
		this.clearTimer();
		this.holds.clear();
		this.visible = false;
	}

	/** Hide and stay hidden until an explicit reveal. */
	lock() {
		if (!this.active) return;
		this.clearTimer();
		this.holds.clear();
		this.mode = 'locked-hidden';
		this.visible = false;
	}

	/** Explicitly show, leaving any lock. */
	reveal() {
		if (!this.active) return;
		this.mode = 'auto';
		this.visible = true;
		this.scheduleHide();
	}

	toggleLock() {
		if (this.mode === 'locked-hidden' || !this.visible) this.reveal();
		else this.lock();
	}

	setHold(hold: VisualizerChromeHold, held: boolean) {
		if (!this.active) return;
		if (held) {
			if (this.mode === 'locked-hidden') return;
			this.holds.add(hold);
			this.visible = true;
			this.clearTimer();
			return;
		}
		if (!this.holds.delete(hold)) return;
		this.scheduleHide();
	}

	/** The window lost focus: fade without counting the return as activity. */
	blur() {
		if (!this.active) return;
		this.clearTimer();
		this.holds.clear();
		if (this.mode === 'auto') this.visible = false;
	}
}

const visualizerChrome = new VisualizerChromeState();

export function useVisualizerChrome() {
	return visualizerChrome;
}
