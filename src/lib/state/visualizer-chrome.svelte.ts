export const VISUALIZER_CHROME_IDLE_MS = 2200;

export type VisualizerChromeMode = 'auto' | 'locked-hidden';
export type VisualizerChromeHold =
	| 'engine-pointer'
	| 'engine-focus'
	| 'player-pointer'
	| 'player-focus'
	| 'player-drag'
	| 'details';

const TRANSIENT_HOLDS = new Set<VisualizerChromeHold>([
	'engine-pointer',
	'engine-focus',
	'player-pointer',
	'player-focus',
	'player-drag'
]);

/**
 * One visibility clock for every control surface over the visualizer.
 *
 * `locked-hidden` is deliberately different from ordinary idle hiding: mouse
 * movement cannot undo an explicit Hide action. It takes another explicit
 * action (H, I, or a stage click) to return to automatic behavior.
 */
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

	private scheduleHide(delay = VISUALIZER_CHROME_IDLE_MS) {
		this.clearTimer();
		if (!this.active || this.mode === 'locked-hidden' || this.holds.size > 0) return;
		this.hideTimer = setTimeout(() => {
			this.hideTimer = null;
			if (this.active && this.mode === 'auto' && this.holds.size === 0) {
				this.visible = false;
			}
		}, delay);
	}

	activate() {
		this.clearTimer();
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
		// Outside the visualizer, the normal player bar is always present.
		this.visible = true;
	}

	/** Wake automatic chrome. Intentionally does nothing after a manual hide. */
	wake() {
		if (!this.active || this.mode === 'locked-hidden') return;
		this.visible = true;
		this.scheduleHide();
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

		this.holds.delete(hold);
		this.scheduleHide();
	}

	lockHidden() {
		if (!this.active) return;
		this.clearTimer();
		this.holds.clear();
		this.mode = 'locked-hidden';
		this.visible = false;
	}

	revealExplicitly() {
		if (!this.active) return;
		this.mode = 'auto';
		this.visible = true;
		this.scheduleHide();
	}

	/** Hide when the app loses focus without treating focus return as activity. */
	blur() {
		if (!this.active) return;
		this.clearTimer();
		for (const hold of TRANSIENT_HOLDS) this.holds.delete(hold);
		if (this.mode === 'auto') this.visible = false;
	}
}

const visualizerChrome = new VisualizerChromeState();

export function useVisualizerChrome() {
	return visualizerChrome;
}
