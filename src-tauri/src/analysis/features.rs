//! STFT feature extraction: per-frame RMS, spectral flux (onset novelty),
//! chroma (12 pitch classes), and coarse band energies.

use realfft::RealFftPlanner;

pub const FFT_SIZE: usize = 2048;
pub const HOP: usize = 512;

pub struct FrameFeatures {
    /// Frames per second of the feature streams below.
    pub fps: f32,
    pub rms: Vec<f32>,
    pub flux: Vec<f32>,
    /// Row-major \[frame]\[12] pitch-class energy.
    pub chroma: Vec<[f32; 12]>,
    /// Row-major \[frame]\[4]: bass / low-mid / mid / treble energy.
    pub bands: Vec<[f32; 4]>,
}

pub fn extract(samples: &[f32], sample_rate: u32) -> FrameFeatures {
    let mut planner = RealFftPlanner::<f32>::new();
    let r2c = planner.plan_fft_forward(FFT_SIZE);
    let mut input = vec![0.0f32; FFT_SIZE];
    let mut spectrum = r2c.make_output_vec();

    let window: Vec<f32> = (0..FFT_SIZE)
        .map(|i| {
            let t = i as f32 / (FFT_SIZE - 1) as f32;
            0.5 - 0.5 * (2.0 * std::f32::consts::PI * t).cos()
        })
        .collect();

    let n_frames = if samples.len() > FFT_SIZE {
        (samples.len() - FFT_SIZE) / HOP + 1
    } else {
        0
    };
    let bin_hz = sample_rate as f32 / FFT_SIZE as f32;
    let n_bins = FFT_SIZE / 2 + 1;

    // Precompute bin → pitch-class map for the chroma range (55 Hz – 5 kHz).
    let pitch_class: Vec<Option<usize>> = (0..n_bins)
        .map(|b| {
            let f = b as f32 * bin_hz;
            if !(55.0..=5000.0).contains(&f) {
                return None;
            }
            let midi = 69.0 + 12.0 * (f / 440.0).log2();
            Some(((midi.round() as i32).rem_euclid(12)) as usize)
        })
        .collect();

    let mut rms = Vec::with_capacity(n_frames);
    let mut flux = Vec::with_capacity(n_frames);
    let mut chroma = Vec::with_capacity(n_frames);
    let mut bands = Vec::with_capacity(n_frames);
    let mut prev_mags = vec![0.0f32; n_bins];

    for frame_idx in 0..n_frames {
        let start = frame_idx * HOP;
        let chunk = &samples[start..start + FFT_SIZE];

        let mut sq = 0.0f32;
        for (i, (&s, &w)) in chunk.iter().zip(window.iter()).enumerate() {
            input[i] = s * w;
            sq += s * s;
        }
        rms.push((sq / FFT_SIZE as f32).sqrt());

        if r2c.process(&mut input, &mut spectrum).is_err() {
            flux.push(0.0);
            chroma.push([0.0; 12]);
            bands.push([0.0; 4]);
            continue;
        }

        let mut f = 0.0f32;
        let mut ch = [0.0f32; 12];
        let mut bd = [0.0f32; 4];
        for (b, c) in spectrum.iter().enumerate() {
            // sqrt compression tames the dynamic range so flux is driven by
            // broadband onsets, not a single loud partial.
            let mag = (c.norm() / FFT_SIZE as f32).sqrt();
            f += (mag - prev_mags[b]).max(0.0);
            prev_mags[b] = mag;

            if let Some(pc) = pitch_class[b] {
                ch[pc] += mag * mag;
            }
            let hz = b as f32 * bin_hz;
            let band = if hz < 150.0 {
                0
            } else if hz < 800.0 {
                1
            } else if hz < 3000.0 {
                2
            } else {
                3
            };
            bd[band] += mag * mag;
        }
        flux.push(f / n_bins as f32);
        chroma.push(ch);
        bands.push(bd);
    }

    FrameFeatures {
        fps: sample_rate as f32 / HOP as f32,
        rms,
        flux,
        chroma,
        bands,
    }
}
