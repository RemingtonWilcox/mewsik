//! Audio feature extraction for the visualizer.
//!
//! `TappedSource` wraps a rodio `Source<Item = i16>` and passes samples through
//! unchanged to the sink while pushing one frame per sample instant to the
//! analyzer thread over a non-blocking channel: the downmixed mono sample the
//! features are computed from, plus the left and right channels for the scope.
//! The analyzer accumulates a sliding mono window, runs a windowed real-FFT,
//! and emits log-grouped magnitude bins + envelope features to the frontend at
//! ~60Hz. Each event also carries the stereo pairs heard since the previous
//! one (`scope`), which the Signal visualizer draws as a real XY beam; the
//! features never read them.

use crossbeam_channel::{Receiver, Sender};
use parking_lot::Mutex;
use realfft::RealFftPlanner;
use rodio::Source;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const FFT_SIZE: usize = 2048;
const BIN_COUNT: usize = 64;
const EMIT_HZ: u64 = 60;
// Bound the tap channel so a stalled analyzer cannot blow memory; samples drop on overflow.
const TAP_CAPACITY: usize = 1 << 16;
/// Highest scope rate sent to the frontend. Sources above it are decimated by
/// a whole factor (96 kHz by 2, 192 kHz by 4), so a 60 Hz event carries about
/// 800 pairs whatever the source rate.
const SCOPE_MAX_RATE: u32 = 50_000;
/// Most stereo pairs one event carries. A stalled emit keeps only the newest.
const SCOPE_MAX_PAIRS: usize = 1024;
/// A chunk whose peak stays under this (about -80 dBFS) is sent empty.
const SCOPE_SILENCE: f32 = 1e-4;

#[derive(Clone, Debug, Serialize)]
pub struct AudioFeatures {
    pub bins: Vec<f32>, // BIN_COUNT log-spaced magnitudes, 0..1
    pub rms: f32,       // time-domain waveform RMS amplitude, 0..1
    pub peak: f32,      // time-domain absolute waveform peak, 0..1
    pub centroid: f32,  // normalized 0..1 (relative to Nyquist)
    pub onset: bool,
    pub bass: f32,
    pub mid: f32,
    pub treble: f32,
    pub sample_rate: u32,
    // BPM tracking — estimated tempo and phase within current beat.
    pub bpm: f32,        // 0 if unknown, else 60..180
    pub beat_phase: f32, // 0..1, 0 = on the beat
    // Chroma — dominant pitch class as a hue index + how concentrated it is.
    // chroma_key=0 corresponds to C, then C# … B (in 1/12 increments).
    pub chroma_key: f32,      // 0..1
    pub chroma_strength: f32, // 0..1, low when atonal/noisy
    // Stereo scope: the pairs heard since the previous event, interleaved
    // little-endian i16 L, R (scaled by 32767), base64-encoded. Empty while
    // silent. Renderer-only; none of the features above read it.
    pub scope: String,
    pub scope_rate: u32, // pair rate after decimation, Hz
}

pub struct TapFrame {
    pub sample: f32, // -1.0..1.0 mono downmix (the analyzer's input)
    pub left: f32,   // -1.0..1.0, channel 0
    pub right: f32,  // -1.0..1.0, channel 1 (= left for mono sources)
    pub sample_rate: u32,
}

pub fn tap_channel() -> (Sender<TapFrame>, Receiver<TapFrame>) {
    crossbeam_channel::bounded(TAP_CAPACITY)
}

/// Source adapter that observes samples passing through to rodio.
pub struct TappedSource<S: Source<Item = i16>> {
    inner: S,
    tap: Sender<TapFrame>,
    channel_idx: u16,
    accumulator: f32,
    left: f32,
    right: f32,
}

impl<S: Source<Item = i16>> TappedSource<S> {
    pub fn new(inner: S, tap: Sender<TapFrame>) -> Self {
        Self {
            inner,
            tap,
            channel_idx: 0,
            accumulator: 0.0,
            left: 0.0,
            right: 0.0,
        }
    }
}

impl<S: Source<Item = i16>> Iterator for TappedSource<S> {
    type Item = i16;
    fn next(&mut self) -> Option<i16> {
        let sample = self.inner.next()?;
        let normalized = sample as f32 / 32768.0;
        let channels = self.inner.channels().max(1);
        self.accumulator += normalized;
        match self.channel_idx {
            0 => self.left = normalized,
            1 => self.right = normalized,
            _ => {}
        }
        self.channel_idx += 1;
        if self.channel_idx >= channels {
            let mono = self.accumulator / channels as f32;
            let _ = self.tap.try_send(TapFrame {
                sample: mono,
                left: self.left,
                // A mono source draws the scope's diagonal: x = y.
                right: if channels >= 2 { self.right } else { self.left },
                sample_rate: self.inner.sample_rate(),
            });
            self.accumulator = 0.0;
            self.channel_idx = 0;
        }
        Some(sample)
    }
}

impl<S: Source<Item = i16>> Source for TappedSource<S> {
    fn current_frame_len(&self) -> Option<usize> {
        self.inner.current_frame_len()
    }
    fn channels(&self) -> u16 {
        self.inner.channels()
    }
    fn sample_rate(&self) -> u32 {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }
}

// Autocorrelation BPM estimation on the onset-flux envelope. Scans lag values
// corresponding to 60..180 BPM and returns the best-scoring lag as a fractional
// frame count, or 0 if the signal is too quiet to be confident.
fn estimate_beat_period(flux: &VecDeque<f32>, emit_hz: f32) -> f32 {
    if flux.len() < 64 {
        return 0.0;
    }
    let min_lag = ((60.0 * emit_hz / 180.0).floor() as usize).max(2);
    let max_lag = ((60.0 * emit_hz / 60.0).ceil() as usize).min(flux.len() - 1);
    let mut best_lag = 0usize;
    let mut best_score = 0.0f32;
    let mut score_sum = 0.0f32;
    let mut score_count = 0u32;
    for lag in min_lag..=max_lag {
        let n = flux.len() - lag;
        let mut s = 0.0f32;
        for i in 0..n {
            s += flux[i] * flux[i + lag];
        }
        s /= n as f32;
        score_sum += s;
        score_count += 1;
        if s > best_score {
            best_score = s;
            best_lag = lag;
        }
    }
    // Confidence: peak must noticeably exceed mean autocorrelation, else bail.
    let mean = score_sum / score_count.max(1) as f32;
    if best_lag == 0 || best_score < mean * 1.4 || best_score < 1e-8 {
        return 0.0;
    }
    best_lag as f32
}

/// Return waveform loudness using the normalized PCM contract shared with the
/// browser analyzer: RMS amplitude and absolute peak, both in 0..1.
fn pcm_levels(samples: &[f32]) -> (f32, f32) {
    if samples.is_empty() {
        return (0.0, 0.0);
    }

    let mut sum_sq = 0.0f32;
    let mut peak = 0.0f32;
    for &sample in samples {
        sum_sq += sample * sample;
        peak = peak.max(sample.abs());
    }

    let rms = (sum_sq / samples.len() as f32).sqrt();
    (rms.clamp(0.0, 1.0), peak.clamp(0.0, 1.0))
}

/// Whole decimation factor that brings a source rate under SCOPE_MAX_RATE.
fn scope_decimation(sample_rate: u32) -> u32 {
    sample_rate.max(1).div_ceil(SCOPE_MAX_RATE).max(1)
}

/// Collects the stereo pairs heard between two emits. Sources above
/// SCOPE_MAX_RATE are box-averaged by a whole factor that depends only on the
/// rate, so the pair rate never changes from one event to the next; a partial
/// group carries over to the next emit, keeping the stream continuous.
struct ScopeCollector {
    pairs: VecDeque<[f32; 2]>,
    rate: u32,
    factor: u32,
    group: [f32; 2],
    grouped: u32,
}

impl ScopeCollector {
    fn new() -> Self {
        Self {
            pairs: VecDeque::with_capacity(SCOPE_MAX_PAIRS),
            rate: 0,
            factor: 1,
            group: [0.0; 2],
            grouped: 0,
        }
    }

    fn push(&mut self, left: f32, right: f32, sample_rate: u32) {
        if sample_rate != self.rate {
            // A new rate is a new stream: drop the old partial group.
            self.rate = sample_rate;
            self.factor = scope_decimation(sample_rate);
            self.group = [0.0; 2];
            self.grouped = 0;
            self.pairs.clear();
        }
        self.group[0] += left;
        self.group[1] += right;
        self.grouped += 1;
        if self.grouped < self.factor {
            return;
        }
        let scale = 1.0 / self.grouped as f32;
        if self.pairs.len() >= SCOPE_MAX_PAIRS {
            self.pairs.pop_front();
        }
        self.pairs
            .push_back([self.group[0] * scale, self.group[1] * scale]);
        self.group = [0.0; 2];
        self.grouped = 0;
    }

    /// The pair rate the drained pairs are at.
    fn pair_rate(&self) -> u32 {
        self.rate / self.factor.max(1)
    }

    /// Take everything collected since the last drain as base64 i16 pairs.
    fn drain(&mut self) -> String {
        let peak = self.pairs.iter().fold(0.0f32, |peak, pair| {
            peak.max(pair[0].abs()).max(pair[1].abs())
        });
        if peak < SCOPE_SILENCE {
            self.pairs.clear();
            return String::new();
        }
        let mut bytes = Vec::with_capacity(self.pairs.len() * 4);
        for pair in self.pairs.drain(..) {
            for value in pair {
                let quantized = (value.clamp(-1.0, 1.0) * 32767.0).round() as i16;
                bytes.extend_from_slice(&quantized.to_le_bytes());
            }
        }
        base64_encode(&bytes)
    }
}

const BASE64_TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 (RFC 4648, padded). Small enough not to need a crate.
fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(BASE64_TABLE[(triple >> 18) as usize & 63] as char);
        out.push(BASE64_TABLE[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            BASE64_TABLE[(triple >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64_TABLE[triple as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

pub fn spawn_analyzer(rx: Receiver<TapFrame>, app_handle: Arc<Mutex<Option<AppHandle>>>) {
    std::thread::Builder::new()
        .name("audio-analyzer".to_string())
        .spawn(move || analyzer_loop(rx, app_handle))
        .expect("failed to spawn analyzer");
}

fn analyzer_loop(rx: Receiver<TapFrame>, app_handle: Arc<Mutex<Option<AppHandle>>>) {
    let mut planner = RealFftPlanner::<f32>::new();
    let r2c = planner.plan_fft_forward(FFT_SIZE);
    let mut input = vec![0.0f32; FFT_SIZE];
    let mut output = r2c.make_output_vec();
    let mut ring = vec![0.0f32; FFT_SIZE];
    let mut ring_head: usize = 0;
    let mut sr: u32;
    let mut last_emit = Instant::now();
    let emit_interval = Duration::from_millis(1000 / EMIT_HZ);
    let mut prev_energy: f32 = 0.0;
    let mut scope = ScopeCollector::new();

    // BPM tracker — onset flux ring buffer, ~4s long at 60Hz emit. Long enough
    // to autocorrelate down to 60 BPM (1-beat-per-second period).
    const FLUX_HIST_LEN: usize = 256;
    let mut flux_hist: VecDeque<f32> = VecDeque::with_capacity(FLUX_HIST_LEN);
    let mut beat_period_frames: f32 = 0.0; // 0 = no estimate yet
    let mut beat_phase: f32 = 0.0;
    let mut bpm_check_counter: u32 = 0;

    let window: Vec<f32> = (0..FFT_SIZE)
        .map(|i| {
            let t = i as f32 / (FFT_SIZE - 1) as f32;
            0.5 - 0.5 * (2.0 * std::f32::consts::PI * t).cos()
        })
        .collect();

    loop {
        let first = match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(f) => f,
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
        };
        ring[ring_head] = first.sample;
        ring_head = (ring_head + 1) % FFT_SIZE;
        sr = first.sample_rate;
        scope.push(first.left, first.right, first.sample_rate);

        while let Ok(frame) = rx.try_recv() {
            ring[ring_head] = frame.sample;
            ring_head = (ring_head + 1) % FFT_SIZE;
            sr = frame.sample_rate;
            scope.push(frame.left, frame.right, frame.sample_rate);
        }

        if last_emit.elapsed() < emit_interval {
            continue;
        }
        last_emit = Instant::now();

        // Loudness is a time-domain property. Measure the unwindowed PCM ring;
        // FFT magnitudes stay dedicated to spectral features below.
        let (rms, peak) = pcm_levels(&ring);

        for i in 0..FFT_SIZE {
            let src_idx = (ring_head + i) % FFT_SIZE;
            input[i] = ring[src_idx] * window[i];
        }

        if r2c.process(&mut input, &mut output).is_err() {
            continue;
        }

        let mags: Vec<f32> = output
            .iter()
            .map(|c| (c.re * c.re + c.im * c.im).sqrt() / FFT_SIZE as f32)
            .collect();

        let nyquist = sr.max(1) as f32 / 2.0;
        let mut bins = vec![0.0f32; BIN_COUNT];
        for b in 0..BIN_COUNT {
            let f_lo = 20.0 * (nyquist / 20.0).powf(b as f32 / BIN_COUNT as f32);
            let f_hi = 20.0 * (nyquist / 20.0).powf((b + 1) as f32 / BIN_COUNT as f32);
            let i_lo = ((f_lo / nyquist) * (mags.len() - 1) as f32) as usize;
            let i_hi = (((f_hi / nyquist) * (mags.len() - 1) as f32) as usize)
                .max(i_lo + 1)
                .min(mags.len());
            let mut m = 0.0f32;
            for i in i_lo..i_hi {
                if mags[i] > m {
                    m = mags[i];
                }
            }
            // Log-magnitude with a gentle floor so silence reads as ~0 but mid-level signals look full.
            bins[b] = (m.max(1e-7).log10() * 0.4 + 1.0).clamp(0.0, 1.0);
        }

        let mut num = 0.0f32;
        let mut den = 0.0f32;
        for (i, m) in mags.iter().enumerate() {
            let f = (i as f32 / mags.len() as f32) * nyquist;
            num += f * m;
            den += m;
        }
        let centroid = if den > 0.0 {
            (num / den) / nyquist
        } else {
            0.0
        };

        let bass_n = BIN_COUNT / 8;
        let mid_n = BIN_COUNT / 2 - bass_n;
        let treble_n = BIN_COUNT - bass_n - mid_n;
        let bass = bins[0..bass_n].iter().sum::<f32>() / bass_n.max(1) as f32;
        let mid = bins[bass_n..bass_n + mid_n].iter().sum::<f32>() / mid_n.max(1) as f32;
        let treble = bins[bass_n + mid_n..].iter().sum::<f32>() / treble_n.max(1) as f32;

        let total_energy: f32 = mags.iter().sum();
        let flux = (total_energy - prev_energy).max(0.0);
        let onset = flux > prev_energy * 0.3 && prev_energy > 0.01;
        prev_energy = total_energy * 0.7 + prev_energy * 0.3;

        // ── BPM / beat phase: track the onset-flux envelope, autocorrelate
        // every ~0.5s. Beat phase advances per emit and snaps to onsets that
        // land near the expected beat.
        flux_hist.push_back(flux);
        if flux_hist.len() > FLUX_HIST_LEN {
            flux_hist.pop_front();
        }
        if beat_period_frames > 0.0 {
            beat_phase += 1.0 / beat_period_frames;
            if beat_phase >= 1.0 {
                beat_phase -= beat_phase.floor();
            }
            // Re-align to strong onsets that arrive near the expected beat.
            if onset && (beat_phase < 0.18 || beat_phase > 0.82) {
                beat_phase = 0.0;
            }
        }
        bpm_check_counter += 1;
        if flux_hist.len() >= 128 && bpm_check_counter >= 30 {
            bpm_check_counter = 0;
            let new_period = estimate_beat_period(&flux_hist, EMIT_HZ as f32);
            if new_period > 0.0 {
                beat_period_frames = if beat_period_frames > 0.0 {
                    beat_period_frames * 0.7 + new_period * 0.3
                } else {
                    new_period
                };
            }
        }
        let bpm = if beat_period_frames > 0.0 {
            (EMIT_HZ as f32) * 60.0 / beat_period_frames
        } else {
            0.0
        };

        // ── Chroma — 12-bin pitch class profile. Bin energy is folded into
        // the nearest semitone-mod-12 (C=0, C#=1, …). Skip out-of-musical-range
        // bins (sub-bass rumble and hiss).
        let mut chroma = [0.0f32; 12];
        for (i, &m) in mags.iter().enumerate() {
            let f = (i as f32 / mags.len() as f32) * nyquist;
            if !(80.0..=5000.0).contains(&f) || m <= 0.0 {
                continue;
            }
            // 12 * log2(f/440) gives semitones from A4. Shift by +9 so C=0.
            let semitone = (12.0 * (f / 440.0).log2()).round() as i32 + 9 + 1200;
            let pc = (semitone % 12) as usize;
            chroma[pc] += m;
        }
        let chroma_total: f32 = chroma.iter().sum();
        let (chroma_key, chroma_strength) = if chroma_total > 1e-6 {
            let inv = 1.0 / chroma_total;
            let mut max_idx = 0usize;
            let mut max_val = 0.0f32;
            for (i, c) in chroma.iter_mut().enumerate() {
                *c *= inv;
                if *c > max_val {
                    max_val = *c;
                    max_idx = i;
                }
            }
            // Strength: how much the dominant pitch exceeds a flat distribution.
            // Flat = 1/12; we map (max - 1/12) into 0..1 with a generous scale.
            let strength = ((max_val - 1.0 / 12.0) * 6.0).clamp(0.0, 1.0);
            (max_idx as f32 / 12.0, strength)
        } else {
            (0.0, 0.0)
        };

        let features = AudioFeatures {
            bins,
            rms,
            peak,
            centroid: centroid.clamp(0.0, 1.0),
            onset,
            bass: bass.clamp(0.0, 1.0),
            mid: mid.clamp(0.0, 1.0),
            treble: treble.clamp(0.0, 1.0),
            sample_rate: sr,
            bpm,
            beat_phase,
            chroma_key,
            chroma_strength,
            scope: scope.drain(),
            scope_rate: scope.pair_rate(),
        };

        let handle = app_handle.lock().clone();
        if let Some(h) = handle {
            let _ = h.emit("audio:features", &features);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        base64_encode, pcm_levels, scope_decimation, AudioFeatures, ScopeCollector, BASE64_TABLE,
        SCOPE_MAX_PAIRS,
    };

    /// Decode the scope payload back into (left, right) pairs.
    fn decode_scope(text: &str) -> Vec<(i16, i16)> {
        let mut bytes = Vec::new();
        for chunk in text.as_bytes().chunks(4) {
            let mut triple = 0u32;
            let mut valid = 0;
            for (i, &c) in chunk.iter().enumerate() {
                if c != b'=' {
                    let v = BASE64_TABLE.iter().position(|&t| t == c).unwrap() as u32;
                    triple |= v << (18 - 6 * i);
                    valid += 1;
                }
            }
            let out = [(triple >> 16) as u8, (triple >> 8) as u8, triple as u8];
            bytes.extend_from_slice(&out[..valid - 1]);
        }
        bytes
            .chunks(4)
            .map(|c| {
                (
                    i16::from_le_bytes([c[0], c[1]]),
                    i16::from_le_bytes([c[2], c[3]]),
                )
            })
            .collect()
    }

    /// Music-like stereo: a few partials per channel, decorrelated.
    fn music_pair(i: usize) -> (f32, f32) {
        let t = i as f32 / 48_000.0;
        let tau = std::f32::consts::TAU;
        let left = 0.35 * (tau * 110.0 * t).sin()
            + 0.2 * (tau * 277.2 * t + 0.4).sin()
            + 0.08 * (tau * 1661.0 * t).sin();
        let right = 0.33 * (tau * 110.4 * t + 1.1).sin()
            + 0.22 * (tau * 329.6 * t).sin()
            + 0.07 * (tau * 1975.0 * t + 2.0).sin();
        (left, right)
    }

    #[test]
    fn base64_matches_rfc_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn scope_carries_stereo_pairs_at_48k() {
        let mut scope = ScopeCollector::new();
        for i in 0..800 {
            let t = i as f32 / 48_000.0;
            let left = (std::f32::consts::TAU * 100.0 * t).sin() * 0.5;
            let right = (std::f32::consts::TAU * 100.0 * t).cos() * 0.5;
            scope.push(left, right, 48_000);
        }
        assert_eq!(scope.pair_rate(), 48_000);
        let text = scope.drain();
        let pairs = decode_scope(&text);
        assert_eq!(pairs.len(), 800);
        assert_eq!(pairs[0], (0, 16384));
        // A quarter period of 100 Hz at 48 kHz: left peaks, right crosses zero.
        assert_eq!(pairs[120], (16384, 0));
        // Draining empties the collector.
        assert!(scope.drain().is_empty());
    }

    #[test]
    fn scope_event_payload_stays_compact() {
        let mut scope = ScopeCollector::new();
        for i in 0..800 {
            let (left, right) = music_pair(i);
            scope.push(left, right, 48_000);
        }
        let text = scope.drain();
        // 800 pairs x 4 bytes in base64: 4268 characters per 60 Hz event.
        assert_eq!(text.len(), 4268);
        // The same pairs as a JSON integer array would be well over twice that.
        let pairs = decode_scope(&text);
        let as_json = serde_json::to_string(
            &pairs
                .iter()
                .flat_map(|&(l, r)| [l, r])
                .collect::<Vec<i16>>(),
        )
        .unwrap();
        assert!(as_json.len() > text.len() * 2, "json {}", as_json.len());
        // Measure the whole event as the frontend receives it.
        let features = AudioFeatures {
            bins: vec![0.523_456_7; 64],
            rms: 0.31,
            peak: 0.82,
            centroid: 0.12,
            onset: false,
            bass: 0.6,
            mid: 0.4,
            treble: 0.2,
            sample_rate: 48_000,
            bpm: 128.0,
            beat_phase: 0.25,
            chroma_key: 0.5,
            chroma_strength: 0.3,
            scope: text,
            scope_rate: 48_000,
        };
        let event = serde_json::to_string(&features).unwrap();
        eprintln!(
            "audio:features event: {} bytes ({} of them scope); json i16 scope would be {}",
            event.len(),
            features.scope.len(),
            as_json.len()
        );
        assert!(event.len() < 6_500, "event {} bytes", event.len());
    }

    #[test]
    fn scope_decimates_high_rates_by_a_whole_factor() {
        assert_eq!(scope_decimation(44_100), 1);
        assert_eq!(scope_decimation(48_000), 1);
        assert_eq!(scope_decimation(96_000), 2);
        assert_eq!(scope_decimation(192_000), 4);
        let mut scope = ScopeCollector::new();
        // 1600 samples at 96 kHz = one 60 Hz frame, alternating so the box
        // average is exact.
        for i in 0..1600 {
            let v = if i % 2 == 0 { 0.25 } else { 0.75 };
            scope.push(v, -v, 96_000);
        }
        assert_eq!(scope.pair_rate(), 48_000);
        let pairs = decode_scope(&scope.drain());
        assert_eq!(pairs.len(), 800);
        assert!(pairs.iter().all(|&(l, r)| l == 16384 && r == -16384));
    }

    #[test]
    fn scope_keeps_a_partial_group_across_emits() {
        let mut scope = ScopeCollector::new();
        // Three samples at 192 kHz (factor 4): no pair yet.
        for _ in 0..3 {
            scope.push(0.5, 0.5, 192_000);
        }
        assert!(decode_scope(&scope.drain()).is_empty());
        scope.push(0.5, 0.5, 192_000);
        assert_eq!(decode_scope(&scope.drain()), vec![(16384, 16384)]);
    }

    #[test]
    fn scope_is_empty_in_silence_and_capped_when_stalled() {
        let mut scope = ScopeCollector::new();
        for _ in 0..800 {
            scope.push(0.0, 0.0, 48_000);
        }
        assert!(scope.drain().is_empty());
        for i in 0..(SCOPE_MAX_PAIRS * 3) {
            scope.push(i as f32 / (SCOPE_MAX_PAIRS * 3) as f32, 0.1, 48_000);
        }
        let pairs = decode_scope(&scope.drain());
        assert_eq!(pairs.len(), SCOPE_MAX_PAIRS);
        // The newest pairs survive.
        assert!(pairs.last().unwrap().0 > 32700);
    }

    #[test]
    fn tapped_source_keeps_mono_for_features_and_stereo_for_the_scope() {
        use super::{tap_channel, TappedSource};
        use rodio::buffer::SamplesBuffer;
        let (tx, rx) = tap_channel();
        let stereo = SamplesBuffer::new(2, 48_000, vec![16384i16, -8192, 8192, 0]);
        let passed: Vec<i16> = TappedSource::new(stereo, tx.clone()).collect();
        // Samples pass through to the sink unchanged.
        assert_eq!(passed, vec![16384, -8192, 8192, 0]);
        let frames: Vec<_> = rx.try_iter().collect();
        assert_eq!(frames.len(), 2);
        assert_close(frames[0].left, 0.5);
        assert_close(frames[0].right, -0.25);
        assert_close(frames[0].sample, 0.125);
        assert_close(frames[1].left, 0.25);
        assert_close(frames[1].right, 0.0);
        assert_eq!(frames[1].sample_rate, 48_000);

        // A mono source puts the same signal on both scope axes.
        let mono = SamplesBuffer::new(1, 44_100, vec![16384i16, -16384]);
        let _: Vec<i16> = TappedSource::new(mono, tx).collect();
        let frames: Vec<_> = rx.try_iter().collect();
        assert_eq!(frames.len(), 2);
        assert_close(frames[0].sample, 0.5);
        assert_close(frames[0].left, 0.5);
        assert_close(frames[0].right, 0.5);
        assert_close(frames[1].right, -0.5);
    }

    #[test]
    fn scope_clamps_out_of_range_samples() {
        let mut scope = ScopeCollector::new();
        scope.push(2.0, -2.0, 48_000);
        assert_eq!(decode_scope(&scope.drain()), vec![(32767, -32767)]);
    }

    fn assert_close(actual: f32, expected: f32) {
        assert!(
            (actual - expected).abs() < 1e-5,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn pcm_levels_report_silence() {
        let (rms, peak) = pcm_levels(&[0.0; 32]);
        assert_eq!((rms, peak), (0.0, 0.0));
    }

    #[test]
    fn pcm_levels_use_waveform_amplitude() {
        let (rms, peak) = pcm_levels(&[0.5, -0.5, 0.5, -0.5]);
        assert_close(rms, 0.5);
        assert_close(peak, 0.5);
    }

    #[test]
    fn pcm_levels_match_a_sine_wave() {
        let samples: Vec<f32> = (0..2048)
            .map(|i| {
                let phase = 2.0 * std::f32::consts::PI * 32.0 * i as f32 / 2048.0;
                0.8 * phase.sin()
            })
            .collect();

        let (rms, peak) = pcm_levels(&samples);
        assert_close(rms, 0.8 / 2.0f32.sqrt());
        assert_close(peak, 0.8);
    }

    #[test]
    fn pcm_levels_stay_normalized() {
        let (rms, peak) = pcm_levels(&[2.0, -2.0]);
        assert_eq!((rms, peak), (1.0, 1.0));
    }
}
