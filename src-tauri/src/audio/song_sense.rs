//! A per-song estimate of tempo and key, built from what the analyzer
//! already measures. The analyzer's own BPM follows the music second by
//! second; this keeps the estimates since the song started and reports the
//! steady answer, so the player can show "≈128 BPM · Am" for a station that
//! does not publish its own.

use parking_lot::Mutex;
use std::sync::OnceLock;

/// Tempo estimates arrive about twice a second; ~60 s of them is plenty.
const MAX_TEMPO_SAMPLES: usize = 120;
/// Wait for this many tempo estimates (~10 s) before answering.
const MIN_TEMPO_SAMPLES: usize = 20;
/// Listen to ~15 s of audio (60 frames a second) before naming a key, and
/// need some clearly pitched material among it.
const MIN_KEY_FRAMES: u32 = 15 * 60;
const MIN_KEY_WEIGHT: f32 = 10.0;

#[derive(Default)]
struct Sense {
    tempos: Vec<f32>,
    chroma: [f32; 12],
    key_weight: f32,
    key_frames: u32,
}

fn sense() -> &'static Mutex<Sense> {
    static SENSE: OnceLock<Mutex<Sense>> = OnceLock::new();
    SENSE.get_or_init(|| Mutex::new(Sense::default()))
}

/// Forget the previous song.
pub fn reset() {
    *sense().lock() = Sense::default();
}

/// One fresh tempo estimate in BPM.
pub fn push_tempo(bpm: f32) {
    if !(40.0..=240.0).contains(&bpm) {
        return;
    }
    let mut s = sense().lock();
    if s.tempos.len() >= MAX_TEMPO_SAMPLES {
        s.tempos.remove(0);
    }
    s.tempos.push(bpm);
}

/// One frame's normalised pitch-class profile, weighted by how loud and how
/// tonal the frame was.
pub fn push_chroma(chroma: &[f32; 12], weight: f32) {
    let mut s = sense().lock();
    s.key_frames += 1;
    if !(weight > 0.0) {
        return;
    }
    for (acc, value) in s.chroma.iter_mut().zip(chroma) {
        *acc += value * weight;
    }
    s.key_weight += weight;
}

/// The song's tempo and key so far, once there is enough to go on.
pub fn snapshot() -> (Option<f32>, Option<String>) {
    let s = sense().lock();
    let bpm = (s.tempos.len() >= MIN_TEMPO_SAMPLES).then(|| steady_tempo(&s.tempos));
    let key = (s.key_frames >= MIN_KEY_FRAMES && s.key_weight >= MIN_KEY_WEIGHT)
        .then(|| estimate_key(&s.chroma))
        .flatten();
    (bpm.flatten(), key)
}

/// The tempo most estimates agree on, within 2%: estimates are binned and
/// the fullest bin's median wins, so a few half/double-time slips do not
/// drag the answer.
fn steady_tempo(tempos: &[f32]) -> Option<f32> {
    let mut best: Option<(usize, f32)> = None;
    for &centre in tempos {
        let mut near: Vec<f32> = tempos
            .iter()
            .copied()
            .filter(|t| (t - centre).abs() <= centre * 0.02)
            .collect();
        if best.map_or(true, |(count, _)| near.len() > count) {
            near.sort_by(|a, b| a.total_cmp(b));
            best = Some((near.len(), near[near.len() / 2]));
        }
    }
    let (count, bpm) = best?;
    // Too scattered to call: no single tempo holds a third of the song.
    (count * 3 >= tempos.len()).then_some(bpm.round())
}

const NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];
// Krumhansl–Kessler key profiles.
const MAJOR: [f32; 12] = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR: [f32; 12] = [
    6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

fn correlation(chroma: &[f32; 12], profile: &[f32; 12], tonic: usize) -> f32 {
    let mean_c = chroma.iter().sum::<f32>() / 12.0;
    let mean_p = profile.iter().sum::<f32>() / 12.0;
    let (mut num, mut dc, mut dp) = (0.0, 0.0, 0.0);
    for i in 0..12 {
        let c = chroma[(i + tonic) % 12] - mean_c;
        let p = profile[i] - mean_p;
        num += c * p;
        dc += c * c;
        dp += p * p;
    }
    if dc <= 0.0 || dp <= 0.0 {
        return 0.0;
    }
    num / (dc.sqrt() * dp.sqrt())
}

/// Best-matching key as "C", "F#m" and so on, or none when nothing fits well.
pub fn estimate_key(chroma: &[f32; 12]) -> Option<String> {
    let mut best = (f32::MIN, String::new());
    for tonic in 0..12 {
        let major = correlation(chroma, &MAJOR, tonic);
        if major > best.0 {
            best = (major, NAMES[tonic].to_string());
        }
        let minor = correlation(chroma, &MINOR, tonic);
        if minor > best.0 {
            best = (minor, format!("{}m", NAMES[tonic]));
        }
    }
    (best.0 >= 0.5).then_some(best.1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steady_tempo_ignores_a_few_slips() {
        let mut tempos = vec![130.0; 30];
        tempos.extend([65.0, 65.2, 129.0, 131.0, 172.0]);
        assert_eq!(steady_tempo(&tempos), Some(130.0));
    }

    #[test]
    fn scattered_tempo_is_not_reported() {
        let tempos: Vec<f32> = (0..30).map(|i| 70.0 + i as f32 * 4.0).collect();
        assert_eq!(steady_tempo(&tempos), None);
    }

    #[test]
    fn names_keys_from_their_scales() {
        // C minor triad + scale tones weighted like a minor-key song.
        let mut c_minor = [0.0f32; 12];
        for (pc, w) in [
            (0, 6.0),
            (2, 2.5),
            (3, 5.0),
            (5, 3.0),
            (7, 4.5),
            (8, 3.0),
            (10, 2.5),
        ] {
            c_minor[pc] = w;
        }
        assert_eq!(estimate_key(&c_minor).as_deref(), Some("Cm"));
        let mut g_major = [0.0f32; 12];
        for (pc, w) in [
            (7, 6.0),
            (9, 2.5),
            (11, 4.5),
            (0, 3.5),
            (2, 5.0),
            (4, 2.5),
            (6, 2.5),
        ] {
            g_major[pc] = w;
        }
        assert_eq!(estimate_key(&g_major).as_deref(), Some("G"));
        assert_eq!(estimate_key(&[1.0; 12]), None);
    }
}
