//! Audio feature extraction for the visualizer.
//!
//! `TappedSource` wraps a rodio `Source<Item = i16>` and passes samples through
//! unchanged to the sink while pushing downmixed-mono f32 samples to the analyzer
//! thread over a non-blocking channel. The analyzer accumulates a sliding window,
//! runs a windowed real-FFT, and emits log-grouped magnitude bins + envelope
//! features to the frontend at ~60Hz.

use crossbeam_channel::{Receiver, Sender};
use parking_lot::Mutex;
use realfft::RealFftPlanner;
use rodio::Source;
use serde::Serialize;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const FFT_SIZE: usize = 2048;
const BIN_COUNT: usize = 64;
const EMIT_HZ: u64 = 60;
// Bound the tap channel so a stalled analyzer cannot blow memory; samples drop on overflow.
const TAP_CAPACITY: usize = 1 << 16;

#[derive(Clone, Debug, Serialize)]
pub struct AudioFeatures {
    pub bins: Vec<f32>, // BIN_COUNT log-spaced magnitudes, 0..1
    pub rms: f32,
    pub peak: f32,
    pub centroid: f32, // normalized 0..1 (relative to Nyquist)
    pub onset: bool,
    pub bass: f32,
    pub mid: f32,
    pub treble: f32,
    pub sample_rate: u32,
}

pub struct TapFrame {
    pub sample: f32, // -1.0..1.0 mono
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
}

impl<S: Source<Item = i16>> TappedSource<S> {
    pub fn new(inner: S, tap: Sender<TapFrame>) -> Self {
        Self {
            inner,
            tap,
            channel_idx: 0,
            accumulator: 0.0,
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
        self.channel_idx += 1;
        if self.channel_idx >= channels {
            let mono = self.accumulator / channels as f32;
            let _ = self.tap.try_send(TapFrame {
                sample: mono,
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
    let mut sr: u32 = 44100;
    let mut last_emit = Instant::now();
    let emit_interval = Duration::from_millis(1000 / EMIT_HZ);
    let mut prev_energy: f32 = 0.0;

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

        while let Ok(frame) = rx.try_recv() {
            ring[ring_head] = frame.sample;
            ring_head = (ring_head + 1) % FFT_SIZE;
            sr = frame.sample_rate;
        }

        if last_emit.elapsed() < emit_interval {
            continue;
        }
        last_emit = Instant::now();

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
        let peak = mags.iter().copied().fold(0.0f32, f32::max);
        let rms_sum: f32 = mags.iter().map(|m| m * m).sum();
        let rms = (rms_sum / mags.len() as f32).sqrt().min(1.0);

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
        let centroid = if den > 0.0 { (num / den) / nyquist } else { 0.0 };

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

        let features = AudioFeatures {
            bins,
            rms,
            peak: peak.min(1.0),
            centroid: centroid.clamp(0.0, 1.0),
            onset,
            bass: bass.clamp(0.0, 1.0),
            mid: mid.clamp(0.0, 1.0),
            treble: treble.clamp(0.0, 1.0),
            sample_rate: sr,
        };

        let handle = app_handle.lock().clone();
        if let Some(h) = handle {
            let _ = h.emit("audio:features", &features);
        }
    }
}
