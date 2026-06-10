//! Section boundaries via Foote checkerboard novelty on a per-second
//! self-similarity matrix, then energy-quantile labeling and a drop
//! schedule. Labels are honest heuristics ("energy-derived"), not the
//! allin1 vocabulary — good enough to choreograph against, replaceable
//! by the NN stack in Phase 2b without changing the schema.

use super::features::FrameFeatures;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Section {
    pub start_ms: u64,
    pub end_ms: u64,
    /// intro | verse | build | chorus | drop | breakdown | outro
    pub label: String,
    /// Mean loudness of the section, normalized to the track max (0..1).
    pub energy: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DropEvent {
    pub at_ms: u64,
    /// Energy jump across the boundary, 0..1.
    pub strength: f32,
}

const KERNEL_HALF: usize = 12; // seconds of context each side of a boundary
const MIN_GAP_S: usize = 8;

pub fn segment(features: &FrameFeatures) -> (Vec<Section>, Vec<DropEvent>) {
    let fps = features.fps;
    let frames_per_sec = fps.round() as usize;
    let n_secs = features.rms.len() / frames_per_sec.max(1);
    if n_secs < 20 {
        // Under ~20s: one section, no internal structure worth claiming.
        let dur_ms = (features.rms.len() as f32 / fps * 1000.0) as u64;
        return (
            vec![Section {
                start_ms: 0,
                end_ms: dur_ms,
                label: "verse".to_string(),
                energy: 1.0,
            }],
            Vec::new(),
        );
    }

    // Per-second feature vectors: 12 chroma + 4 bands, L2-normalized.
    let mut vecs: Vec<[f32; 16]> = Vec::with_capacity(n_secs);
    let mut sec_rms: Vec<f32> = Vec::with_capacity(n_secs);
    for s in 0..n_secs {
        let lo = s * frames_per_sec;
        let hi = ((s + 1) * frames_per_sec).min(features.rms.len());
        let mut v = [0.0f32; 16];
        let mut r = 0.0f32;
        for f in lo..hi {
            for (i, c) in features.chroma[f].iter().enumerate() {
                v[i] += c;
            }
            for (i, b) in features.bands[f].iter().enumerate() {
                v[12 + i] += b;
            }
            r += features.rms[f];
        }
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
        for x in v.iter_mut() {
            *x /= norm;
        }
        vecs.push(v);
        sec_rms.push(r / (hi - lo).max(1) as f32);
    }

    // Foote novelty: checkerboard kernel correlation along the SSM diagonal.
    // Computed lazily per (i,j) — the kernel window is small (24x24).
    let sim = |a: usize, b: usize| -> f32 {
        vecs[a].iter().zip(vecs[b].iter()).map(|(x, y)| x * y).sum()
    };
    let mut novelty = vec![0.0f32; n_secs];
    for t in KERNEL_HALF..n_secs.saturating_sub(KERNEL_HALF) {
        let mut score = 0.0f32;
        for i in 0..KERNEL_HALF {
            for j in 0..KERNEL_HALF {
                // within-past + within-future similarity counts positive,
                // cross-boundary similarity counts negative.
                score += sim(t - 1 - i, t - 1 - j);
                score += sim(t + i, t + j);
                score -= 2.0 * sim(t - 1 - i, t + j);
            }
        }
        novelty[t] = score / (KERNEL_HALF * KERNEL_HALF) as f32;
    }

    // Peak pick: local maxima above mean + 0.8σ, ≥ MIN_GAP_S apart.
    let mean = novelty.iter().sum::<f32>() / n_secs as f32;
    let var = novelty.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / n_secs as f32;
    let thresh = mean + 0.8 * var.sqrt();
    let mut boundaries: Vec<usize> = vec![0];
    for t in 1..n_secs - 1 {
        if novelty[t] > thresh
            && novelty[t] >= novelty[t - 1]
            && novelty[t] >= novelty[t + 1]
            && t - boundaries.last().unwrap() >= MIN_GAP_S
        {
            boundaries.push(t);
        }
    }
    boundaries.push(n_secs);

    // Section energies, normalized to track max.
    let max_rms = sec_rms.iter().cloned().fold(1e-9f32, f32::max);
    let energies: Vec<f32> = boundaries
        .windows(2)
        .map(|w| {
            let slice = &sec_rms[w[0]..w[1]];
            (slice.iter().sum::<f32>() / slice.len().max(1) as f32) / max_rms
        })
        .collect();

    let mut sorted = energies.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let q = |p: f32| -> f32 {
        let idx = ((sorted.len() - 1) as f32 * p) as usize;
        sorted[idx]
    };
    let (q25, q40, q75) = (q(0.25), q(0.40), q(0.75));

    let n_sections = boundaries.len() - 1;
    let mut sections = Vec::with_capacity(n_sections);
    let mut drops = Vec::new();
    for (i, w) in boundaries.windows(2).enumerate() {
        let (lo, hi) = (w[0], w[1]);
        let e = energies[i];
        let start_ms = (lo as f32 * 1000.0) as u64;
        let end_ms = (hi as f32 * 1000.0) as u64;

        let label = if i == 0 {
            "intro"
        } else if i == n_sections - 1 && e <= q40 {
            "outro"
        } else if e >= q75 {
            if i > 0 && energies[i - 1] <= q40 {
                drops.push(DropEvent {
                    at_ms: start_ms,
                    strength: (e - energies[i - 1]).clamp(0.0, 1.0),
                });
                "drop"
            } else {
                "chorus"
            }
        } else if e <= q25 {
            "breakdown"
        } else {
            // Rising internal slope reads as a build into the next section.
            let third = ((hi - lo) / 3).max(1);
            let head: f32 =
                sec_rms[lo..lo + third].iter().sum::<f32>() / third as f32;
            let tail: f32 =
                sec_rms[hi - third..hi].iter().sum::<f32>() / third as f32;
            if tail > head * 1.35 {
                "build"
            } else {
                "verse"
            }
        };

        sections.push(Section {
            start_ms,
            end_ms,
            label: label.to_string(),
            energy: e,
        });
    }

    (sections, drops)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::features::FrameFeatures;

    /// Build a synthetic track: quiet intro, loud "chorus" with different
    /// chroma, quiet breakdown — boundaries should land near the seams.
    fn synthetic() -> FrameFeatures {
        let fps = 43.0;
        let frames_per_sec = 43;
        let total_secs = 90;
        let mut rms = Vec::new();
        let mut chroma = Vec::new();
        let mut bands = Vec::new();
        for s in 0..total_secs {
            let (level, pc): (f32, usize) = if s < 30 {
                (0.1, 0)
            } else if s < 60 {
                (0.9, 5)
            } else {
                (0.15, 2)
            };
            for _ in 0..frames_per_sec {
                rms.push(level);
                let mut c = [0.0f32; 12];
                c[pc] = 1.0;
                chroma.push(c);
                bands.push([level, level * 0.5, level * 0.3, level * 0.1]);
            }
        }
        let n = rms.len();
        FrameFeatures {
            fps,
            flux: vec![0.0; n],
            rms,
            chroma,
            bands,
        }
    }

    #[test]
    fn finds_the_loud_section_and_drop() {
        let (sections, drops) = segment(&synthetic());
        assert!(sections.len() >= 3, "expected >=3 sections, got {}", sections.len());
        assert!(
            sections.iter().any(|s| s.label == "drop" || s.label == "chorus"),
            "no high-energy section found: {:?}",
            sections.iter().map(|s| s.label.clone()).collect::<Vec<_>>()
        );
        // The quiet→loud seam at ~30s should register as a drop.
        assert!(
            drops.iter().any(|d| (25_000..40_000).contains(&d.at_ms)),
            "no drop near 30s: {:?}",
            drops
        );
    }
}
