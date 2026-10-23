<script lang="ts">
	// Lab-only debug panel for the ensemble listener (/visualizer-test with
	// &ensemble=1, or the n key): live meters and event flashes for every
	// channel of journey.ensemble, so the band can be watched being heard.
	// Drawn on its own 2D canvas once per animation frame; it reads the shared
	// journey snapshot and never advances it.
	import { onDestroy, onMount } from 'svelte';
	import { useVisualizer } from '$lib/state/visualizer.svelte';
	import { ENSEMBLE_CHORD_QUALITIES, type EnsembleFrame, type EnsembleLayer } from '$lib/visualizer/ensemble';

	const vis = useVisualizer();
	const WIDTH = 372;
	const HEIGHT = 676;
	const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
	const QUALITY_SHORT: Record<string, string> = {
		major: '',
		minor: 'm',
		diminished: 'dim',
		augmented: 'aug',
		suspended: 'sus',
		dominant7: '7',
		none: ''
	};

	let canvas = $state<HTMLCanvasElement | null>(null);
	let raf = 0;
	// Event flashes: remember each serial and when it last moved.
	const seen = new Map<string, { serial: number; at: number }>();

	function flash(key: string, serial: number, now: number): number {
		const entry = seen.get(key);
		if (!entry) {
			seen.set(key, { serial, at: -1e9 });
			return 0;
		}
		if (entry.serial !== serial) {
			entry.serial = serial;
			entry.at = now;
		}
		return Math.max(0, 1 - (now - entry.at) / 350);
	}

	function draw(now: number) {
		raf = requestAnimationFrame(draw);
		const ctx = canvas?.getContext('2d');
		if (!ctx || !canvas) return;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		if (canvas.width !== WIDTH * dpr) {
			canvas.width = WIDTH * dpr;
			canvas.height = HEIGHT * dpr;
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, WIDTH, HEIGHT);
		ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
		ctx.fillRect(0, 0, WIDTH, HEIGHT);
		const e = vis.getJourney().ensemble;
		render(ctx, e, now);
	}

	function text(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, color = 'rgba(255,255,255,0.75)', size = 10) {
		ctx.fillStyle = color;
		ctx.font = `${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
		ctx.fillText(value, x, y);
	}

	/** A labelled horizontal meter; signed meters grow from the middle. */
	function meter(
		ctx: CanvasRenderingContext2D,
		label: string,
		value: number,
		x: number,
		y: number,
		width: number,
		color: string,
		signed = false
	) {
		text(ctx, label, x, y + 7, 'rgba(255,255,255,0.55)', 9);
		const mx = x + 62;
		const mw = width - 62;
		ctx.fillStyle = 'rgba(255,255,255,0.08)';
		ctx.fillRect(mx, y, mw, 8);
		ctx.fillStyle = color;
		if (signed) {
			const v = Math.max(-1, Math.min(1, value));
			const mid = mx + mw / 2;
			ctx.fillRect(Math.min(mid, mid + (v * mw) / 2), y, Math.abs((v * mw) / 2), 8);
			ctx.fillStyle = 'rgba(255,255,255,0.3)';
			ctx.fillRect(mid, y - 1, 1, 10);
		} else {
			ctx.fillRect(mx, y, Math.max(0, Math.min(1, value)) * mw, 8);
		}
	}

	function flashBox(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, level: number, color: string) {
		ctx.fillStyle = 'rgba(255,255,255,0.08)';
		ctx.fillRect(x, y, size, size);
		ctx.globalAlpha = Math.max(0, Math.min(1, level));
		ctx.fillStyle = color;
		ctx.fillRect(x, y, size, size);
		ctx.globalAlpha = 1;
	}

	function layerRow(ctx: CanvasRenderingContext2D, name: string, layer: EnsembleLayer, y: number, color: string, currentStep: number) {
		text(ctx, name, 10, y + 9);
		flashBox(ctx, 52, y, 12, layer.hit, color);
		meter(ctx, '', layer.activity, 6 + 64, y + 2, 120, color);
		ctx.fillStyle = `rgba(255,255,255,${0.15 + 0.6 * layer.present})`;
		ctx.fillRect(196, y + 2, 4, 8);
		// The learned 16-step pattern, the current step and the last hit.
		for (let k = 0; k < 16; k += 1) {
			const x = 206 + k * 9.5;
			const v = layer.pattern[k];
			ctx.fillStyle = k === currentStep ? 'rgba(255,255,255,0.28)' : k % 4 === 0 ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.05)';
			ctx.fillRect(x, y, 8, 12);
			if (v > 0.02) {
				ctx.globalAlpha = Math.min(1, 0.25 + v);
				ctx.fillStyle = color;
				ctx.fillRect(x + 1, y + 12 - 11 * v, 6, 11 * v);
				ctx.globalAlpha = 1;
			}
			if (k === layer.step && layer.sinceHit < 0.25) {
				ctx.strokeStyle = 'rgba(255,255,255,0.8)';
				ctx.strokeRect(x - 0.5, y - 0.5, 9, 13);
			}
		}
	}

	function render(ctx: CanvasRenderingContext2D, e: EnsembleFrame, now: number) {
		const h = e.harmony;
		const g = e.groove;
		let y = 16;
		// Header: tempo, grid and the chord.
		text(ctx, 'ensemble', 10, y, 'rgba(255,255,255,0.45)');
		text(
			ctx,
			`${e.grid.known ? e.grid.bpm.toFixed(1) : '---.-'} bpm  bar ${e.grid.bar}  ${(e.grid.barPhase * 4 + 1).toFixed(2)}`,
			80,
			y
		);
		y += 30;
		const chord = h.root < 0 ? '—' : `${NAMES[h.root]}${QUALITY_SHORT[h.quality]}`;
		const changeFlash = flash('chord', h.changeSerial, now);
		text(ctx, chord, 10, y, `rgba(255,${Math.round(255 - 90 * changeFlash)},${Math.round(255 - 200 * changeFlash)},1)`, 24);
		text(
			ctx,
			`key ${NAMES[h.key.tonic]}${h.key.mode === 'minor' ? 'm' : ''}  maj ${h.key.major.toFixed(2)}  stab ${h.key.stability.toFixed(2)}`,
			110,
			y - 12
		);
		text(
			ctx,
			`deg ${h.degree < 0 ? '-' : h.degree}  ${h.changesPerBar.toFixed(2)} chg/bar  bass ${e.bass.pitchClass < 0 ? '-' : NAMES[e.bass.pitchClass]}`,
			110,
			y
		);
		y += 14;

		// Drums and notes.
		const currentStep = Math.floor(e.grid.barPhase * 16 + 0.5) % 16;
		layerRow(ctx, 'kick', e.drums.kick, y, '#ff6b5a', currentStep);
		layerRow(ctx, 'snare', e.drums.snare, (y += 18), '#ffd166', currentStep);
		layerRow(ctx, 'hat', e.drums.hat, (y += 18), '#7ee8fa', currentStep);
		layerRow(ctx, 'perc', e.drums.perc, (y += 18), '#c792ea', currentStep);
		layerRow(ctx, 'notes', e.notes, (y += 18), '#9cff8f', currentStep);
		y += 26;

		// Groove.
		text(ctx, 'groove', 10, y, 'rgba(255,255,255,0.45)');
		text(ctx, `swing ${g.swingRatio.toFixed(2)}:1  conf ${g.confidence.toFixed(2)}`, 80, y);
		const fill = flash('fill', g.fillSerial, now);
		const drop = flash('dropout', g.dropoutSerial, now);
		const back = flash('return', g.drumReturnSerial, now);
		flashBox(ctx, 250, y - 9, 10, fill, '#ffd166');
		text(ctx, 'fill', 263, y, 'rgba(255,255,255,0.55)', 9);
		flashBox(ctx, 286, y - 9, 10, drop, '#ff6b5a');
		text(ctx, 'out', 299, y, 'rgba(255,255,255,0.55)', 9);
		flashBox(ctx, 320, y - 9, 10, back, '#9cff8f');
		text(ctx, 'in', 333, y, 'rgba(255,255,255,0.55)', 9);
		y += 8;
		const groove: [string, number][] = [
			['swing', g.swing],
			['syncop', g.syncopation],
			['regular', g.regularity],
			['fill', g.fillIntensity],
			['drums', g.drums],
			['breakdown', g.breakdown]
		];
		for (const [label, value] of groove) {
			meter(ctx, label, value, 10, y, 352, '#ffd166');
			y += 12;
		}
		y += 14;

		// Harmony: chroma with the chord's tones, quality probabilities.
		text(ctx, 'harmony', 10, y, 'rgba(255,255,255,0.45)');
		text(ctx, `tension ${h.tension.toFixed(2)}  conf ${h.confidence.toFixed(2)}`, 80, y);
		y += 6;
		for (let i = 0; i < 12; i += 1) {
			const x = 10 + i * 29;
			const v = h.chroma[i];
			ctx.fillStyle = 'rgba(255,255,255,0.06)';
			ctx.fillRect(x, y, 25, 34);
			ctx.fillStyle = i === h.root ? '#ff9f6b' : i === e.bass.pitchClass ? '#7ee8fa' : 'rgba(180,200,255,0.75)';
			ctx.fillRect(x, y + 34 - 34 * v, 25, 34 * v);
			text(ctx, NAMES[i], x + 3, y + 46, 'rgba(255,255,255,0.5)', 9);
		}
		y += 58;
		for (let q = 0; q < ENSEMBLE_CHORD_QUALITIES.length; q += 1) {
			meter(ctx, ENSEMBLE_CHORD_QUALITIES[q].slice(0, 9), h.qualities[q], 10, y, 352, q === h.qualityIndex ? '#ff9f6b' : 'rgba(180,200,255,0.6)');
			y += 12;
		}
		y += 14;

		// Bass, articulation, texture.
		text(ctx, 'bass', 10, y, 'rgba(255,255,255,0.45)');
		flashBox(ctx, 50, y - 9, 10, flash('bass', e.bass.noteSerial, now), '#7ee8fa');
		text(ctx, `interval ${e.bass.interval > 0 ? '+' : ''}${e.bass.interval}`, 68, y);
		y += 6;
		meter(ctx, 'stepwise', e.bass.stepwise, 10, y, 172, '#7ee8fa');
		meter(ctx, 'walking', e.bass.walking, 190, y, 172, '#7ee8fa');
		y += 12;
		meter(ctx, 'activity', e.bass.activity, 10, y, 172, '#7ee8fa');
		meter(ctx, 'level', e.bass.level, 190, y, 172, '#7ee8fa');
		y += 24;
		const a = e.articulation;
		text(ctx, 'articulation', 10, y, 'rgba(255,255,255,0.45)');
		text(ctx, `${a.noteRate.toFixed(1)} notes/s`, 110, y);
		y += 6;
		meter(ctx, 'legato', a.legato, 10, y, 172, '#9cff8f');
		meter(ctx, 'sustain', a.sustain, 190, y, 172, '#9cff8f');
		y += 12;
		meter(ctx, 'low', a.low, 10, y, 116, '#9cff8f');
		meter(ctx, 'mid', a.mid, 128, y, 116, '#9cff8f');
		meter(ctx, 'high', a.high, 246, y, 116, '#9cff8f');
		y += 12;
		meter(ctx, 'pad', a.pad, 10, y, 172, '#9cff8f');
		y += 24;
		const t = e.texture;
		text(ctx, 'texture', 10, y, 'rgba(255,255,255,0.45)');
		text(ctx, `${t.eventsPerSecond.toFixed(1)} events/s${t.stereoKnown ? '' : '  stereo n/a'}`, 80, y);
		y += 6;
		meter(ctx, 'density', t.density, 10, y, 172, '#c792ea');
		meter(ctx, 'tonality', t.tonality, 190, y, 172, '#c792ea');
		y += 12;
		meter(ctx, 'trend', t.trend, 10, y, 172, '#c792ea', true);
		meter(ctx, 'build', t.build, 190, y, 172, '#c792ea');
		y += 12;
		meter(ctx, 'register', t.register, 10, y, 172, '#c792ea', true);
		meter(ctx, 'width', t.width, 190, y, 172, '#c792ea');
		y += 12;
		meter(ctx, 'correl', t.correlation, 10, y, 172, '#c792ea', true);
	}

	onMount(() => {
		raf = requestAnimationFrame(draw);
	});

	onDestroy(() => {
		cancelAnimationFrame(raf);
	});
</script>

<canvas
	bind:this={canvas}
	data-ensemble-overlay
	class="pointer-events-none fixed right-3 bottom-3"
	style={`z-index: 320; width: ${WIDTH}px; height: ${HEIGHT}px; border-radius: 6px;`}
></canvas>
