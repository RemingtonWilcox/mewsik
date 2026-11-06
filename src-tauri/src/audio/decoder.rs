//! Streaming Symphonia decoder used for every local file and fetched stream.
//!
//! rodio's own `Decoder::new` probes without a container hint, which
//! misreads MP4 files that carry an embedded cover image and then panics on
//! the audio thread. Probing here always uses the file extension (or MIME
//! type) as the hint, picks the first real audio track, and never panics:
//! decode errors skip the bad packet and an unreadable stream just ends.

use rodio::source::SeekError;
use rodio::Source;
use std::fs::File;
use std::path::Path;
use std::time::Duration;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder as CodecDecoder, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::{Time, TimeBase};

/// Consecutive undecodable packets tolerated before the stream is treated as
/// finished. A few bad frames in an MP3 are normal; hundreds mean garbage.
const MAX_CONSECUTIVE_DECODE_ERRORS: usize = 64;

pub struct AudioDecoder {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn CodecDecoder>,
    track_id: u32,
    time_base: Option<TimeBase>,
    total_duration: Option<Duration>,
    samples: Vec<i16>,
    cursor: usize,
    channels: u16,
    sample_rate: u32,
    finished: bool,
}

impl AudioDecoder {
    pub fn open_path(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("File open error: {e}"))?;
        let extension = path.extension().and_then(|ext| ext.to_str());
        Self::from_media(Box::new(file), extension)
    }

    /// `hint` is a file extension such as "m4a" or "mp3".
    pub fn from_media(media: Box<dyn MediaSource>, hint: Option<&str>) -> Result<Self, String> {
        let stream = MediaSourceStream::new(media, Default::default());
        let mut probe_hint = Hint::new();
        if let Some(extension) = hint {
            probe_hint.with_extension(extension);
        }
        let format_options = FormatOptions {
            enable_gapless: true,
            ..Default::default()
        };
        let probed = symphonia::default::get_probe()
            .format(&probe_hint, stream, &format_options, &MetadataOptions::default())
            .map_err(|e| format!("Unsupported audio file: {e}"))?;
        let format = probed.format;

        let track = format
            .tracks()
            .iter()
            .find(|track| {
                track.codec_params.codec != CODEC_TYPE_NULL
                    && track.codec_params.sample_rate.is_some()
            })
            .ok_or_else(|| "No audio track in file".to_string())?;
        let track_id = track.id;
        let time_base = track.codec_params.time_base;
        let total_duration = time_base
            .zip(track.codec_params.n_frames)
            .map(|(base, frames)| time_to_duration(base.calc_time(frames)));
        let decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())
            .map_err(|e| format!("Unsupported codec: {e}"))?;
        let channels = track.codec_params.channels.map_or(2, |c| c.count() as u16);
        let sample_rate = track.codec_params.sample_rate.unwrap_or(44_100);

        let mut this = Self {
            format,
            decoder,
            track_id,
            time_base,
            total_duration,
            samples: Vec::new(),
            cursor: 0,
            channels,
            sample_rate,
            finished: false,
        };
        // Decode the first packet now so a file that cannot produce audio
        // fails here, where the caller can report it, not silently later.
        if !this.decode_next() {
            return Err("File contains no playable audio".to_string());
        }
        Ok(this)
    }

    /// Decodes packets until one yields samples. Returns false at the end.
    fn decode_next(&mut self) -> bool {
        let mut errors = 0;
        loop {
            let packet = match self.format.next_packet() {
                Ok(packet) => packet,
                Err(SymphoniaError::ResetRequired) => {
                    self.decoder.reset();
                    continue;
                }
                Err(_) => {
                    self.finished = true;
                    return false;
                }
            };
            if packet.track_id() != self.track_id {
                continue;
            }
            match self.decoder.decode(&packet) {
                Ok(decoded) => {
                    let spec = *decoded.spec();
                    if decoded.frames() == 0 {
                        continue;
                    }
                    let mut buffer = SampleBuffer::<i16>::new(decoded.capacity() as u64, spec);
                    buffer.copy_interleaved_ref(decoded);
                    self.samples.clear();
                    self.samples.extend_from_slice(buffer.samples());
                    self.cursor = 0;
                    self.channels = spec.channels.count().max(1) as u16;
                    self.sample_rate = spec.rate;
                    return true;
                }
                Err(SymphoniaError::DecodeError(_)) => {
                    errors += 1;
                    if errors > MAX_CONSECUTIVE_DECODE_ERRORS {
                        self.finished = true;
                        return false;
                    }
                }
                Err(_) => {
                    self.finished = true;
                    return false;
                }
            }
        }
    }
}

fn time_to_duration(time: Time) -> Duration {
    Duration::from_secs(time.seconds) + Duration::from_secs_f64(time.frac.clamp(0.0, 0.999_999))
}

impl Iterator for AudioDecoder {
    type Item = i16;

    fn next(&mut self) -> Option<i16> {
        if self.cursor >= self.samples.len() {
            if self.finished || !self.decode_next() {
                return None;
            }
        }
        let sample = self.samples[self.cursor];
        self.cursor += 1;
        Some(sample)
    }
}

impl Source for AudioDecoder {
    fn current_frame_len(&self) -> Option<usize> {
        // One track keeps one rate and channel count. Reporting packet-sized
        // frames made rodio rebuild its resampler every ~23 ms, dropping the
        // interpolation state each time: an audible crackle on any file
        // whose rate differs from the output device (44.1 kHz on 48 kHz).
        None
    }

    fn channels(&self) -> u16 {
        self.channels
    }

    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    fn total_duration(&self) -> Option<Duration> {
        self.total_duration
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        let target = match self.total_duration {
            // Some demuxers refuse a seek to the exact end.
            Some(total) if pos >= total => total.saturating_sub(Duration::from_millis(50)),
            _ => pos,
        };
        let result = self.format.seek(
            SeekMode::Accurate,
            SeekTo::Time {
                time: Time::from(target.as_secs_f64()),
                track_id: Some(self.track_id),
            },
        );
        self.decoder.reset();
        self.samples.clear();
        self.cursor = 0;
        match result {
            Ok(seeked) => {
                self.finished = false;
                // Accurate mode lands on the packet before the target; drop
                // the samples in front of it so the position is exact.
                if let Some(base) = self.time_base {
                    let landed = time_to_duration(base.calc_time(seeked.actual_ts));
                    if self.decode_next() && target > landed {
                        let skip_frames = ((target - landed).as_secs_f64()
                            * f64::from(self.sample_rate)) as usize;
                        let skip = (skip_frames * self.channels as usize).min(self.samples.len());
                        self.cursor = skip - skip % self.channels.max(1) as usize;
                    }
                }
                Ok(())
            }
            Err(error) => Err(SeekError::Other(Box::new(std::io::Error::other(
                error.to_string(),
            )))),
        }
    }
}

/// Extension hint for a MIME type, for streams without a file name.
pub fn extension_for_mime(mime: Option<&str>) -> Option<&'static str> {
    let normalized = mime?.split(';').next()?.trim().to_ascii_lowercase();
    Some(match normalized.as_str() {
        "audio/webm" | "video/webm" => "webm",
        "audio/mp4" | "audio/x-m4a" | "audio/m4a" | "video/mp4" | "audio/aac" => "m4a",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/ogg" | "application/ogg" | "audio/opus" => "ogg",
        "audio/flac" | "audio/x-flac" => "flac",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::AudioDecoder;
    use rodio::source::UniformSourceIterator;
    use rodio::Source;
    use std::path::Path;

    /// The old framing: a new rodio frame every 1024 stereo samples.
    struct PacketFramed<S>(S, usize);
    impl<S: Iterator<Item = i16>> Iterator for PacketFramed<S> {
        type Item = i16;
        fn next(&mut self) -> Option<i16> {
            self.1 = if self.1 <= 1 { 2048 } else { self.1 - 1 };
            self.0.next()
        }
    }
    impl<S: Source<Item = i16>> Source for PacketFramed<S> {
        fn current_frame_len(&self) -> Option<usize> {
            Some(self.1)
        }
        fn channels(&self) -> u16 {
            self.0.channels()
        }
        fn sample_rate(&self) -> u32 {
            self.0.sample_rate()
        }
        fn total_duration(&self) -> Option<std::time::Duration> {
            None
        }
    }

    fn spikes(out: Vec<i16>) -> (usize, f32) {
        let left: Vec<f32> = out.iter().step_by(2).map(|s| *s as f32).collect();
        // Second difference: smooth audio is small, a click is a spike.
        let d2: Vec<f32> = left.windows(3).map(|w| (w[0] - 2.0 * w[1] + w[2]).abs()).collect();
        let mean = d2.iter().sum::<f32>() / d2.len() as f32;
        (d2.iter().filter(|v| **v > mean * 12.0).count(), mean)
    }

    /// Resamples a file to 48 kHz the way the output does, with the old and
    /// the current framing, and counts clicks.
    /// `MEWSIK_PROBE_FILES="a.m4a" cargo test resample_click_probe -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn resample_click_probe() {
        let Ok(files) = std::env::var("MEWSIK_PROBE_FILES") else { return };
        for p in files.split(';') {
            let n = 48_000 * 2 * 15;
            let open = || AudioDecoder::open_path(Path::new(p)).expect("open");
            let old: Vec<i16> = UniformSourceIterator::<_, i16>::new(PacketFramed(open(), 2048), 2, 48_000)
                .take(n)
                .collect();
            let new: Vec<i16> = UniformSourceIterator::<_, i16>::new(open(), 2, 48_000).take(n).collect();
            println!("old {:?}  new {:?}  {p}", spikes(old), spikes(new));
        }
    }
}
