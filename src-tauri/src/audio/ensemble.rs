//! Raw ensemble features for the visualizer's ensemble listener
//! (src/lib/visualizer/ensemble.ts): a 12-bin chroma, a bass-register
//! chroma, per-layer onset strengths (kick, snare/clap, hats, other
//! percussion, tonal notes) and the stereo image, once per analyzer frame.
//!
//! This is the native twin of src/lib/audio/ensemble-features.ts, which runs
//! the same algorithm on Web Audio analyser data in the browser lab; the
//! constants and the order of operations match line for line. Both read
//! Blackman-windowed spectra scaled |X|/N (what an AnalyserNode reports), so
//! native and lab hear the same thing:
//!   * a 2048-point spectrum for onsets: per-band spectral flux of the
//!     log-compressed spectrum, normalised by a peak follower with an
//!     absolute floor, combined into one detection function per layer, fired
//!     on a local peak over an adaptive threshold (one frame late) and
//!     confirmed with the following frame (drums persist in their band, a
//!     note's attack splatter does not; flat noise marks a drum);
//!   * an 8192-point spectrum for pitch: interpolated peaks folded into
//!     pitch classes over 100 Hz - 5 kHz and over 40 - 250 Hz.

use realfft::{RealFftPlanner, RealToComplex};
use std::sync::Arc;

pub const SHORT_FFT: usize = 2048;
pub const LONG_FFT: usize = 8192;

const GAMMA: f64 = 1e4;
const BANDS_HZ: [(f64, f64); 5] = [
    (40.0, 120.0),
    (150.0, 500.0),
    (500.0, 2_000.0),
    (2_000.0, 6_000.0),
    (7_000.0, 16_000.0),
];
const LOCAL_RADIUS: usize = 6;
const TONAL_LOW_NOTE: i32 = 50;
const TONAL_HIGH_NOTE: i32 = 107;
const TONAL_EXCESS: f64 = 1.5;
const SCALE_RELEASE_S: f64 = 3.0;
const SCALE_FLOOR: [f64; 8] = [1.2, 0.6, 0.5, 0.5, 0.5, 0.25, 0.5, 0.4];
const GATE_DB: [(f64, f64); 5] = [
    (-42.0, -30.0),
    (-48.0, -36.0),
    (-50.0, -38.0),
    (-54.0, -42.0),
    (-60.0, -46.0),
];
const PERSIST_KICK: (f64, f64) = (0.25, 0.75);
const PERSIST_SNARE: (f64, f64) = (0.05, 0.45);
const PERSIST_PERC: (f64, f64) = (0.25, 0.75);
const DETECTORS: usize = 5;
const ABS_THRESHOLD: [f64; DETECTORS] = [0.3, 0.3, 0.3, 0.4, 0.3];
const REFRACTORY_S: [f64; DETECTORS] = [0.08, 0.07, 0.045, 0.06, 0.09];
const THRESHOLD_K: f64 = 1.5;
const THRESHOLD_TAU_S: f64 = 1.5;
const CHROMA_HZ: (f64, f64) = (100.0, 5_000.0);
const BASS_HZ: (f64, f64) = (40.0, 250.0);
const PEAK_RELATIVE_FLOOR: f64 = 0.03;
const PEAK_ABSOLUTE_FLOOR: f64 = 1e-5;

/// One frame of raw ensemble features. Onsets: kick, snare, hat, perc, tonal.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EnsembleRaw {
    pub chroma: [f32; 12],
    pub bass_chroma: [f32; 12],
    pub onsets: [f32; DETECTORS],
    pub stereo_width: f32,
    pub stereo_corr: f32,
}

/// Running stereo sums over the samples since the previous frame.
#[derive(Clone, Copy, Debug, Default)]
pub struct StereoSums {
    pub ll: f64,
    pub rr: f64,
    pub lr: f64,
    pub count: u32,
}

impl StereoSums {
    pub fn push(&mut self, left: f32, right: f32) {
        let (l, r) = (left as f64, right as f64);
        self.ll += l * l;
        self.rr += r * r;
        self.lr += l * r;
        self.count += 1;
    }
}

fn smoothstep(edge0: f64, edge1: f64, value: f64) -> f64 {
    let t = ((value - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn bin_range(band: (f64, f64), sample_rate: f64, fft_size: usize, bins: usize) -> (usize, usize) {
    let hz = sample_rate / fft_size as f64;
    let nyquist_cap = sample_rate * 0.475;
    let lo = ((band.0 / hz).round() as usize).max(1);
    let hi = (((band.1.min(nyquist_cap)) / hz).round() as usize).min(bins - 1);
    (lo, hi.max(lo + 1))
}

/// Stereo width (side over mid + side RMS) and correlation. Silence is mono.
pub fn stereo_image(sums: &StereoSums) -> (f32, f32) {
    let energy = sums.ll + sums.rr;
    if sums.count == 0 || energy / (sums.count as f64) < 1e-9 {
        return (0.0, 1.0);
    }
    let mid = ((sums.ll + 2.0 * sums.lr + sums.rr) / 4.0).max(0.0).sqrt();
    let side = ((sums.ll - 2.0 * sums.lr + sums.rr) / 4.0).max(0.0).sqrt();
    let width = if mid + side > 0.0 {
        side / (mid + side)
    } else {
        0.0
    };
    let denom = (sums.ll * sums.rr).sqrt();
    let corr = if denom > 0.0 {
        (sums.lr / denom).clamp(-1.0, 1.0)
    } else {
        1.0
    };
    (width.clamp(0.0, 1.0) as f32, corr as f32)
}

/// Peak-picked, interpolated pitch-class profile of one magnitude range.
fn peak_chroma(mags: &[f32], lo: usize, hi: usize, bin_hz: f64, out: &mut [f32; 12]) {
    let mut acc = [0.0f64; 12];
    let loudest = mags[lo..hi.min(mags.len())]
        .iter()
        .fold(0.0f64, |m, &v| m.max(v as f64));
    *out = [0.0; 12];
    if loudest < PEAK_ABSOLUTE_FLOOR {
        return;
    }
    let floor = PEAK_ABSOLUTE_FLOOR.max(loudest * PEAK_RELATIVE_FLOOR);
    for k in lo.max(1)..hi.min(mags.len() - 1) {
        let m = mags[k] as f64;
        if m < floor || m < mags[k - 1] as f64 || m < mags[k + 1] as f64 {
            continue;
        }
        let a = (mags[k - 1] as f64 + 1e-12).ln();
        let b = (m + 1e-12).ln();
        let c = (mags[k + 1] as f64 + 1e-12).ln();
        let den = a - 2.0 * b + c;
        let delta = if den < 0.0 {
            (0.5 * (a - c) / den).clamp(-0.5, 0.5)
        } else {
            0.0
        };
        let frequency = (k as f64 + delta) * bin_hz;
        if frequency <= 0.0 {
            continue;
        }
        let pitch = 12.0 * (frequency / 440.0).log2() + 69.0;
        let nearest = pitch.round();
        let weight = 1.0 - 1.6 * (pitch - nearest).abs();
        if weight <= 0.0 {
            continue;
        }
        acc[(nearest as i64).rem_euclid(12) as usize] += m * weight;
    }
    let max = acc.iter().fold(0.0f64, |m, &v| m.max(v));
    if max <= 0.0 {
        return;
    }
    for i in 0..12 {
        out[i] = (acc[i] / max) as f32;
    }
}

/// Mean half-wave-rectified rise against a 3-bin max of the previous frame.
fn band_flux(current: &[f64], previous: &[f64], lo: usize, hi: usize) -> f64 {
    let mut sum = 0.0;
    for k in lo..hi {
        let left = if k > 0 { previous[k - 1] } else { 0.0 };
        let right = previous.get(k + 1).copied().unwrap_or(0.0);
        let before = left.max(previous[k]).max(right);
        let rise = current[k] - before;
        if rise > 0.0 {
            sum += rise;
        }
    }
    sum / (hi - lo).max(1) as f64
}

#[derive(Clone, Copy, Default)]
struct Detector {
    prev: f64,
    prev2: f64,
    mean: f64,
    dev: f64,
    last_fire: f64,
}

/// Stateful per-frame extractor. One per stream; `process` once per frame.
pub struct EnsembleExtractor {
    prev_log: Vec<f64>,
    prev_smooth: Vec<f64>,
    cur_log: Vec<f64>,
    cur_smooth: Vec<f64>,
    prefix: Vec<f64>,
    tonal_bins: Vec<(usize, usize)>,
    prev_tonal: Vec<f64>,
    cur_tonal: Vec<f64>,
    primed: bool,
    sample_rate: u32,
    short_size: usize,
    ranges: [(usize, usize); 5],
    scales: [f64; 8],
    gates: [f64; 5],
    band_level: [f64; 5],
    band_level_prev: [f64; 5],
    prev_tonal_value: f64,
    prev_noise: f64,
    prev_noise2: f64,
    prev_high_ratio: f64,
    detectors: [Detector; DETECTORS],
    time: f64,
}

impl Default for EnsembleExtractor {
    fn default() -> Self {
        Self::new()
    }
}

impl EnsembleExtractor {
    pub fn new() -> Self {
        Self {
            prev_log: Vec::new(),
            prev_smooth: Vec::new(),
            cur_log: Vec::new(),
            cur_smooth: Vec::new(),
            prefix: Vec::new(),
            tonal_bins: Vec::new(),
            prev_tonal: Vec::new(),
            cur_tonal: Vec::new(),
            primed: false,
            sample_rate: 0,
            short_size: 0,
            ranges: [(1, 2); 5],
            scales: SCALE_FLOOR,
            gates: [0.0; 5],
            band_level: [0.0; 5],
            band_level_prev: [0.0; 5],
            prev_tonal_value: 0.0,
            prev_noise: 0.0,
            prev_noise2: 0.0,
            prev_high_ratio: 0.0,
            detectors: [Detector {
                last_fire: -1e9,
                ..Default::default()
            }; DETECTORS],
            time: 0.0,
        }
    }

    fn configure(&mut self, sample_rate: u32, bins: usize, fft_size: usize) {
        self.sample_rate = sample_rate;
        self.short_size = bins;
        self.prev_log = vec![0.0; bins];
        self.prev_smooth = vec![0.0; bins];
        self.cur_log = vec![0.0; bins];
        self.cur_smooth = vec![0.0; bins];
        self.prefix = vec![0.0; bins + 1];
        let sr = sample_rate as f64;
        for (b, band) in BANDS_HZ.iter().enumerate() {
            self.ranges[b] = bin_range(*band, sr, fft_size, bins);
        }
        let hz = sr / fft_size as f64;
        self.tonal_bins = (TONAL_LOW_NOTE..=TONAL_HIGH_NOTE)
            .map(|note| {
                let centre = 440.0 * 2f64.powf((note - 69) as f64 / 12.0);
                let lo = ((centre * 2f64.powf(-1.0 / 24.0) / hz + 0.5).floor() as usize).max(1);
                let hi = ((centre * 2f64.powf(1.0 / 24.0) / hz + 0.5).floor() as usize)
                    .max(lo + 1)
                    .min(bins - 1);
                (lo, hi)
            })
            .collect();
        let notes = self.tonal_bins.len();
        self.prev_tonal = vec![0.0; notes];
        self.cur_tonal = vec![0.0; notes];
        self.primed = false;
    }

    /// `short`/`long`: |X|/N magnitudes of Blackman-windowed FFTs of
    /// `short_fft`/`long_fft` points. `dt`: seconds since the previous frame.
    #[allow(clippy::too_many_arguments)]
    pub fn process(
        &mut self,
        short: &[f32],
        short_fft: usize,
        long: Option<&[f32]>,
        long_fft: usize,
        sample_rate: u32,
        stereo: Option<&StereoSums>,
        dt: f64,
    ) -> EnsembleRaw {
        let step = if dt.is_finite() && dt > 0.0 {
            dt.min(0.25)
        } else {
            1.0 / 60.0
        };
        self.time += step;
        let bins = short.len();
        let mut raw = EnsembleRaw {
            stereo_corr: 1.0,
            ..Default::default()
        };
        if bins < 16 {
            return raw;
        }
        if bins != self.short_size || sample_rate != self.sample_rate {
            self.configure(sample_rate, bins, short_fft);
        }

        self.prefix[0] = 0.0;
        for k in 0..bins {
            self.prefix[k + 1] = self.prefix[k] + short[k] as f64;
        }
        for k in 0..bins {
            let lo = k.saturating_sub(LOCAL_RADIUS);
            let hi = (k + LOCAL_RADIUS + 1).min(bins);
            self.cur_log[k] = (GAMMA * short[k] as f64).ln_1p();
            self.cur_smooth[k] =
                (GAMMA * (self.prefix[hi] - self.prefix[lo]) / (hi - lo) as f64).ln_1p();
        }
        let loudest = short[1..].iter().fold(1e-12f64, |m, &v| m.max(v as f64));
        std::mem::swap(&mut self.band_level, &mut self.band_level_prev);
        for b in 0..5 {
            let (lo, hi) = self.ranges[b];
            let mut peak = 1e-12f64;
            let mut level = 0.0;
            for k in lo..hi {
                peak = peak.max(short[k] as f64);
                level += self.cur_log[k];
            }
            self.band_level[b] = level / (hi - lo).max(1) as f64;
            let db = 20.0 * (peak / loudest).log10();
            self.gates[b] = smoothstep(GATE_DB[b].0, GATE_DB[b].1, db);
        }
        for (j, &(lo, hi)) in self.tonal_bins.iter().enumerate() {
            let peak = short[lo..hi].iter().fold(0.0f64, |m, &v| m.max(v as f64));
            self.cur_tonal[j] = (GAMMA * peak).ln_1p();
        }

        if self.primed {
            let mut n = [0.0f64; 8];
            for (b, flux) in n.iter_mut().enumerate().take(5) {
                let (lo, hi) = self.ranges[b];
                *flux = band_flux(&self.cur_log, &self.prev_log, lo, hi);
            }
            let notes = self.cur_tonal.len();
            let mut mean_rise = 0.0;
            for j in 0..notes {
                mean_rise += (self.cur_tonal[j] - self.prev_tonal[j]).max(0.0);
            }
            mean_rise /= notes.max(1) as f64;
            let mut excess = 0.0;
            for j in 0..notes {
                let rise = self.cur_tonal[j] - self.prev_tonal[j] - TONAL_EXCESS * mean_rise;
                if rise > 0.0 {
                    excess += rise;
                }
            }
            n[5] = excess / notes.max(1) as f64;
            n[6] = band_flux(
                &self.cur_smooth,
                &self.prev_smooth,
                self.ranges[1].0,
                self.ranges[1].1,
            );
            n[7] = band_flux(
                &self.cur_smooth,
                &self.prev_smooth,
                self.ranges[2].0,
                self.ranges[2].1,
            );
            let release = (-step / SCALE_RELEASE_S).exp();
            let mut norm = [0.0f64; 8];
            for b in 0..8 {
                let gate = match b {
                    0..=4 => self.gates[b],
                    6 => self.gates[1],
                    7 => self.gates[2],
                    _ => 1.0,
                };
                let gated = n[b] * gate;
                self.scales[b] = gated.max(self.scales[b] * release).max(SCALE_FLOOR[b]);
                norm[b] = gated / self.scales[b];
            }
            let (n_low, n_mid, n_noise, n_high) = (norm[0], norm[2], norm[3], norm[4]);
            let (n_tonal, n_body_s, n_mid_s) = (norm[5], norm[6], norm[7]);
            let high_ratio = n[4] / (n[3] + 0.05);
            let detection = [
                n_low,
                (n_mid_s.max(n_mid * 0.8) * n_noise).sqrt()
                    * (1.0 - 0.5 * smoothstep(1.2, 2.2, high_ratio)),
                n_high * smoothstep(0.8, 1.6, high_ratio),
                n_body_s.max(n_mid_s)
                    * (1.0 - smoothstep(0.3, 0.8, n_noise))
                    * (1.0 - smoothstep(0.5, 1.0, n_low)),
                n_tonal,
            ];
            // Confirm the candidate (the previous frame) with this one.
            let (n_lo, n_hi) = self.ranges[3];
            let mut log_sum = 0.0;
            let mut lin_sum = 0.0;
            for &v in &short[n_lo..n_hi] {
                log_sum += (v as f64 + 1e-12).ln();
                lin_sum += v as f64;
            }
            let count = (n_hi - n_lo).max(1) as f64;
            let noise_flat = if lin_sum > 1e-9 {
                (log_sum / count).exp() / (lin_sum / count)
            } else {
                0.0
            };
            let loudest_band = self.band_level.iter().fold(1e-6f64, |m, &v| m.max(v));
            let noise_share = smoothstep(0.18, 0.35, self.band_level[3] / loudest_band);
            let noisy = smoothstep(0.15, 0.35, noise_flat) * noise_share;
            let tonal_raw = smoothstep(0.35, 0.8, self.prev_tonal_value.max(n_tonal));
            let tonal_like = tonal_raw * (1.0 - noisy);
            self.prev_tonal_value = n_tonal;
            let noise_near = n_noise.max(self.prev_noise).max(self.prev_noise2);
            self.prev_noise2 = self.prev_noise;
            self.prev_noise = n_noise;
            let level = self.band_level;
            let before = self.band_level_prev;
            let confirm = [
                (1.0 - smoothstep(PERSIST_KICK.0, PERSIST_KICK.1, before[0] - level[0]))
                    * smoothstep(0.55, 0.9, n[0] / (n[1] + 0.05)),
                (1.0 - 0.85 * tonal_like)
                    * (1.0 - smoothstep(PERSIST_SNARE.0, PERSIST_SNARE.1, before[3] - level[3]))
                    * noisy,
                1.0,
                (1.0 - tonal_raw)
                    * (1.0
                        - smoothstep(
                            PERSIST_PERC.0,
                            PERSIST_PERC.1,
                            (before[1] - level[1]).min(before[2] - level[2]),
                        )),
                1.0 - 0.75 * smoothstep(0.35, 0.8, noise_near) * noisy,
            ];
            let alpha = 1.0 - (-step / THRESHOLD_TAU_S).exp();
            for d in 0..DETECTORS {
                // A snare's bright noise reaches the hat band too: once the
                // snare fires, a hat needs clearly hat-heavy (high) content.
                let snare_mask = if d == 2 && raw.onsets[1] > 0.0 {
                    smoothstep(1.5, 2.3, self.prev_high_ratio)
                } else {
                    1.0
                };
                let det = &mut self.detectors[d];
                let value = detection[d];
                let threshold = ABS_THRESHOLD[d].max(det.mean + THRESHOLD_K * det.dev);
                let strength = det.prev * confirm[d] * snare_mask;
                if det.prev > threshold
                    && strength > ABS_THRESHOLD[d]
                    && det.prev > det.prev2
                    && det.prev >= value
                    && self.time - det.last_fire >= REFRACTORY_S[d]
                {
                    raw.onsets[d] = strength.clamp(0.0, 1.0) as f32;
                    det.last_fire = self.time;
                }
                det.mean += (value - det.mean) * alpha;
                det.dev += ((value - det.mean).abs() - det.dev) * alpha;
                det.prev2 = det.prev;
                det.prev = value;
            }
            self.prev_high_ratio = high_ratio;
        }
        self.prev_log.copy_from_slice(&self.cur_log);
        self.prev_smooth.copy_from_slice(&self.cur_smooth);
        self.prev_tonal.copy_from_slice(&self.cur_tonal);
        self.primed = true;

        if let Some(long) = long.filter(|l| l.len() > 8) {
            let sr = sample_rate as f64;
            let hz = sr / long_fft as f64;
            let (c_lo, c_hi) = bin_range(CHROMA_HZ, sr, long_fft, long.len());
            let (b_lo, b_hi) = bin_range(BASS_HZ, sr, long_fft, long.len());
            peak_chroma(long, c_lo, c_hi, hz, &mut raw.chroma);
            peak_chroma(long, b_lo, b_hi, hz, &mut raw.bass_chroma);
        }
        if let Some(sums) = stereo {
            let (width, corr) = stereo_image(sums);
            raw.stereo_width = width;
            raw.stereo_corr = corr;
        }
        raw
    }
}

/// The Web Audio AnalyserNode window (Blackman, alpha 0.16, over N).
fn blackman(size: usize) -> Vec<f32> {
    (0..size)
        .map(|i| {
            let x = i as f64 / size as f64;
            (0.42 - 0.5 * (std::f64::consts::TAU * x).cos()
                + 0.08 * (2.0 * std::f64::consts::TAU * x).cos()) as f32
        })
        .collect()
}

/// Owns the mono rings, windows and FFTs behind the extractor, so the native
/// analyzer (and tests) can push samples and take one frame at a time.
pub struct EnsembleAnalyzer {
    extractor: EnsembleExtractor,
    ring: Vec<f32>,
    head: usize,
    short_fft: Arc<dyn RealToComplex<f32>>,
    long_fft: Arc<dyn RealToComplex<f32>>,
    short_window: Vec<f32>,
    long_window: Vec<f32>,
    short_in: Vec<f32>,
    long_in: Vec<f32>,
    short_out: Vec<realfft::num_complex::Complex<f32>>,
    long_out: Vec<realfft::num_complex::Complex<f32>>,
    short_mags: Vec<f32>,
    long_mags: Vec<f32>,
}

impl Default for EnsembleAnalyzer {
    fn default() -> Self {
        Self::new()
    }
}

impl EnsembleAnalyzer {
    pub fn new() -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let short_fft = planner.plan_fft_forward(SHORT_FFT);
        let long_fft = planner.plan_fft_forward(LONG_FFT);
        let short_out = short_fft.make_output_vec();
        let long_out = long_fft.make_output_vec();
        Self {
            extractor: EnsembleExtractor::new(),
            ring: vec![0.0; LONG_FFT],
            head: 0,
            short_window: blackman(SHORT_FFT),
            long_window: blackman(LONG_FFT),
            short_in: vec![0.0; SHORT_FFT],
            long_in: vec![0.0; LONG_FFT],
            short_mags: vec![0.0; short_out.len()],
            long_mags: vec![0.0; long_out.len()],
            short_out,
            long_out,
            short_fft,
            long_fft,
        }
    }

    #[inline]
    pub fn push(&mut self, sample: f32) {
        self.ring[self.head] = sample;
        self.head = (self.head + 1) % LONG_FFT;
    }

    /// Analyse the newest samples as one frame.
    pub fn frame(&mut self, sample_rate: u32, stereo: Option<&StereoSums>, dt: f64) -> EnsembleRaw {
        let start_short = (self.head + LONG_FFT - SHORT_FFT) % LONG_FFT;
        for i in 0..SHORT_FFT {
            self.short_in[i] = self.ring[(start_short + i) % LONG_FFT] * self.short_window[i];
        }
        for i in 0..LONG_FFT {
            self.long_in[i] = self.ring[(self.head + i) % LONG_FFT] * self.long_window[i];
        }
        let short_ok = self
            .short_fft
            .process(&mut self.short_in, &mut self.short_out)
            .is_ok();
        let long_ok = self
            .long_fft
            .process(&mut self.long_in, &mut self.long_out)
            .is_ok();
        if !short_ok || !long_ok {
            return EnsembleRaw {
                stereo_corr: 1.0,
                ..Default::default()
            };
        }
        for (m, c) in self.short_mags.iter_mut().zip(&self.short_out) {
            *m = (c.re * c.re + c.im * c.im).sqrt() / SHORT_FFT as f32;
        }
        // Pitch only needs the long spectrum up to ~5.2 kHz.
        let long_limit = ((5_200.0 / (sample_rate.max(1) as f32 / 2.0))
            * self.long_mags.len() as f32)
            .ceil()
            .min(self.long_mags.len() as f32) as usize;
        for (i, (m, c)) in self.long_mags.iter_mut().zip(&self.long_out).enumerate() {
            *m = if i < long_limit {
                (c.re * c.re + c.im * c.im).sqrt() / LONG_FFT as f32
            } else {
                0.0
            };
        }
        self.extractor.process(
            &self.short_mags,
            SHORT_FFT,
            Some(&self.long_mags),
            LONG_FFT,
            sample_rate,
            stereo,
            dt,
        )
    }
}

/// Round for the event payload: three decimals is plenty for 0..1 channels.
pub fn round3(value: f32) -> f32 {
    (value * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 44_100;
    const HOP: usize = 735; // 60 Hz at 44.1 kHz

    fn midi_hz(note: f64) -> f64 {
        440.0 * 2f64.powf((note - 69.0) / 12.0)
    }

    /// xorshift noise, deterministic.
    struct Noise(u32);
    impl Noise {
        fn next(&mut self) -> f32 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 17;
            self.0 ^= self.0 << 5;
            (self.0 as f64 / u32::MAX as f64 * 2.0 - 1.0) as f32
        }
    }

    /// Run a mono signal through the analyzer at 60 Hz; return every frame.
    fn run(signal: &[f32]) -> Vec<(f64, EnsembleRaw)> {
        let mut analyzer = EnsembleAnalyzer::new();
        let mut frames = Vec::new();
        for (i, &s) in signal.iter().enumerate() {
            analyzer.push(s);
            if (i + 1) % HOP == 0 {
                let t = (i + 1) as f64 / RATE as f64;
                let mut sums = StereoSums::default();
                sums.push(s, s);
                frames.push((
                    t,
                    analyzer.frame(RATE, Some(&sums), HOP as f64 / RATE as f64),
                ));
            }
        }
        frames
    }

    fn tone(out: &mut [f32], at: f64, note: f64, length: f64, gain: f32) {
        // A 20 ms attack and a 12 ms release tail, so notes never click.
        let f = midi_hz(note);
        let from = (at * RATE as f64) as usize;
        let to = (((at + length + 0.08) * RATE as f64) as usize).min(out.len());
        for (n, v) in out.iter_mut().enumerate().take(to).skip(from) {
            let t = (n - from) as f64 / RATE as f64;
            let mut env = (t / 0.02).min(1.0);
            if t > length {
                env *= (-(t - length) / 0.012).exp();
            }
            let mut s = 0.0;
            for h in 1..=6 {
                s += (std::f64::consts::TAU * f * h as f64 * t).sin() / (h as f64).powf(1.1);
            }
            *v += (s * env) as f32 * gain;
        }
    }

    fn kick(out: &mut [f32], at: f64) {
        let from = (at * RATE as f64) as usize;
        for n in from..(from + (0.45 * RATE as f64) as usize).min(out.len()) {
            let t = (n - from) as f64 / RATE as f64;
            let phase =
                std::f64::consts::TAU * (45.0 * t + 105.0 * (1.0 - (-t * 28.0).exp()) / 28.0);
            out[n] += (phase.sin() * (-t * 7.0).exp() * 0.9) as f32;
        }
    }

    fn hat(out: &mut [f32], at: f64, noise: &mut Noise) {
        let from = (at * RATE as f64) as usize;
        let (mut x1, mut x2) = (0.0f32, 0.0f32);
        for n in from..(from + (0.12 * RATE as f64) as usize).min(out.len()) {
            let t = (n - from) as f64 / RATE as f64;
            let w = noise.next();
            let hp = w - 2.0 * x1 + x2;
            x2 = x1;
            x1 = w;
            out[n] += hp * (-t * 55.0).exp() as f32 * 0.18;
        }
    }

    fn snare(out: &mut [f32], at: f64, noise: &mut Noise) {
        let from = (at * RATE as f64) as usize;
        let (mut lp, mut prev) = (0.0f32, 0.0f32);
        for n in from..(from + (0.35 * RATE as f64) as usize).min(out.len()) {
            let t = (n - from) as f64 / RATE as f64;
            let w = noise.next();
            let hp = w - prev;
            prev = w;
            lp += (hp - lp) * 0.75;
            let body = ((std::f64::consts::TAU * 185.0 * t).sin() * 0.8
                + (std::f64::consts::TAU * 330.0 * t).sin() * 0.4)
                * (-t * 28.0).exp();
            out[n] += ((body + lp as f64 * (-t * 17.0).exp() * 1.1) * 0.7) as f32;
        }
    }

    fn count(frames: &[(f64, EnsembleRaw)], layer: usize, from: f64) -> usize {
        frames
            .iter()
            .filter(|(t, f)| *t > from && f.onsets[layer] > 0.0)
            .count()
    }

    #[test]
    fn c_major_triad_lights_c_e_and_g() {
        let mut signal = vec![0.0f32; RATE as usize * 2];
        for note in [60.0, 64.0, 67.0] {
            tone(&mut signal, 0.0, note, 2.0, 0.2);
        }
        tone(&mut signal, 0.0, 48.0, 2.0, 0.25);
        let frames = run(&signal);
        let (_, last) = frames.last().unwrap();
        let c = &last.chroma;
        for pc in [0, 4, 7] {
            assert!(c[pc] > 0.3, "chord tone {pc}: {:?}", c);
        }
        for pc in [1, 3, 6, 8, 10] {
            assert!(c[pc] < 0.15, "non-chord {pc}: {:?}", c);
        }
        assert_eq!(c[0], 1.0, "{:?}", c);
        // The bass register hears the C under the chord.
        let b = &last.bass_chroma;
        let argmax = (0..12).max_by(|&i, &j| b[i].total_cmp(&b[j])).unwrap();
        assert_eq!(argmax, 0, "{:?}", b);
    }

    #[test]
    fn a_minor_and_b_diminished_have_their_own_tones() {
        // The three strongest pitch classes are the chord's (overtones of the
        // chord tones light other classes, but more weakly).
        for (notes, mut tones) in [
            (vec![57.0, 60.0, 64.0], vec![0, 4, 9]),
            (vec![59.0, 62.0, 65.0], vec![2, 5, 11]),
        ] {
            let mut signal = vec![0.0f32; RATE as usize];
            for note in notes {
                tone(&mut signal, 0.0, note, 1.0, 0.2);
            }
            let frames = run(&signal);
            let c = frames.last().unwrap().1.chroma;
            let mut order: Vec<usize> = (0..12).collect();
            order.sort_by(|&a, &b| c[b].total_cmp(&c[a]));
            let mut top = order[..3].to_vec();
            top.sort();
            tones.sort();
            assert_eq!(top, tones, "{:?}", c);
            assert!(c[order[3]] < 0.5 * c[order[2]], "{:?}", c);
        }
    }

    #[test]
    fn a_kick_train_gives_kicks_but_no_hats_or_snares() {
        let mut signal = vec![0.0f32; RATE as usize * 7];
        let beats: Vec<f64> = (0..12).map(|k| 0.5 + k as f64 * 0.5).collect();
        for &at in &beats {
            kick(&mut signal, at);
        }
        let frames = run(&signal);
        let kicks: Vec<f64> = frames
            .iter()
            .filter(|(_, f)| f.onsets[0] > 0.0)
            .map(|(t, _)| *t)
            .collect();
        assert_eq!(kicks.len(), beats.len(), "kicks at {kicks:?}");
        for (detected, at) in kicks.iter().zip(&beats) {
            let latency = detected - at;
            assert!((0.0..0.07).contains(&latency), "latency {latency}");
        }
        assert_eq!(count(&frames, 1, 0.0), 0, "snares");
        assert_eq!(count(&frames, 2, 0.0), 0, "hats");
    }

    #[test]
    fn hats_and_snares_are_told_apart_from_kicks() {
        let mut signal = vec![0.0f32; RATE as usize * 6];
        let mut noise = Noise(7);
        for k in 0..16 {
            let at = 0.5 + k as f64 * 0.3;
            match k % 4 {
                0 => kick(&mut signal, at),
                2 => snare(&mut signal, at, &mut noise),
                _ => hat(&mut signal, at, &mut noise),
            }
        }
        let frames = run(&signal);
        assert_eq!(count(&frames, 0, 0.0), 4, "kicks");
        assert_eq!(count(&frames, 1, 0.0), 4, "snares");
        assert_eq!(count(&frames, 2, 0.0), 8, "hats");
    }

    #[test]
    fn a_plucked_line_gives_tonal_onsets_and_no_drums() {
        let mut signal = vec![0.0f32; RATE as usize * 4];
        let line = [60.0, 64.0, 67.0, 72.0, 67.0, 64.0, 62.0, 65.0];
        for k in 0..24 {
            let at = 0.4 + k as f64 * 0.136;
            tone(&mut signal, at, line[k % line.len()], 0.07, 0.3);
        }
        let frames = run(&signal);
        let tonal = count(&frames, 4, 0.0);
        assert!((22..=26).contains(&tonal), "tonal onsets {tonal}");
        let kicks: Vec<f64> = frames
            .iter()
            .filter(|(_, f)| f.onsets[0] > 0.0)
            .map(|(t, _)| *t)
            .collect();
        assert!(kicks.len() <= 2, "kicks at {kicks:?}");
        assert!(count(&frames, 1, 0.0) <= 1, "snares");
        assert_eq!(count(&frames, 2, 0.0), 0, "hats");
    }

    #[test]
    fn stereo_image_reads_mono_wide_and_inverted() {
        let mut mono = StereoSums::default();
        let mut wide = StereoSums::default();
        let mut inverted = StereoSums::default();
        let mut noise = Noise(3);
        for _ in 0..1000 {
            let (a, b) = (noise.next(), noise.next());
            mono.push(a, a);
            wide.push(a, b);
            inverted.push(a, -a);
        }
        let (w, c) = stereo_image(&mono);
        assert!(w < 1e-6 && (c - 1.0).abs() < 1e-6);
        let (w, c) = stereo_image(&wide);
        assert!((0.4..0.6).contains(&w) && c.abs() < 0.15, "{w} {c}");
        let (w, c) = stereo_image(&inverted);
        assert!(w > 0.99 && c < -0.99, "{w} {c}");
        assert_eq!(stereo_image(&StereoSums::default()), (0.0, 1.0));
    }

    #[test]
    fn silence_reads_as_nothing() {
        let frames = run(&vec![0.0f32; RATE as usize]);
        for (_, f) in &frames {
            assert_eq!(f.onsets, [0.0; 5]);
            assert_eq!(f.chroma, [0.0; 12]);
        }
    }

    #[test]
    fn round3_keeps_three_decimals() {
        assert_eq!(round3(0.123_456), 0.123);
        assert_eq!(round3(1.0), 1.0);
        assert_eq!(serde_json::to_string(&round3(0.5234567)).unwrap(), "0.523");
    }
}
