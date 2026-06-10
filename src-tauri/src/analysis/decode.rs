//! Decode an audio file to mono f32 at the analysis sample rate.

use std::fs::File;
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

pub const ANALYSIS_SAMPLE_RATE: u32 = 22_050;

/// Decode the whole file, downmix to mono, linear-resample to
/// [`ANALYSIS_SAMPLE_RATE`]. Linear interpolation is plenty for feature
/// extraction — we never play these samples back.
pub fn decode_to_mono(path: &Path) -> Result<Vec<f32>, String> {
    let file = File::open(path).map_err(|e| format!("open {}: {}", path.display(), e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("probe: {}", e))?;

    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| "no audio track".to_string())?;
    let track_id = track.id;
    let src_rate = track.codec_params.sample_rate.unwrap_or(44_100);
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("decoder: {}", e))?;

    let mut mono: Vec<f32> = Vec::new();
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                break
            }
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(format!("packet: {}", e)),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            // Skip corrupt packets rather than failing the whole analysis.
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(e) => return Err(format!("decode: {}", e)),
        };
        let spec = *decoded.spec();
        let channels = spec.channels.count().max(1);
        let buf = sample_buf.get_or_insert_with(|| {
            SampleBuffer::<f32>::new(decoded.capacity() as u64, spec)
        });
        buf.copy_interleaved_ref(decoded);
        let samples = buf.samples();
        for frame in samples.chunks_exact(channels) {
            let sum: f32 = frame.iter().sum();
            mono.push(sum / channels as f32);
        }
    }

    if mono.is_empty() {
        return Err("decoded zero samples".to_string());
    }

    if src_rate == ANALYSIS_SAMPLE_RATE {
        return Ok(mono);
    }

    // Linear resample.
    let ratio = src_rate as f64 / ANALYSIS_SAMPLE_RATE as f64;
    let out_len = (mono.len() as f64 / ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * ratio;
        let i0 = pos as usize;
        let i1 = (i0 + 1).min(mono.len() - 1);
        let frac = (pos - i0 as f64) as f32;
        out.push(mono[i0] * (1.0 - frac) + mono[i1] * frac);
    }
    Ok(out)
}
