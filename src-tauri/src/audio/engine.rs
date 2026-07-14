use super::analyzer::{self, TappedSource};
use super::http_stream;
use super::queue::{new_queue_session_id, PlayQueue, QueueEntry, RepeatMode};
use crate::db::{
    self,
    models::{PlaybackState, QueueItem, QueueSnapshot},
    DbPool,
};
use crossbeam_channel::{Receiver, Sender};
use parking_lot::Mutex;
use rodio::{buffer::SamplesBuffer, Decoder, OutputStream, Sink, Source};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Cursor};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use symphonia::core::audio::SampleBuffer as SymphoniaSampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::AppHandle;

pub enum AudioCommand {
    PlayFile(String, String), // recording_id, file_path
    PlayEntry(QueueEntry),
    PlayFetchedRemote(QueueEntry, Vec<u8>, u64, u64),
    PlayPreparedRemote(QueueEntry, Box<dyn Source<Item = i16> + Send>, u64, u64),
    PlayUrl(String, String, String), // station_id, url, name
    PlayPreparedRadio(
        String,
        String,
        String,
        Box<dyn Source<Item = i16> + Send>,
        u64,
    ), // station_id, name, url, source, session
    Pause,
    Resume,
    Stop,
    StopForError(u64),
    Seek(u64), // ms
    SetVolume(f32),
    Next,
    Prev,
    SetShuffle(bool),
    SetRepeat(RepeatMode),
    AddToQueue(QueueEntry),
    InsertNext(QueueEntry),
    AppendContextIfSession {
        session_id: String,
        entries: Vec<QueueEntry>,
    },
    PlayQueueIndex(usize),
    PlayQueueEntry {
        session_id: String,
        entry_id: String,
    },
    RemoveFromQueue(usize),
    RemoveQueueEntry {
        session_id: String,
        entry_id: String,
    },
    ClearQueue,
    SetQueue(Vec<QueueEntry>, usize), // tracks, start_index
    StartQueue {
        session_id: String,
        tracks: Vec<QueueEntry>,
        start_index: usize,
    },
    GetState,
    Shutdown,
}

#[derive(Debug, Clone)]
pub enum AudioEvent {
    StateChanged(PlaybackState),
    TrackEnded,
    Error(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlaybackKind {
    Idle,
    Queue,
    Radio,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlayEndReason {
    NaturalEnd,
    Stopped,
    SkippedNext,
    SkippedPrevious,
    Restarted,
    QueueChanged,
    SourceChanged,
    PlaybackError,
    Shutdown,
    StreamEnded,
}

impl PlayEndReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::NaturalEnd => "natural_end",
            Self::Stopped => "stopped",
            Self::SkippedNext => "skipped_next",
            Self::SkippedPrevious => "skipped_previous",
            Self::Restarted => "restarted",
            Self::QueueChanged => "queue_changed",
            Self::SourceChanged => "source_changed",
            Self::PlaybackError => "playback_error",
            Self::Shutdown => "shutdown",
            Self::StreamEnded => "stream_ended",
        }
    }
}

/// One database history row plus an audible-time clock. Playback position is
/// deliberately not used as listened time: seeking can jump that position by
/// minutes without the listener hearing those minutes.
#[derive(Debug)]
struct ActivePlay {
    id: String,
    duration_ms: Option<i64>,
    listened_ms: u64,
    listening_since: Option<Instant>,
}

impl ActivePlay {
    fn new(id: String, duration_ms: Option<i64>, is_listening: bool) -> Self {
        Self {
            id,
            duration_ms: duration_ms.map(|value| value.max(0)),
            listened_ms: 0,
            listening_since: is_listening.then(Instant::now),
        }
    }

    fn set_listening(&mut self, is_listening: bool) {
        self.accrue();
        if is_listening {
            self.listening_since = Some(Instant::now());
        }
    }

    fn accrue(&mut self) {
        if let Some(started_at) = self.listening_since.take() {
            let elapsed = started_at.elapsed().as_millis();
            self.listened_ms = self
                .listened_ms
                .saturating_add(elapsed.min(u64::MAX as u128) as u64);
        }
    }

    fn finish(mut self) -> (String, i64, Option<i64>) {
        self.accrue();
        (
            self.id,
            self.listened_ms.min(i64::MAX as u64) as i64,
            self.duration_ms,
        )
    }
}

#[cfg(test)]
mod play_request_tests {
    use super::{ActivePlay, AudioEngine, PlayEndReason, PlayRequestGate};
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    #[test]
    fn newer_request_invalidates_older_finish() {
        let gate = PlayRequestGate::default();
        let first = gate.begin();
        let second = gate.begin();
        let actions = AtomicUsize::new(0);

        assert!(gate
            .finish_if_current(first, || actions.fetch_add(1, Ordering::SeqCst))
            .is_none());
        assert!(gate
            .finish_if_current(second, || actions.fetch_add(1, Ordering::SeqCst))
            .is_some());
        assert_eq!(actions.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn stop_style_invalidation_prevents_pending_finish() {
        let gate = PlayRequestGate::default();
        let pending = gate.begin();
        gate.invalidate_and(|| ());
        assert!(gate.finish_if_current(pending, || ()).is_none());
    }

    #[test]
    fn audible_clock_excludes_paused_time() {
        let mut play = ActivePlay::new("play".to_string(), Some(180_000), false);
        play.listening_since =
            Some(std::time::Instant::now() - std::time::Duration::from_millis(25));
        play.set_listening(false);
        let heard_before_pause = play.listened_ms;
        play.listening_since = None;
        std::thread::sleep(std::time::Duration::from_millis(5));

        let (_, listened_ms, duration_ms) = play.finish();
        assert!(heard_before_pause >= 20);
        assert_eq!(listened_ms as u64, heard_before_pause);
        assert_eq!(duration_ms, Some(180_000));
    }

    #[test]
    fn early_source_exhaustion_is_not_called_a_natural_end() {
        assert_eq!(
            super::AudioEngine::source_exhaustion_reason(20_000, Some(180_000)),
            PlayEndReason::StreamEnded
        );
        assert_eq!(
            super::AudioEngine::source_exhaustion_reason(176_000, Some(180_000)),
            PlayEndReason::NaturalEnd
        );
        assert_eq!(
            super::AudioEngine::source_exhaustion_reason(20_000, None),
            PlayEndReason::NaturalEnd
        );
    }

    #[test]
    fn stale_playback_error_cannot_target_a_newer_session() {
        let playback_session = AtomicU64::new(41);
        assert!(AudioEngine::error_session_is_current(&playback_session, 41));

        playback_session.store(42, Ordering::SeqCst);
        assert!(!AudioEngine::error_session_is_current(
            &playback_session,
            41
        ));
        assert!(AudioEngine::error_session_is_current(&playback_session, 42));
    }
}

#[derive(Default)]
struct PlayRequestGate {
    generation: Mutex<u64>,
}

impl PlayRequestGate {
    fn begin(&self) -> u64 {
        let mut generation = self.generation.lock();
        *generation = generation.saturating_add(1);
        *generation
    }

    fn invalidate_and<T>(&self, action: impl FnOnce() -> T) -> T {
        let mut generation = self.generation.lock();
        *generation = generation.saturating_add(1);
        action()
    }

    fn finish_if_current<T>(&self, expected: u64, action: impl FnOnce() -> T) -> Option<T> {
        let mut generation = self.generation.lock();
        if *generation != expected {
            return None;
        }
        *generation = generation.saturating_add(1);
        Some(action())
    }
}

pub struct AudioEngine {
    cmd_tx: Sender<AudioCommand>,
    event_rx: Receiver<AudioEvent>,
    state: Arc<Mutex<PlaybackState>>,
    queue_snapshot: Arc<Mutex<QueueSnapshot>>,
    app_handle: Arc<Mutex<Option<AppHandle>>>,
    play_request_gate: PlayRequestGate,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl AudioEngine {
    pub fn new(db: DbPool) -> Self {
        let (cmd_tx, cmd_rx) = crossbeam_channel::unbounded();
        let (event_tx, event_rx) = crossbeam_channel::unbounded();
        let state = Arc::new(Mutex::new(PlaybackState::default()));
        let queue_snapshot = Arc::new(Mutex::new(QueueSnapshot::default()));
        let app_handle: Arc<Mutex<Option<AppHandle>>> = Arc::new(Mutex::new(None));
        let state_clone = Arc::clone(&state);
        let queue_snapshot_clone = Arc::clone(&queue_snapshot);
        let app_handle_clone = Arc::clone(&app_handle);
        let loop_cmd_tx = cmd_tx.clone();

        let worker = std::thread::Builder::new()
            .name("audio-engine".to_string())
            .spawn(move || {
                Self::run_loop(
                    cmd_rx,
                    loop_cmd_tx,
                    event_tx,
                    state_clone,
                    queue_snapshot_clone,
                    db,
                    app_handle_clone,
                );
            })
            .expect("failed to spawn audio engine thread");

        Self {
            cmd_tx,
            event_rx,
            state,
            queue_snapshot,
            app_handle,
            play_request_gate: PlayRequestGate::default(),
            worker: Mutex::new(Some(worker)),
        }
    }

    /// Called after Tauri's setup() so the engine can emit `audio:features` events.
    pub fn set_app_handle(&self, handle: AppHandle) {
        *self.app_handle.lock() = Some(handle);
    }

    pub fn send(&self, cmd: AudioCommand) {
        if matches!(
            &cmd,
            AudioCommand::PlayFile(..)
                | AudioCommand::PlayEntry(..)
                | AudioCommand::PlayUrl(..)
                | AudioCommand::Stop
                | AudioCommand::StopForError(..)
                | AudioCommand::Next
                | AudioCommand::Prev
                | AudioCommand::PlayQueueIndex(..)
                | AudioCommand::PlayQueueEntry { .. }
                | AudioCommand::SetQueue(..)
                | AudioCommand::StartQueue { .. }
                | AudioCommand::Shutdown
        ) {
            self.play_request_gate.invalidate_and(|| {
                let _ = self.cmd_tx.send(cmd);
            });
        } else {
            let _ = self.cmd_tx.send(cmd);
        }
    }

    /// Reserve ownership of the next async play. Any subsequent play/stop
    /// command invalidates this token before its engine command is queued.
    pub fn begin_play_request(&self) -> u64 {
        self.play_request_gate.begin()
    }

    /// Atomically verify request ownership and enqueue its play command. The
    /// gate lock makes ordering with a simultaneous Stop/new play unambiguous.
    pub fn finish_play_request(&self, request: u64, cmd: AudioCommand) -> bool {
        self.play_request_gate
            .finish_if_current(request, || self.cmd_tx.send(cmd).is_ok())
            .unwrap_or(false)
    }

    pub fn try_recv_event(&self) -> Option<AudioEvent> {
        self.event_rx.try_recv().ok()
    }

    pub fn get_state(&self) -> PlaybackState {
        self.state.lock().clone()
    }

    pub fn get_queue(&self) -> QueueSnapshot {
        self.queue_snapshot.lock().clone()
    }

    /// Starts a replacement queue session and returns its guard synchronously.
    /// Commands sent through this engine sender retain FIFO order, so a later
    /// `append_context_if_session` can safely use this ID without waiting for a
    /// UI poll to observe the new snapshot.
    pub fn start_queue(&self, tracks: Vec<QueueEntry>, start_index: usize) -> String {
        let session_id = new_queue_session_id();
        let command = AudioCommand::StartQueue {
            session_id: session_id.clone(),
            tracks,
            start_index,
        };
        self.send(command);
        session_id
    }

    pub fn append_context_if_session(&self, session_id: String, entries: Vec<QueueEntry>) {
        self.send(AudioCommand::AppendContextIfSession {
            session_id,
            entries,
        });
    }

    pub fn select_queue_entry(&self, session_id: String, entry_id: String) {
        self.send(AudioCommand::PlayQueueEntry {
            session_id,
            entry_id,
        });
    }

    pub fn remove_queue_entry(&self, session_id: String, entry_id: String) {
        self.send(AudioCommand::RemoveQueueEntry {
            session_id,
            entry_id,
        });
    }

    /// Flush the active play before application teardown. Joining the worker
    /// makes the database write deterministic instead of racing process exit.
    pub fn shutdown(&self) {
        self.play_request_gate.invalidate_and(|| {
            let _ = self.cmd_tx.send(AudioCommand::Shutdown);
        });
        if let Some(worker) = self.worker.lock().take() {
            let _ = worker.join();
        }
    }

    fn should_prefer_full_fetch(entry: &QueueEntry) -> bool {
        entry
            .stream_mime_type
            .as_deref()
            .map(|mime| {
                let normalized = mime
                    .split(';')
                    .next()
                    .unwrap_or(mime)
                    .trim()
                    .to_ascii_lowercase();
                matches!(
                    normalized.as_str(),
                    "audio/mp4" | "audio/x-m4a" | "video/mp4"
                )
            })
            .unwrap_or(false)
    }

    fn fetch_remote_audio(url: &str, headers: &HashMap<String, String>) -> Result<Vec<u8>, String> {
        http_stream::fetch_http_audio_bytes(url, headers)
    }

    fn normalized_stream_mime(entry: &QueueEntry) -> Option<String> {
        entry.stream_mime_type.as_deref().map(|mime| {
            mime.split(';')
                .next()
                .unwrap_or(mime)
                .trim()
                .to_ascii_lowercase()
        })
    }

    fn should_decode_with_symphonia(entry: &QueueEntry) -> bool {
        if entry.source == "youtube" {
            return true;
        }

        matches!(
            Self::normalized_stream_mime(entry).as_deref(),
            Some("audio/webm") | Some("video/webm")
        )
    }

    fn symphonia_extension_hint(entry: &QueueEntry) -> Option<&'static str> {
        match Self::normalized_stream_mime(entry).as_deref() {
            Some("audio/webm") | Some("video/webm") => Some("webm"),
            Some("audio/mp4") | Some("audio/x-m4a") | Some("video/mp4") => Some("mp4"),
            Some("audio/mpeg") => Some("mp3"),
            _ => None,
        }
    }

    fn decode_audio_bytes_with_symphonia(
        entry: &QueueEntry,
        bytes: Vec<u8>,
    ) -> Result<Box<dyn Source<Item = i16> + Send>, String> {
        let media_source = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
        let mut hint = Hint::new();
        if let Some(extension) = Self::symphonia_extension_hint(entry) {
            hint.with_extension(extension);
        }

        let probed = symphonia::default::get_probe()
            .format(
                &hint,
                media_source,
                &FormatOptions::default(),
                &MetadataOptions::default(),
            )
            .map_err(|err| format!("Failed to probe audio: {}", err))?;

        let mut format = probed.format;
        let track = format
            .default_track()
            .ok_or_else(|| "No audio track found in fetched stream".to_string())?;
        let track_id = track.id;
        let mut decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())
            .map_err(|err| format!("Failed to create decoder: {}", err))?;

        let mut sample_rate: Option<u32> = None;
        let mut channels: Option<u16> = None;
        let mut samples: Vec<i16> = Vec::new();

        loop {
            let packet = match format.next_packet() {
                Ok(packet) => packet,
                Err(SymphoniaError::IoError(err))
                    if err.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break;
                }
                Err(SymphoniaError::ResetRequired) => {
                    return Err("Decoder reset is not supported for fetched audio".to_string());
                }
                Err(err) => return Err(format!("Failed to read audio packet: {}", err)),
            };

            if packet.track_id() != track_id {
                continue;
            }

            let decoded = match decoder.decode(&packet) {
                Ok(decoded) => decoded,
                Err(SymphoniaError::DecodeError(_)) => continue,
                Err(SymphoniaError::IoError(err))
                    if err.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break;
                }
                Err(SymphoniaError::ResetRequired) => {
                    return Err("Decoder reset is not supported for fetched audio".to_string());
                }
                Err(err) => return Err(format!("Failed to decode fetched audio: {}", err)),
            };

            let spec = *decoded.spec();
            sample_rate.get_or_insert(spec.rate);
            channels.get_or_insert(spec.channels.count() as u16);

            let mut sample_buf = SymphoniaSampleBuffer::<i16>::new(decoded.capacity() as u64, spec);
            sample_buf.copy_interleaved_ref(decoded);
            samples.extend_from_slice(sample_buf.samples());
        }

        let sample_rate =
            sample_rate.ok_or_else(|| "Fetched audio produced no samples".to_string())?;
        let channels = channels.ok_or_else(|| "Fetched audio produced no channels".to_string())?;

        Ok(Box::new(SamplesBuffer::new(channels, sample_rate, samples)))
    }

    fn decode_audio_bytes_with_rodio(
        bytes: Vec<u8>,
    ) -> Result<Box<dyn Source<Item = i16> + Send>, String> {
        let reader = BufReader::new(Cursor::new(bytes));
        let decoder =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| Decoder::new(reader)))
                .map_err(|_| "Decode error: rodio decoder panicked".to_string())?
                .map_err(|err| format!("Decode error: {}", err))?;
        Ok(Box::new(decoder))
    }

    fn decode_fetched_audio(
        entry: &QueueEntry,
        bytes: Vec<u8>,
    ) -> Result<(Box<dyn Source<Item = i16> + Send>, bool), String> {
        let source = if Self::should_decode_with_symphonia(entry) {
            Self::decode_audio_bytes_with_symphonia(entry, bytes)?
        } else {
            Self::decode_audio_bytes_with_rodio(bytes)?
        };

        Ok((source, true))
    }

    fn start_remote_playback(
        sink: &Sink,
        tap_tx: &Sender<analyzer::TapFrame>,
        entry: &QueueEntry,
        source: Box<dyn Source<Item = i16> + Send>,
        can_seek: bool,
        position_reports_relative: bool,
        initial_position_ms: u64,
        state: &Arc<Mutex<PlaybackState>>,
        event_tx: &Sender<AudioEvent>,
        db: &DbPool,
        position_offset_ms: &mut u64,
        current_position_reports_relative: &mut bool,
        active_play: &mut Option<ActivePlay>,
        playback_kind: &mut PlaybackKind,
        awaiting_source: &mut bool,
        desired_playing: bool,
    ) {
        *awaiting_source = false;
        sink.stop();
        sink.pause();
        sink.append(TappedSource::new(source, tap_tx.clone()));
        *position_offset_ms = initial_position_ms;
        *current_position_reports_relative = position_reports_relative;
        if active_play.is_none() {
            *active_play = Self::begin_active_play(
                db,
                Some(&entry.recording_id),
                Some(&entry.source),
                None,
                entry.duration_ms,
                false,
            );
        }
        if desired_playing {
            sink.play();
        }
        if let Some(play) = active_play.as_mut() {
            play.set_listening(desired_playing);
        }
        *playback_kind = PlaybackKind::Queue;

        let mut s = state.lock();
        s.is_playing = desired_playing;
        s.is_buffering = false;
        s.can_seek = can_seek;
        s.current_recording_id = Some(entry.recording_id.clone());
        s.current_station_id = None;
        s.current_title = Some(entry.title.clone());
        s.current_artist = Some(entry.artist.clone());
        s.current_album_art = entry.cover_art.clone();
        s.current_source_url = entry.source_url.clone();
        s.position_ms = initial_position_ms;
        s.duration_ms = entry.duration_ms.unwrap_or(0) as u64;
        s.source = Some(entry.source.clone());
        let state_clone = s.clone();
        drop(s);
        let _ = event_tx.send(AudioEvent::StateChanged(state_clone));
    }

    fn start_radio_playback(
        sink: &Sink,
        tap_tx: &Sender<analyzer::TapFrame>,
        station_id: &str,
        name: &str,
        url: &str,
        source: Box<dyn Source<Item = i16> + Send>,
        state: &Arc<Mutex<PlaybackState>>,
        event_tx: &Sender<AudioEvent>,
        db: &DbPool,
        position_offset_ms: &mut u64,
        current_position_reports_relative: &mut bool,
        active_play: &mut Option<ActivePlay>,
        playback_kind: &mut PlaybackKind,
        awaiting_source: &mut bool,
        desired_playing: bool,
    ) {
        *awaiting_source = false;
        sink.stop();
        sink.pause();
        sink.append(TappedSource::new(source, tap_tx.clone()));
        *position_offset_ms = 0;
        *current_position_reports_relative = false;
        if active_play.is_none() {
            *active_play =
                Self::begin_active_play(db, None, Some("radio"), Some(station_id), None, false);
        }
        if desired_playing {
            sink.play();
        }
        if let Some(play) = active_play.as_mut() {
            play.set_listening(desired_playing);
        }
        *playback_kind = PlaybackKind::Radio;

        let mut s = state.lock();
        s.is_playing = desired_playing;
        s.is_buffering = false;
        s.can_seek = false;
        s.current_recording_id = None;
        s.current_station_id = Some(station_id.to_string());
        s.current_title = Some(name.to_string());
        s.current_artist = Some("Radio".to_string());
        s.current_album_art = None;
        s.current_source_url = Some(url.to_string());
        s.position_ms = 0;
        s.duration_ms = 0;
        s.source = Some("radio".to_string());
        let state_clone = s.clone();
        drop(s);
        let _ = event_tx.send(AudioEvent::StateChanged(state_clone));
    }

    fn prepare_youtube_remote_playback(
        queued_entry: QueueEntry,
        url: String,
        headers: HashMap<String, String>,
        cmd_tx: Sender<AudioCommand>,
        event_tx: Sender<AudioEvent>,
        playback_session: Arc<AtomicU64>,
        session_id: u64,
        seek_position_ms: u64,
    ) {
        match http_stream::prepare_ffmpeg_audio_source(
            url.clone(),
            headers.clone(),
            (seek_position_ms > 0).then_some(seek_position_ms),
            Arc::clone(&playback_session),
            session_id,
            96 * 1024,
            event_tx.clone(),
            format!("Track {}", queued_entry.title),
        ) {
            Ok(source) => {
                let _ = cmd_tx.send(AudioCommand::PlayPreparedRemote(
                    queued_entry,
                    source,
                    session_id,
                    seek_position_ms,
                ));
            }
            Err(stream_err) => {
                log::warn!(
                    "ffmpeg YouTube stream setup failed, falling back to full fetch: {}",
                    stream_err
                );
                match Self::fetch_remote_audio(&url, &headers) {
                    Ok(bytes) => {
                        let _ = cmd_tx.send(AudioCommand::PlayFetchedRemote(
                            queued_entry,
                            bytes,
                            session_id,
                            seek_position_ms,
                        ));
                    }
                    Err(fetch_err) => {
                        if playback_session.load(Ordering::SeqCst) != session_id {
                            return;
                        }
                        let _ = cmd_tx.send(AudioCommand::StopForError(session_id));
                        let _ = event_tx.send(AudioEvent::Error(fetch_err));
                    }
                }
            }
        }
    }

    fn play_queue_entry(
        sink: &Sink,
        tap_tx: &Sender<analyzer::TapFrame>,
        entry: &QueueEntry,
        cmd_tx: &Sender<AudioCommand>,
        event_tx: &Sender<AudioEvent>,
        state: &Arc<Mutex<PlaybackState>>,
        db: &DbPool,
        playback_session: &Arc<AtomicU64>,
        position_offset_ms: &mut u64,
        current_position_reports_relative: &mut bool,
        active_play: &mut Option<ActivePlay>,
        playback_kind: &mut PlaybackKind,
        awaiting_source: &mut bool,
        desired_playing: &mut bool,
        replacement_reason: PlayEndReason,
    ) -> Result<(), String> {
        let session_id = Self::reset_playback_session(
            sink,
            playback_session,
            db,
            position_offset_ms,
            current_position_reports_relative,
            active_play,
            *awaiting_source,
            replacement_reason,
        );
        *desired_playing = true;

        {
            let mut s = state.lock();
            s.current_recording_id = Some(entry.recording_id.clone());
            s.current_station_id = None;
            s.current_title = Some(entry.title.clone());
            s.current_artist = Some(entry.artist.clone());
            s.current_album_art = entry.cover_art.clone();
            s.current_source_url = entry.source_url.clone();
            s.position_ms = 0;
            s.duration_ms = entry.duration_ms.unwrap_or(0) as u64;
            s.source = Some(entry.source.clone());
            s.is_playing = false;
            s.is_buffering = false;
            s.can_seek = false;
            let state_clone = s.clone();
            drop(s);
            let _ = event_tx.send(AudioEvent::StateChanged(state_clone));
        }

        if let Some(path) = entry.file_path.as_ref() {
            *awaiting_source = false;
            let file = File::open(path).map_err(|e| format!("File open error: {}", e))?;
            let reader = BufReader::new(file);
            let source = Decoder::new(reader).map_err(|e| format!("Decode error: {}", e))?;
            sink.pause();
            sink.append(TappedSource::new(source, tap_tx.clone()));
        } else if let Some(url) = entry.source_url.as_ref() {
            *awaiting_source = true;
            {
                let mut s = state.lock();
                s.is_playing = false;
                s.is_buffering = true;
                s.can_seek = false;
                let state_clone = s.clone();
                drop(s);
                let _ = event_tx.send(AudioEvent::StateChanged(state_clone));
            }
            let url = url.clone();
            let headers = entry.source_headers.clone();
            let queued_entry = entry.clone();
            let cmd_tx = cmd_tx.clone();
            let event_tx = event_tx.clone();
            let playback_session = Arc::clone(playback_session);
            let prefer_full_fetch = Self::should_prefer_full_fetch(entry);
            let use_ffmpeg_stream = queued_entry.source == "youtube";
            let stream_mime_type = entry.stream_mime_type.clone();

            std::thread::Builder::new()
                .name("remote-track-prepare".to_string())
                .spawn(move || {
                    if use_ffmpeg_stream {
                        Self::prepare_youtube_remote_playback(
                            queued_entry,
                            url,
                            headers,
                            cmd_tx,
                            event_tx,
                            playback_session,
                            session_id,
                            0,
                        );
                        return;
                    }

                    if prefer_full_fetch {
                        log::info!(
                            "Using full-fetch playback path for {} ({}) with MIME {:?}",
                            queued_entry.title,
                            queued_entry.source,
                            stream_mime_type
                        );
                        match Self::fetch_remote_audio(&url, &headers) {
                            Ok(bytes) => {
                                let _ = cmd_tx.send(AudioCommand::PlayFetchedRemote(
                                    queued_entry,
                                    bytes,
                                    session_id,
                                    0,
                                ));
                            }
                            Err(fetch_err) => {
                                if playback_session.load(Ordering::SeqCst) != session_id {
                                    return;
                                }
                                let _ = cmd_tx.send(AudioCommand::StopForError(session_id));
                                let _ = event_tx.send(AudioEvent::Error(fetch_err));
                            }
                        }
                        return;
                    }

                    match http_stream::prepare_http_audio_source(
                        url.clone(),
                        headers.clone(),
                        Arc::clone(&playback_session),
                        session_id,
                        256 * 1024,
                        false,
                        event_tx.clone(),
                        format!("Track {}", queued_entry.title),
                    ) {
                        Ok(source) => {
                            let _ = cmd_tx.send(AudioCommand::PlayPreparedRemote(
                                queued_entry,
                                source,
                                session_id,
                                0,
                            ));
                        }
                        Err(stream_err) => {
                            log::warn!(
                                "Buffered stream setup failed, falling back to full fetch: {}",
                                stream_err
                            );
                            match Self::fetch_remote_audio(&url, &headers) {
                                Ok(bytes) => {
                                    let _ = cmd_tx.send(AudioCommand::PlayFetchedRemote(
                                        queued_entry,
                                        bytes,
                                        session_id,
                                        0,
                                    ));
                                }
                                Err(fetch_err) => {
                                    if playback_session.load(Ordering::SeqCst) != session_id {
                                        return;
                                    }
                                    let _ = cmd_tx.send(AudioCommand::StopForError(session_id));
                                    let _ = event_tx.send(AudioEvent::Error(fetch_err));
                                }
                            }
                        }
                    }
                })
                .map_err(|e| format!("Failed to spawn remote track fetch: {}", e))?;
            return Ok(());
        } else {
            *awaiting_source = false;
            return Err("No playable source for queue entry".to_string());
        }

        *position_offset_ms = 0;
        *active_play = Self::begin_active_play(
            db,
            Some(&entry.recording_id),
            Some(&entry.source),
            None,
            entry.duration_ms,
            false,
        );
        sink.play();
        if let Some(play) = active_play.as_mut() {
            play.set_listening(true);
        }
        *playback_kind = PlaybackKind::Queue;

        let mut s = state.lock();
        s.is_playing = true;
        s.is_buffering = false;
        s.can_seek = true;
        s.current_recording_id = Some(entry.recording_id.clone());
        s.current_station_id = None;
        s.current_title = Some(entry.title.clone());
        s.current_artist = Some(entry.artist.clone());
        s.current_album_art = entry.cover_art.clone();
        s.current_source_url = entry.source_url.clone();
        s.position_ms = 0;
        s.duration_ms = entry.duration_ms.unwrap_or(0) as u64;
        s.source = Some(entry.source.clone());
        let state_clone = s.clone();
        drop(s);
        let _ = event_tx.send(AudioEvent::StateChanged(state_clone));

        Ok(())
    }

    fn run_loop(
        cmd_rx: Receiver<AudioCommand>,
        cmd_tx: Sender<AudioCommand>,
        event_tx: Sender<AudioEvent>,
        state: Arc<Mutex<PlaybackState>>,
        queue_snapshot: Arc<Mutex<QueueSnapshot>>,
        db: DbPool,
        app_handle: Arc<Mutex<Option<AppHandle>>>,
    ) {
        let (_stream, stream_handle) = match OutputStream::try_default() {
            Ok(s) => s,
            Err(e) => {
                log::error!("Failed to open audio output: {}", e);
                let _ = event_tx.send(AudioEvent::Error(format!("No audio output: {}", e)));
                return;
            }
        };

        let sink = Arc::new(Sink::try_new(&stream_handle).expect("failed to create sink"));
        let (tap_tx, tap_rx) = analyzer::tap_channel();
        analyzer::spawn_analyzer(tap_rx, Arc::clone(&app_handle));
        let playback_session = Arc::new(AtomicU64::new(0));
        let mut queue = PlayQueue::new();
        Self::sync_queue_state(&queue, &queue_snapshot);
        let mut position_offset_ms: u64 = 0;
        let mut current_position_reports_relative = false;
        let mut active_play: Option<ActivePlay> = None;
        let mut last_position_update = Instant::now();
        let mut playback_kind = PlaybackKind::Idle;
        let mut awaiting_source = false;
        let mut desired_playing = false;

        loop {
            // Process commands
            match cmd_rx.recv_timeout(Duration::from_millis(50)) {
                Ok(AudioCommand::PlayFile(recording_id, path)) => {
                    Self::reset_playback_session(
                        &sink,
                        &playback_session,
                        &db,
                        &mut position_offset_ms,
                        &mut current_position_reports_relative,
                        &mut active_play,
                        awaiting_source,
                        PlayEndReason::SourceChanged,
                    );
                    awaiting_source = false;
                    desired_playing = true;
                    match File::open(&path) {
                        Ok(file) => {
                            let reader = BufReader::new(file);
                            match Decoder::new(reader) {
                                Ok(source) => {
                                    sink.stop();
                                    sink.pause();
                                    sink.append(TappedSource::new(source, tap_tx.clone()));
                                    position_offset_ms = 0;
                                    current_position_reports_relative = false;

                                    // Get recording info from DB
                                    let rec = db::queries::get_recording(&db, &recording_id)
                                        .ok()
                                        .flatten();
                                    let artist = {
                                        let conn = db.lock();
                                        conn.query_row(
                                            "SELECT a.name FROM recording_artists ra JOIN artists a ON a.id = ra.artist_id WHERE ra.recording_id = ?1 AND ra.role = 'primary' LIMIT 1",
                                            rusqlite::params![&recording_id],
                                            |row| row.get::<_, String>(0),
                                        ).ok()
                                    };

                                    let track_duration_ms =
                                        rec.as_ref().and_then(|recording| recording.duration_ms);

                                    // Record play history when audible playback starts.
                                    active_play = Self::begin_active_play(
                                        &db,
                                        Some(&recording_id),
                                        Some("local"),
                                        None,
                                        track_duration_ms,
                                        false,
                                    );
                                    sink.play();
                                    if let Some(play) = active_play.as_mut() {
                                        play.set_listening(true);
                                    }
                                    playback_kind = PlaybackKind::Queue;

                                    let mut s = state.lock();
                                    s.is_playing = true;
                                    s.is_buffering = false;
                                    s.can_seek = true;
                                    s.current_recording_id = Some(recording_id);
                                    s.current_station_id = None;
                                    s.current_title = rec.as_ref().map(|r| r.title.clone());
                                    s.current_artist = artist;
                                    s.current_album_art = rec.as_ref().and_then(|r| {
                                        r.cover_art_path.clone().or(r.cover_art_url.clone())
                                    });
                                    s.current_source_url = None;
                                    s.position_ms = 0;
                                    s.duration_ms = track_duration_ms.unwrap_or(0) as u64;
                                    s.source = Some("local".to_string());
                                    let state_clone = s.clone();
                                    drop(s);
                                    let _ = event_tx.send(AudioEvent::StateChanged(state_clone));
                                }
                                Err(e) => {
                                    let _ = event_tx
                                        .send(AudioEvent::Error(format!("Decode error: {}", e)));
                                }
                            }
                        }
                        Err(e) => {
                            let _ =
                                event_tx.send(AudioEvent::Error(format!("File open error: {}", e)));
                        }
                    }
                }
                Ok(AudioCommand::PlayEntry(entry)) => {
                    if let Err(err) = Self::play_queue_entry(
                        &sink,
                        &tap_tx,
                        &entry,
                        &cmd_tx,
                        &event_tx,
                        &state,
                        &db,
                        &playback_session,
                        &mut position_offset_ms,
                        &mut current_position_reports_relative,
                        &mut active_play,
                        &mut playback_kind,
                        &mut awaiting_source,
                        &mut desired_playing,
                        PlayEndReason::QueueChanged,
                    ) {
                        let _ = event_tx.send(AudioEvent::Error(err));
                    }
                }
                Ok(AudioCommand::PlayFetchedRemote(
                    entry,
                    bytes,
                    session_id,
                    initial_position_ms,
                )) => {
                    if playback_session.load(Ordering::SeqCst) != session_id {
                        continue;
                    }

                    awaiting_source = false;
                    match Self::decode_fetched_audio(&entry, bytes) {
                        Ok((source, can_seek)) => {
                            sink.stop();
                            sink.pause();
                            sink.append(TappedSource::new(source, tap_tx.clone()));
                            if initial_position_ms > 0 {
                                let _ = sink.try_seek(Duration::from_millis(initial_position_ms));
                            }
                            position_offset_ms = 0;
                            current_position_reports_relative = false;
                            if active_play.is_none() {
                                active_play = Self::begin_active_play(
                                    &db,
                                    Some(&entry.recording_id),
                                    Some(&entry.source),
                                    None,
                                    entry.duration_ms,
                                    false,
                                );
                            }
                            if desired_playing {
                                sink.play();
                            }
                            if let Some(play) = active_play.as_mut() {
                                play.set_listening(desired_playing);
                            }
                            playback_kind = PlaybackKind::Queue;

                            let mut s = state.lock();
                            s.is_playing = desired_playing;
                            s.is_buffering = false;
                            s.can_seek = can_seek;
                            s.current_recording_id = Some(entry.recording_id.clone());
                            s.current_station_id = None;
                            s.current_title = Some(entry.title.clone());
                            s.current_artist = Some(entry.artist.clone());
                            s.current_album_art = entry.cover_art.clone();
                            s.current_source_url = entry.source_url.clone();
                            s.position_ms = initial_position_ms;
                            s.duration_ms = entry.duration_ms.unwrap_or(0) as u64;
                            s.source = Some(entry.source.clone());
                            let state_clone = s.clone();
                            drop(s);
                            let _ = event_tx.send(AudioEvent::StateChanged(state_clone));
                        }
                        Err(err) => {
                            let _ = cmd_tx.send(AudioCommand::StopForError(session_id));
                            let _ = event_tx.send(AudioEvent::Error(err));
                        }
                    }
                }
                Ok(AudioCommand::PlayPreparedRemote(
                    entry,
                    source,
                    session_id,
                    initial_position_ms,
                )) => {
                    if playback_session.load(Ordering::SeqCst) != session_id {
                        continue;
                    }
                    Self::start_remote_playback(
                        &sink,
                        &tap_tx,
                        &entry,
                        source,
                        entry.can_seek || entry.source == "youtube",
                        entry.source == "youtube",
                        initial_position_ms,
                        &state,
                        &event_tx,
                        &db,
                        &mut position_offset_ms,
                        &mut current_position_reports_relative,
                        &mut active_play,
                        &mut playback_kind,
                        &mut awaiting_source,
                        desired_playing,
                    );
                }
                Ok(AudioCommand::PlayUrl(station_id, url, name)) => {
                    let session_id = Self::reset_playback_session(
                        &sink,
                        &playback_session,
                        &db,
                        &mut position_offset_ms,
                        &mut current_position_reports_relative,
                        &mut active_play,
                        awaiting_source,
                        PlayEndReason::SourceChanged,
                    );
                    queue.clear();
                    Self::sync_queue_state(&queue, &queue_snapshot);
                    playback_kind = PlaybackKind::Radio;
                    awaiting_source = true;
                    desired_playing = true;
                    active_play = Self::begin_active_play(
                        &db,
                        None,
                        Some("radio"),
                        Some(&station_id),
                        None,
                        false,
                    );

                    let url_clone = url.clone();
                    let event_tx_clone = event_tx.clone();
                    let playback_session_ref = Arc::clone(&playback_session);
                    let cmd_tx_clone = cmd_tx.clone();
                    let station_id_clone = station_id.clone();
                    let name_clone = name.clone();
                    let db_clone = db.clone();

                    // Update state immediately to show "loading"
                    {
                        let mut s = state.lock();
                        s.is_playing = false;
                        s.is_buffering = true;
                        s.can_seek = false;
                        s.current_recording_id = None;
                        s.current_station_id = Some(station_id.clone());
                        s.current_title = Some(name);
                        s.current_artist = Some("Radio - Connecting...".to_string());
                        s.current_album_art = None;
                        s.current_source_url = Some(url.clone());
                        s.source = Some("radio".to_string());
                        s.duration_ms = 0;
                        s.position_ms = 0;
                        let sc = s.clone();
                        drop(s);
                        let _ = event_tx.send(AudioEvent::StateChanged(sc));
                    }

                    std::thread::Builder::new()
                        .name("radio-stream-prepare".to_string())
                        .spawn(move || {
                            match http_stream::prepare_http_audio_source(
                                url_clone.clone(),
                                HashMap::new(),
                                Arc::clone(&playback_session_ref),
                                session_id,
                                128 * 1024,
                                true,
                                event_tx_clone.clone(),
                                format!("Station {}", name_clone),
                            ) {
                                Ok(source) => {
                                    let _ = cmd_tx_clone.send(AudioCommand::PlayPreparedRadio(
                                        station_id_clone,
                                        name_clone,
                                        url_clone,
                                        source,
                                        session_id,
                                    ));
                                }
                                Err(err) => {
                                    // Mark the station as failing so the next play
                                    // attempt re-resolves its URL (self-heal).
                                    let _ = db::queries::increment_station_fail_count(
                                        &db_clone,
                                        &station_id_clone,
                                    );
                                    if playback_session_ref.load(Ordering::SeqCst) != session_id {
                                        return;
                                    }
                                    let _ =
                                        cmd_tx_clone.send(AudioCommand::StopForError(session_id));
                                    let _ = event_tx_clone.send(AudioEvent::Error(format!(
                                        "Failed to start station stream: {}",
                                        err
                                    )));
                                }
                            }
                        })
                        .ok();

                    position_offset_ms = 0;
                }
                Ok(AudioCommand::PlayPreparedRadio(station_id, name, url, source, session_id)) => {
                    if playback_session.load(Ordering::SeqCst) != session_id {
                        continue;
                    }
                    Self::start_radio_playback(
                        &sink,
                        &tap_tx,
                        &station_id,
                        &name,
                        &url,
                        source,
                        &state,
                        &event_tx,
                        &db,
                        &mut position_offset_ms,
                        &mut current_position_reports_relative,
                        &mut active_play,
                        &mut playback_kind,
                        &mut awaiting_source,
                        desired_playing,
                    );
                }
                Ok(AudioCommand::Pause) => {
                    desired_playing = false;
                    sink.pause();
                    if let Some(play) = active_play.as_mut() {
                        play.set_listening(false);
                    }
                    let position_ms = Self::playback_position_ms(
                        &sink,
                        position_offset_ms,
                        current_position_reports_relative,
                        awaiting_source,
                    );
                    let mut s = state.lock();
                    s.is_playing = false;
                    s.position_ms = position_ms;
                    let state_clone = s.clone();
                    drop(s);
                    let _ = event_tx.send(AudioEvent::StateChanged(state_clone));
                }
                Ok(AudioCommand::Resume) => {
                    desired_playing = true;
                    if awaiting_source {
                        let mut s = state.lock();
                        s.is_playing = false;
                        s.is_buffering = true;
                        s.can_seek = false;
                        let state_clone = s.clone();
                        drop(s);
                        let _ = event_tx.send(AudioEvent::StateChanged(state_clone));
                    } else if !sink.empty() {
                        sink.play();
                        if let Some(play) = active_play.as_mut() {
                            play.set_listening(true);
                        }
                        let mut s = state.lock();
                        s.is_playing = true;
                        s.is_buffering = false;
                        let state_clone = s.clone();
                        drop(s);
                        let _ = event_tx.send(AudioEvent::StateChanged(state_clone));
                    }
                }
                Ok(stop_command @ (AudioCommand::Stop | AudioCommand::StopForError(..))) => {
                    let end_reason = match stop_command {
                        AudioCommand::StopForError(session_id) => {
                            if !Self::error_session_is_current(&playback_session, session_id) {
                                continue;
                            }
                            PlayEndReason::PlaybackError
                        }
                        _ => PlayEndReason::Stopped,
                    };
                    Self::reset_playback_session(
                        &sink,
                        &playback_session,
                        &db,
                        &mut position_offset_ms,
                        &mut current_position_reports_relative,
                        &mut active_play,
                        awaiting_source,
                        end_reason,
                    );
                    awaiting_source = false;
                    desired_playing = false;
                    playback_kind = PlaybackKind::Idle;
                    position_offset_ms = 0;
                    current_position_reports_relative = false;
                    let mut s = state.lock();
                    *s = PlaybackState::default();
                    s.volume = sink.volume();
                    let state_clone = s.clone();
                    drop(s);
                    let _ = event_tx.send(AudioEvent::StateChanged(state_clone));
                }
                Ok(AudioCommand::Seek(ms)) => {
                    let current_entry = if playback_kind == PlaybackKind::Queue {
                        queue.current().cloned()
                    } else {
                        None
                    };
                    if let Some(entry) = current_entry {
                        if entry.source == "youtube"
                            && entry.file_path.is_none()
                            && entry.source_url.is_some()
                        {
                            let url = entry.source_url.clone().unwrap_or_default();
                            let headers = entry.source_headers.clone();
                            let resume_after_seek = state.lock().is_playing;
                            if let Some(play) = active_play.as_mut() {
                                play.set_listening(false);
                            }
                            let session_id = Self::reset_source_session(
                                &sink,
                                &playback_session,
                                &mut position_offset_ms,
                                &mut current_position_reports_relative,
                            );
                            awaiting_source = true;
                            desired_playing = resume_after_seek;
                            position_offset_ms = ms;
                            current_position_reports_relative = true;

                            {
                                let mut s = state.lock();
                                s.is_playing = false;
                                s.is_buffering = true;
                                s.can_seek = true;
                                s.position_ms = ms;
                                let state_clone = s.clone();
                                drop(s);
                                let _ = event_tx.send(AudioEvent::StateChanged(state_clone));
                            }

                            let cmd_tx_clone = cmd_tx.clone();
                            let event_tx_clone = event_tx.clone();
                            let playback_session_ref = Arc::clone(&playback_session);
                            std::thread::Builder::new()
                                .name("youtube-seek-prepare".to_string())
                                .spawn(move || {
                                    Self::prepare_youtube_remote_playback(
                                        entry,
                                        url,
                                        headers,
                                        cmd_tx_clone,
                                        event_tx_clone,
                                        playback_session_ref,
                                        session_id,
                                        ms,
                                    );
                                })
                                .ok();
                            continue;
                        }
                    }

                    if !state.lock().can_seek {
                        let _ = event_tx.send(AudioEvent::Error(
                            "Seeking is not available for this stream".to_string(),
                        ));
                        continue;
                    }
                    match sink.try_seek(Duration::from_millis(ms)) {
                        Ok(()) => {
                            current_position_reports_relative = false;
                            desired_playing = state.lock().is_playing;
                            let mut s = state.lock();
                            s.position_ms = ms;
                            let state_clone = s.clone();
                            drop(s);
                            let _ = event_tx.send(AudioEvent::StateChanged(state_clone));
                        }
                        Err(err) => {
                            let should_disable_seek =
                                err.to_string().to_lowercase().contains("seek");
                            if should_disable_seek {
                                let mut s = state.lock();
                                s.can_seek = false;
                                let state_clone = s.clone();
                                drop(s);
                                let _ = event_tx.send(AudioEvent::StateChanged(state_clone));
                            }
                            let _ =
                                event_tx.send(AudioEvent::Error(format!("Seek failed: {}", err)));
                        }
                    }
                }
                Ok(AudioCommand::SetVolume(vol)) => {
                    sink.set_volume(vol);
                    let mut s = state.lock();
                    s.volume = vol;
                    let state_clone = s.clone();
                    drop(s);
                    let _ = event_tx.send(AudioEvent::StateChanged(state_clone));
                }
                Ok(AudioCommand::Next) => {
                    if let Some(entry) = queue.next().cloned() {
                        Self::sync_queue_state(&queue, &queue_snapshot);
                        if let Err(err) = Self::play_queue_entry(
                            &sink,
                            &tap_tx,
                            &entry,
                            &cmd_tx,
                            &event_tx,
                            &state,
                            &db,
                            &playback_session,
                            &mut position_offset_ms,
                            &mut current_position_reports_relative,
                            &mut active_play,
                            &mut playback_kind,
                            &mut awaiting_source,
                            &mut desired_playing,
                            PlayEndReason::SkippedNext,
                        ) {
                            let _ = event_tx.send(AudioEvent::Error(err));
                        }
                    } else {
                        Self::reset_playback_session(
                            &sink,
                            &playback_session,
                            &db,
                            &mut position_offset_ms,
                            &mut current_position_reports_relative,
                            &mut active_play,
                            awaiting_source,
                            PlayEndReason::SkippedNext,
                        );
                        awaiting_source = false;
                        desired_playing = false;
                        playback_kind = PlaybackKind::Idle;
                        let mut s = state.lock();
                        *s = PlaybackState::default();
                        s.volume = sink.volume();
                        let state_clone = s.clone();
                        drop(s);
                        let _ = event_tx.send(AudioEvent::StateChanged(state_clone));
                    }
                }
                Ok(AudioCommand::Prev) => {
                    // If we're more than 3 seconds in, restart current track
                    let pos = Self::playback_position_ms(
                        &sink,
                        position_offset_ms,
                        current_position_reports_relative,
                        awaiting_source,
                    );
                    let mut changed_track = false;
                    if pos > 3000 {
                        // Restart current track
                        if let Some(entry) = queue.current() {
                            changed_track = true;
                            if let Err(err) = Self::play_queue_entry(
                                &sink,
                                &tap_tx,
                                entry,
                                &cmd_tx,
                                &event_tx,
                                &state,
                                &db,
                                &playback_session,
                                &mut position_offset_ms,
                                &mut current_position_reports_relative,
                                &mut active_play,
                                &mut playback_kind,
                                &mut awaiting_source,
                                &mut desired_playing,
                                PlayEndReason::Restarted,
                            ) {
                                let _ = event_tx.send(AudioEvent::Error(err));
                            }
                        }
                    } else if let Some(entry) = queue.prev().cloned() {
                        changed_track = true;
                        Self::sync_queue_state(&queue, &queue_snapshot);
                        if let Err(err) = Self::play_queue_entry(
                            &sink,
                            &tap_tx,
                            &entry,
                            &cmd_tx,
                            &event_tx,
                            &state,
                            &db,
                            &playback_session,
                            &mut position_offset_ms,
                            &mut current_position_reports_relative,
                            &mut active_play,
                            &mut playback_kind,
                            &mut awaiting_source,
                            &mut desired_playing,
                            PlayEndReason::SkippedPrevious,
                        ) {
                            let _ = event_tx.send(AudioEvent::Error(err));
                        }
                    }
                    if !changed_track {
                        let end_reason = if pos > 3000 {
                            PlayEndReason::Restarted
                        } else {
                            PlayEndReason::SkippedPrevious
                        };
                        Self::reset_playback_session(
                            &sink,
                            &playback_session,
                            &db,
                            &mut position_offset_ms,
                            &mut current_position_reports_relative,
                            &mut active_play,
                            awaiting_source,
                            end_reason,
                        );
                        awaiting_source = false;
                        desired_playing = false;
                        playback_kind = PlaybackKind::Idle;
                        let mut s = state.lock();
                        *s = PlaybackState::default();
                        s.volume = sink.volume();
                        let state_clone = s.clone();
                        drop(s);
                        let _ = event_tx.send(AudioEvent::StateChanged(state_clone));
                    }
                }
                Ok(AudioCommand::SetShuffle(val)) => {
                    queue.set_shuffle(val);
                    Self::sync_queue_state(&queue, &queue_snapshot);
                    let mut s = state.lock();
                    s.is_shuffle = val;
                    let state_clone = s.clone();
                    drop(s);
                    let _ = event_tx.send(AudioEvent::StateChanged(state_clone));
                }
                Ok(AudioCommand::SetRepeat(mode)) => {
                    let mode_str = match &mode {
                        RepeatMode::Off => "off",
                        RepeatMode::One => "one",
                        RepeatMode::All => "all",
                    };
                    queue.set_repeat(mode);
                    let mut s = state.lock();
                    s.repeat_mode = mode_str.to_string();
                    let state_clone = s.clone();
                    drop(s);
                    let _ = event_tx.send(AudioEvent::StateChanged(state_clone));
                }
                Ok(AudioCommand::AddToQueue(entry)) => {
                    queue.add(entry);
                    Self::sync_queue_state(&queue, &queue_snapshot);
                }
                Ok(AudioCommand::InsertNext(entry)) => {
                    queue.insert_next(entry);
                    Self::sync_queue_state(&queue, &queue_snapshot);
                }
                Ok(AudioCommand::AppendContextIfSession {
                    session_id,
                    entries,
                }) => {
                    if queue.append_context_if_session(&session_id, entries) {
                        Self::sync_queue_state(&queue, &queue_snapshot);
                    }
                }
                Ok(AudioCommand::PlayQueueIndex(idx)) => {
                    if queue.set_index(idx) {
                        Self::sync_queue_state(&queue, &queue_snapshot);
                        let entry = queue.current().cloned();
                        if let Some(entry) = entry {
                            if let Err(err) = Self::play_queue_entry(
                                &sink,
                                &tap_tx,
                                &entry,
                                &cmd_tx,
                                &event_tx,
                                &state,
                                &db,
                                &playback_session,
                                &mut position_offset_ms,
                                &mut current_position_reports_relative,
                                &mut active_play,
                                &mut playback_kind,
                                &mut awaiting_source,
                                &mut desired_playing,
                                PlayEndReason::QueueChanged,
                            ) {
                                let _ = event_tx.send(AudioEvent::Error(err));
                            }
                        }
                    }
                }
                Ok(AudioCommand::PlayQueueEntry {
                    session_id,
                    entry_id,
                }) => {
                    if queue.select_entry(&session_id, &entry_id) {
                        Self::sync_queue_state(&queue, &queue_snapshot);
                        let entry = queue.current().cloned();
                        if let Some(entry) = entry {
                            if let Err(err) = Self::play_queue_entry(
                                &sink,
                                &tap_tx,
                                &entry,
                                &cmd_tx,
                                &event_tx,
                                &state,
                                &db,
                                &playback_session,
                                &mut position_offset_ms,
                                &mut current_position_reports_relative,
                                &mut active_play,
                                &mut playback_kind,
                                &mut awaiting_source,
                                &mut desired_playing,
                                PlayEndReason::QueueChanged,
                            ) {
                                let _ = event_tx.send(AudioEvent::Error(err));
                            }
                        }
                    }
                }
                Ok(AudioCommand::RemoveFromQueue(idx)) => {
                    if queue.remove(idx) {
                        Self::sync_queue_state(&queue, &queue_snapshot);
                    }
                }
                Ok(AudioCommand::RemoveQueueEntry {
                    session_id,
                    entry_id,
                }) => {
                    if queue.remove_entry(&session_id, &entry_id) {
                        Self::sync_queue_state(&queue, &queue_snapshot);
                    }
                }
                Ok(AudioCommand::ClearQueue) => {
                    queue.clear_upcoming();
                    Self::sync_queue_state(&queue, &queue_snapshot);
                }
                Ok(AudioCommand::SetQueue(tracks, start)) => {
                    queue.set_tracks(tracks, start);
                    Self::sync_queue_state(&queue, &queue_snapshot);
                    // Start playing from start index
                    if let Some(entry) = queue.current().cloned() {
                        if let Err(err) = Self::play_queue_entry(
                            &sink,
                            &tap_tx,
                            &entry,
                            &cmd_tx,
                            &event_tx,
                            &state,
                            &db,
                            &playback_session,
                            &mut position_offset_ms,
                            &mut current_position_reports_relative,
                            &mut active_play,
                            &mut playback_kind,
                            &mut awaiting_source,
                            &mut desired_playing,
                            PlayEndReason::QueueChanged,
                        ) {
                            let _ = event_tx.send(AudioEvent::Error(err));
                        }
                    } else {
                        Self::reset_playback_session(
                            &sink,
                            &playback_session,
                            &db,
                            &mut position_offset_ms,
                            &mut current_position_reports_relative,
                            &mut active_play,
                            awaiting_source,
                            PlayEndReason::QueueChanged,
                        );
                        awaiting_source = false;
                        desired_playing = false;
                        playback_kind = PlaybackKind::Idle;
                        let mut s = state.lock();
                        *s = PlaybackState::default();
                        s.volume = sink.volume();
                        let state_clone = s.clone();
                        drop(s);
                        let _ = event_tx.send(AudioEvent::StateChanged(state_clone));
                    }
                }
                Ok(AudioCommand::StartQueue {
                    session_id,
                    tracks,
                    start_index,
                }) => {
                    queue.set_tracks_with_session(session_id, tracks, start_index);
                    Self::sync_queue_state(&queue, &queue_snapshot);
                    if let Some(entry) = queue.current().cloned() {
                        if let Err(err) = Self::play_queue_entry(
                            &sink,
                            &tap_tx,
                            &entry,
                            &cmd_tx,
                            &event_tx,
                            &state,
                            &db,
                            &playback_session,
                            &mut position_offset_ms,
                            &mut current_position_reports_relative,
                            &mut active_play,
                            &mut playback_kind,
                            &mut awaiting_source,
                            &mut desired_playing,
                            PlayEndReason::QueueChanged,
                        ) {
                            let _ = event_tx.send(AudioEvent::Error(err));
                        }
                    } else {
                        Self::reset_playback_session(
                            &sink,
                            &playback_session,
                            &db,
                            &mut position_offset_ms,
                            &mut current_position_reports_relative,
                            &mut active_play,
                            awaiting_source,
                            PlayEndReason::QueueChanged,
                        );
                        awaiting_source = false;
                        desired_playing = false;
                        playback_kind = PlaybackKind::Idle;
                        let mut s = state.lock();
                        *s = PlaybackState::default();
                        s.volume = sink.volume();
                        let state_clone = s.clone();
                        drop(s);
                        let _ = event_tx.send(AudioEvent::StateChanged(state_clone));
                    }
                }
                Ok(AudioCommand::GetState) => {
                    let s = state.lock().clone();
                    let _ = event_tx.send(AudioEvent::StateChanged(s));
                }
                Ok(AudioCommand::Shutdown) => {
                    Self::reset_playback_session(
                        &sink,
                        &playback_session,
                        &db,
                        &mut position_offset_ms,
                        &mut current_position_reports_relative,
                        &mut active_play,
                        awaiting_source,
                        PlayEndReason::Shutdown,
                    );
                    break;
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
            }

            // Update position periodically
            // 100ms keeps the shared state fresh enough that the frontend's own
            // 250ms poll never sees a position more than ~350ms stale; at 250ms
            // the two cadences stacked to ~500ms of disagreement after a seek.
            if last_position_update.elapsed() >= Duration::from_millis(100) {
                let is_active = {
                    let state_guard = state.lock();
                    state_guard.is_playing || state_guard.is_buffering
                };
                if is_active {
                    let pos = Self::playback_position_ms(
                        &sink,
                        position_offset_ms,
                        current_position_reports_relative,
                        awaiting_source,
                    );
                    let mut s = state.lock();
                    s.position_ms = pos;

                    // Check if track ended
                    if playback_kind == PlaybackKind::Queue
                        && !awaiting_source
                        && sink.empty()
                        && s.is_playing
                    {
                        desired_playing = false;
                        s.is_playing = false;
                        s.is_buffering = false;
                        drop(s);
                        let _ = event_tx.send(AudioEvent::TrackEnded);

                        let end_reason = Self::source_exhaustion_reason(
                            pos,
                            active_play.as_ref().and_then(|play| play.duration_ms),
                        );
                        Self::finalize_active_play(&db, &mut active_play, end_reason);

                        // Repeat One belongs only to a genuine natural ending.
                        // A truncated source advances so a broken URL cannot
                        // trap playback in an infinite retry loop.
                        if let Some(entry) = queue
                            .advance_after_completion(end_reason == PlayEndReason::NaturalEnd)
                            .cloned()
                        {
                            Self::sync_queue_state(&queue, &queue_snapshot);
                            if let Err(err) = Self::play_queue_entry(
                                &sink,
                                &tap_tx,
                                &entry,
                                &cmd_tx,
                                &event_tx,
                                &state,
                                &db,
                                &playback_session,
                                &mut position_offset_ms,
                                &mut current_position_reports_relative,
                                &mut active_play,
                                &mut playback_kind,
                                &mut awaiting_source,
                                &mut desired_playing,
                                PlayEndReason::QueueChanged,
                            ) {
                                let _ = event_tx.send(AudioEvent::Error(err));
                            }
                        } else {
                            playback_kind = PlaybackKind::Idle;
                        }
                    } else if playback_kind == PlaybackKind::Radio
                        && !awaiting_source
                        && sink.empty()
                        && s.is_playing
                    {
                        desired_playing = false;
                        s.is_playing = false;
                        s.is_buffering = false;
                        let state_clone = s.clone();
                        drop(s);

                        Self::finalize_active_play(
                            &db,
                            &mut active_play,
                            PlayEndReason::StreamEnded,
                        );

                        playback_kind = PlaybackKind::Idle;
                        let _ = event_tx.send(AudioEvent::StateChanged(state_clone));
                    }
                }
                last_position_update = Instant::now();
            }
        }
    }

    fn current_position_ms(sink: &Sink) -> u64 {
        sink.get_pos().as_millis() as u64
    }

    fn playback_position_ms(
        sink: &Sink,
        position_offset_ms: u64,
        position_reports_relative: bool,
        awaiting_source: bool,
    ) -> u64 {
        if awaiting_source {
            return position_offset_ms;
        }

        let pos = Self::current_position_ms(sink);
        if position_reports_relative {
            position_offset_ms.saturating_add(pos)
        } else {
            pos
        }
    }

    fn source_exhaustion_reason(position_ms: u64, duration_ms: Option<i64>) -> PlayEndReason {
        let Some(duration_ms) = duration_ms.filter(|duration| *duration > 0) else {
            // With no duration metadata, reaching the end of a healthy decoder
            // is the only evidence available and is treated as a natural end.
            return PlayEndReason::NaturalEnd;
        };
        let duration_ms = duration_ms as u64;
        let tolerance_ms = (duration_ms / 20).clamp(2_000, 10_000);
        if position_ms.saturating_add(tolerance_ms) >= duration_ms {
            PlayEndReason::NaturalEnd
        } else {
            PlayEndReason::StreamEnded
        }
    }

    fn error_session_is_current(playback_session: &AtomicU64, session_id: u64) -> bool {
        playback_session.load(Ordering::SeqCst) == session_id
    }

    fn reset_playback_session(
        sink: &Sink,
        playback_session: &Arc<AtomicU64>,
        db: &DbPool,
        position_offset_ms: &mut u64,
        current_position_reports_relative: &mut bool,
        active_play: &mut Option<ActivePlay>,
        _awaiting_source: bool,
        end_reason: PlayEndReason,
    ) -> u64 {
        if let Some(play) = active_play.as_mut() {
            play.set_listening(false);
        }
        let session_id = Self::reset_source_session(
            sink,
            playback_session,
            position_offset_ms,
            current_position_reports_relative,
        );
        Self::finalize_active_play(db, active_play, end_reason);
        session_id
    }

    fn reset_source_session(
        sink: &Sink,
        playback_session: &Arc<AtomicU64>,
        position_offset_ms: &mut u64,
        current_position_reports_relative: &mut bool,
    ) -> u64 {
        *position_offset_ms = 0;
        *current_position_reports_relative = false;
        sink.stop();
        playback_session.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn begin_active_play(
        db: &DbPool,
        recording_id: Option<&str>,
        source_used: Option<&str>,
        station_id: Option<&str>,
        duration_ms: Option<i64>,
        is_listening: bool,
    ) -> Option<ActivePlay> {
        match db::queries::record_play(db, recording_id, source_used, station_id, duration_ms) {
            Ok(id) => Some(ActivePlay::new(id, duration_ms, is_listening)),
            Err(err) => {
                log::warn!(
                    "Failed to start play history for {}: {}",
                    recording_id.or(station_id).unwrap_or("unknown item"),
                    err
                );
                None
            }
        }
    }

    fn finalize_active_play(
        db: &DbPool,
        active_play: &mut Option<ActivePlay>,
        end_reason: PlayEndReason,
    ) {
        let Some(play) = active_play.take() else {
            return;
        };
        let (play_id, listened_ms, duration_ms) = play.finish();
        if let Err(err) =
            db::queries::finalize_play(db, &play_id, listened_ms, duration_ms, end_reason.as_str())
        {
            log::warn!("Failed to finalize play history {}: {}", play_id, err);
        }
    }

    fn sync_queue_state(queue: &PlayQueue, snapshot: &Arc<Mutex<QueueSnapshot>>) {
        let now_playing = queue
            .current_occurrence()
            .map(|(entry_id, entry)| QueueItem {
                entry_id: entry_id.to_string(),
                index: 0,
                recording_id: entry.recording_id.clone(),
                title: entry.title.clone(),
                artist_name: entry.artist.clone(),
                duration_ms: entry.duration_ms,
                cover_art_url: entry.cover_art.clone(),
                is_current: true,
            });
        let upcoming = queue
            .upcoming_occurrences()
            .enumerate()
            .map(|(index, (entry_id, entry))| QueueItem {
                entry_id: entry_id.to_string(),
                index,
                recording_id: entry.recording_id.clone(),
                title: entry.title.clone(),
                artist_name: entry.artist.clone(),
                duration_ms: entry.duration_ms,
                cover_art_url: entry.cover_art.clone(),
                is_current: false,
            })
            .collect();

        *snapshot.lock() = QueueSnapshot {
            session_id: queue.session_id().to_string(),
            revision: queue.revision(),
            now_playing,
            upcoming,
        };
    }
}

impl Drop for AudioEngine {
    fn drop(&mut self) {
        self.shutdown();
    }
}
