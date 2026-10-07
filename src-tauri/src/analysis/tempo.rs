//! Global tempo + beat-grid phase from the spectral-flux novelty curve.
//! Steady-tempo assumption: one BPM + one offset describes the track.
//! (Per-window grids are a Phase 2b refinement.)

pub struct BeatGrid {
    pub bpm: f32,
    /// Milliseconds into the track where beat 0 falls.
    pub offset_ms: f32,
    /// Autocorrelation peak prominence, 0..1-ish. Below ~0.15 treat the
    /// grid as unreliable (rubato, ambient, speech).
    pub confidence: f32,
}

pub fn detect(flux: &[f32], fps: f32) -> BeatGrid {
    let fallback = BeatGrid {
        bpm: 120.0,
        offset_ms: 0.0,
        confidence: 0.0,
    };
    if flux.len() < (fps * 8.0) as usize {
        return fallback; // under ~8s of signal — don't pretend.
    }

    // Mean-removed novelty for a cleaner autocorrelation.
    let mean = flux.iter().sum::<f32>() / flux.len() as f32;
    let nov: Vec<f32> = flux.iter().map(|v| (v - mean).max(0.0)).collect();

    // Lag search 60–200 BPM.
    let min_lag = (fps * 60.0 / 200.0).floor() as usize;
    let max_lag = (fps * 60.0 / 60.0).ceil() as usize;
    let max_lag = max_lag.min(nov.len() / 2);
    if min_lag + 2 >= max_lag {
        return fallback;
    }

    let auto = |lag: usize| -> f32 {
        let n = nov.len() - lag;
        let mut s = 0.0f32;
        for i in 0..n {
            s += nov[i] * nov[i + lag];
        }
        s / n as f32
    };

    let mut best_lag = min_lag;
    let mut best_score = f32::MIN;
    let mut score_sum = 0.0f32;
    let mut score_count = 0u32;
    for lag in min_lag..=max_lag {
        // Reward lags whose double also correlates — picks the perceptual
        // beat over its half/double ambiguity more often than raw r(lag).
        let s = auto(lag) + 0.5 * auto((lag * 2).min(nov.len() / 2 - 1));
        score_sum += s;
        score_count += 1;
        if s > best_score {
            best_score = s;
            best_lag = lag;
        }
    }
    let mean_score = score_sum / score_count.max(1) as f32;
    let confidence = if best_score > 0.0 {
        ((best_score - mean_score) / best_score).clamp(0.0, 1.0)
    } else {
        0.0
    };

    // Parabolic refinement around the integer-lag peak.
    let refined_lag = if best_lag > min_lag && best_lag < max_lag {
        let ym1 = auto(best_lag - 1);
        let y0 = auto(best_lag);
        let yp1 = auto(best_lag + 1);
        let denom = ym1 - 2.0 * y0 + yp1;
        if denom.abs() > 1e-9 {
            best_lag as f32 + 0.5 * (ym1 - yp1) / denom
        } else {
            best_lag as f32
        }
    } else {
        best_lag as f32
    };
    let bpm = 60.0 * fps / refined_lag;

    // Phase: pick the grid offset whose beat positions collect the most flux.
    let period = refined_lag;
    let mut best_offset = 0.0f32;
    let mut best_energy = f32::MIN;
    let steps = period.ceil() as usize;
    for step in 0..steps {
        let offset = step as f32;
        let mut e = 0.0f32;
        let mut pos = offset;
        while (pos as usize) < nov.len() {
            e += nov[pos as usize];
            pos += period;
        }
        if e > best_energy {
            best_energy = e;
            best_offset = offset;
        }
    }

    BeatGrid {
        bpm,
        offset_ms: best_offset / fps * 1000.0,
        confidence,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_synthetic_click_track() {
        // 128 BPM click track in flux space at 43.066 fps (22050/512).
        let fps = 22050.0 / 512.0;
        let period = fps * 60.0 / 128.0;
        let len = (fps * 60.0) as usize; // one minute
        let mut flux = vec![0.01f32; len];
        let mut pos = 7.0f32; // arbitrary phase
        while (pos as usize) < len {
            flux[pos as usize] = 1.0;
            pos += period;
        }
        let grid = detect(&flux, fps);
        assert!(
            (grid.bpm - 128.0).abs() < 2.0,
            "expected ~128 BPM, got {}",
            grid.bpm
        );
        assert!(grid.confidence > 0.15, "confidence {}", grid.confidence);
    }

    #[test]
    fn flat_signal_reports_low_confidence() {
        let fps = 43.0;
        let flux = vec![0.5f32; (fps * 30.0) as usize];
        let grid = detect(&flux, fps);
        assert!(grid.confidence < 0.2, "confidence {}", grid.confidence);
    }
}
