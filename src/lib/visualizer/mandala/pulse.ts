// Heard transients. Mandala answers the beat only from what the audio
// actually did this frame: a kick is a sharp rise of the kick/sub band
// envelope over its own slow context (spectrum.deltas), a spark is any other
// onset (snare, strum, hat). Nothing here reads the predicted beat clock, so
// on a stream whose clock phase is off the response still lands on the drum.
//
// The outputs are envelopes the renderer turns into *structure*: a travel
// surge, a fold spring kick and a sparse scatter of local sparks. None of
// them is allowed to lift the whole frame.

export type PulseInput = {
	dt: number;
	/** spectrum.deltas.kick / .sub: fast minus slow, normalised, -1..1. */
	kickDelta: number;
	subDelta: number;
	/** spectrum.levels.kick / .sub: the band levels, 0..1. */
	kickLevel: number;
	subLevel: number;
	/** The analyser's onset flag this frame. */
	onset: boolean;
	/** spectrum.novelty, 0..1. */
	novelty: number;
	/** 0..1 how loud the music is (quiet passages breathe, they do not pulse). */
	loudness: number;
	/** 0..1 tempo character: fast music decays faster. */
	tempo: number;
};

export class HeardPulse {
	/** Kick envelope: jumps to the hit strength, decays in ~0.2 s. */
	hit = 0;
	/** Random 0..1 per kick, so each kick lights a different scatter. */
	hitSeed = 0.37;
	/** Kicks heard so far. */
	hits = 0;
	/** Strength of the latest kick, 0..1. */
	lastStrength = 0;
	/** Seconds since the latest kick. */
	sinceHit = 10;
	/** Onset spark envelope and its seed. */
	spark = 0;
	sparkSeed = 0.71;
	sparks = 0;
	private sinceSpark = 10;
	private armed = true;
	private previousKick = 0;
	private previousSub = 0;
	private attackPeak = 0.25;
	private sparkArmed = true;
	private peak = 0.35;
	private rng = 0x9e3779b9;

	private random(): number {
		// xorshift32: deterministic, cheap, independent of Math.random.
		let x = this.rng | 0;
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		this.rng = x >>> 0;
		return (this.rng & 0xffffff) / 0x1000000;
	}

	update(input: PulseInput): void {
		const dt = Math.min(0.25, Math.max(0, input.dt));
		this.sinceHit += dt;
		this.sinceSpark += dt;
		// A kick is the band's attack: its level jumping within a frame or two.
		// The attack, not the level, so a loud sustained bass line does not
		// hold the trigger.
		const attack = Math.max(input.kickLevel - this.previousKick, (input.subLevel - this.previousSub) * 0.8);
		this.previousKick = input.kickLevel;
		this.previousSub = input.subLevel;
		const rise = Math.max(0, Math.max(input.kickDelta, input.subDelta * 0.8));
		const attackScale = dt > 0 ? Math.min(2, Math.max(0.5, (1 / 60) / dt)) : 1;
		const sharp = attack * attackScale;
		const threshold = Math.max(0.05, this.attackPeak * 0.28);
		if (!this.armed && sharp < threshold * 0.3) this.armed = true;
		const loud = Math.min(1, Math.max(0, input.loudness));
		// The attack alone decides (a swell has none); the delta only weighs it,
		// since after a section change the slow context can sit above the drum.
		if (this.armed && sharp > threshold && input.kickLevel > 0.08 && this.sinceHit > 0.11) {
			this.armed = false;
			const relative = Math.min(1.4, sharp / Math.max(0.1, this.attackPeak));
			const strength = Math.min(1, Math.max(0.15, relative * 0.7 + rise * 0.3)) * (0.35 + loud * 0.65);
			this.attackPeak += (sharp - this.attackPeak) * 0.25;
			this.peak += (rise - this.peak) * 0.25;
			this.hit = Math.max(this.hit, strength);
			this.lastStrength = strength;
			this.hitSeed = this.random();
			this.hits += 1;
			this.sinceHit = 0;
		}
		this.attackPeak += (0.18 - this.attackPeak) * (1 - Math.exp(-dt / 12));
		// Without kicks the trigger slowly relaxes toward a softer drum.
		this.peak += (0.3 - this.peak) * (1 - Math.exp(-dt / 12));
		const tau = 0.12 + (1 - Math.min(1, Math.max(0, input.tempo))) * 0.14;
		this.hit *= Math.exp(-dt / tau);

		// Sparks: any onset that is not this frame's kick.
		const onset = input.onset || input.novelty > 0.6;
		if (!onset && input.novelty < 0.4) this.sparkArmed = true;
		if (onset && this.sparkArmed && this.sinceSpark > 0.09 && this.sinceHit > 0.05) {
			this.sparkArmed = false;
			this.spark = Math.max(this.spark, 0.4 + loud * 0.6);
			this.sparkSeed = this.random();
			this.sparks += 1;
			this.sinceSpark = 0;
		}
		this.spark *= Math.exp(-dt / 0.11);
	}
}
