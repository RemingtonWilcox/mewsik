//! Assembles the per-track "visual score": beat grid, sections, drops,
//! key, and a loudness arc. Serialized as JSON into the track_analysis
//! cache table; the frontend director performs against it.

use super::decode::{decode_to_mono, ANALYSIS_SAMPLE_RATE};
use super::features;
use super::structure::{self, DropEvent, Section};
use super::tempo;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Bump to invalidate every cached score when the algorithms change.
pub const ANALYSIS_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyEstimate {
    /// 0 = C … 11 = B.
    pub pitch_class: u8,
    /// "major" | "minor"
    pub mode: String,
    /// Correlation margin over the runner-up key, 0..1-ish.
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackScore {
    pub version: i64,
    pub duration_ms: u64,
    pub bpm: f32,
    pub beat_offset_ms: f32,
    pub beat_confidence: f32,
    pub key: KeyEstimate,
    pub sections: Vec<Section>,
    pub drops: Vec<DropEvent>,
    /// Loudness arc: one normalized RMS value per `energy_hz` of a second.
    pub energy_hz: f32,
    pub energy_curve: Vec<f32>,
}

pub fn analyze_file(path: &Path) -> Result<TrackScore, String> {
    let samples = decode_to_mono(path)?;
    let duration_ms = (samples.len() as f64 / ANALYSIS_SAMPLE_RATE as f64 * 1000.0) as u64;

    let feats = features::extract(&samples, ANALYSIS_SAMPLE_RATE);
    let grid = tempo::detect(&feats.flux, feats.fps);
    let (sections, drops) = structure::segment(&feats);
    let key = estimate_key(&feats.chroma);
    let (energy_hz, energy_curve) = energy_arc(&feats.rms, feats.fps);

    Ok(TrackScore {
        version: ANALYSIS_VERSION,
        duration_ms,
        bpm: grid.bpm,
        beat_offset_ms: grid.offset_ms,
        beat_confidence: grid.confidence,
        key,
        sections,
        drops,
        energy_hz,
        energy_curve,
    })
}

/// Krumhansl-Schmuckler key finding: correlate the track's summed chroma
/// against the 24 rotated major/minor profiles.
fn estimate_key(chroma: &[[f32; 12]]) -> KeyEstimate {
    const MAJOR: [f32; 12] = [
        6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
    ];
    const MINOR: [f32; 12] = [
        6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
    ];

    let mut total = [0.0f32; 12];
    for frame in chroma {
        for (i, v) in frame.iter().enumerate() {
            total[i] += v;
        }
    }

    let corr = |profile: &[f32; 12], rot: usize| -> f32 {
        // Pearson correlation between rotated chroma and profile.
        let n = 12.0f32;
        let mx = total.iter().sum::<f32>() / n;
        let my = profile.iter().sum::<f32>() / n;
        let mut num = 0.0;
        let mut dx = 0.0;
        let mut dy = 0.0;
        for i in 0..12 {
            let x = total[(i + rot) % 12] - mx;
            let y = profile[i] - my;
            num += x * y;
            dx += x * x;
            dy += y * y;
        }
        num / (dx.sqrt() * dy.sqrt()).max(1e-9)
    };

    let mut best = (0u8, "major", f32::MIN);
    let mut second = f32::MIN;
    for pc in 0..12u8 {
        for (mode, profile) in [("major", &MAJOR), ("minor", &MINOR)] {
            let r = corr(profile, pc as usize);
            if r > best.2 {
                second = best.2;
                best = (pc, mode, r);
            } else if r > second {
                second = r;
            }
        }
    }

    KeyEstimate {
        pitch_class: best.0,
        mode: best.1.to_string(),
        confidence: (best.2 - second).clamp(0.0, 1.0),
    }
}

/// Downsample frame RMS to 2 Hz, normalized to the track max.
fn energy_arc(rms: &[f32], fps: f32) -> (f32, Vec<f32>) {
    const HZ: f32 = 2.0;
    let per_bucket = (fps / HZ).round() as usize;
    if per_bucket == 0 || rms.is_empty() {
        return (HZ, Vec::new());
    }
    let mut curve: Vec<f32> = rms
        .chunks(per_bucket)
        .map(|c| c.iter().sum::<f32>() / c.len() as f32)
        .collect();
    let max = curve.iter().cloned().fold(1e-9f32, f32::max);
    for v in curve.iter_mut() {
        *v /= max;
    }
    (HZ, curve)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_estimate_finds_c_major_triad() {
        // Heavy C, E, G chroma → C major.
        let mut frame = [0.1f32; 12];
        frame[0] = 1.0; // C
        frame[4] = 0.8; // E
        frame[7] = 0.9; // G
        let key = estimate_key(&vec![frame; 100]);
        assert_eq!(key.pitch_class, 0, "expected C, got pc {}", key.pitch_class);
        assert_eq!(key.mode, "major");
    }

    #[test]
    fn energy_arc_normalizes_to_one() {
        let rms = vec![0.5f32; 430];
        let (_hz, curve) = energy_arc(&rms, 43.0);
        assert!(!curve.is_empty());
        assert!((curve.iter().cloned().fold(0.0f32, f32::max) - 1.0).abs() < 1e-5);
    }
}
