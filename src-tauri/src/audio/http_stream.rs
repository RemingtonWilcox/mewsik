use crate::audio::engine::AudioEvent;
use crate::config::AppConfig;
use crate::external_tools::{find_binary, format_ffmpeg_headers};
use crossbeam_channel::Sender;
use parking_lot::{Condvar, Mutex};
use rodio::{Decoder, Source};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use ulid::Ulid;

const GOOGLEVIDEO_RANGE_CHUNK_BYTES: u64 = 1024 * 1024;

#[derive(Default)]
struct FfmpegTracker {
    quiescing: bool,
    next_id: u64,
    children: HashMap<u64, Arc<Mutex<Child>>>,
}

static FFMPEG_TRACKER: OnceLock<Mutex<FfmpegTracker>> = OnceLock::new();

fn ffmpeg_tracker() -> &'static Mutex<FfmpegTracker> {
    FFMPEG_TRACKER.get_or_init(|| Mutex::new(FfmpegTracker::default()))
}

struct TrackedFfmpeg {
    id: u64,
}

impl Drop for TrackedFfmpeg {
    fn drop(&mut self) {
        ffmpeg_tracker().lock().children.remove(&self.id);
    }
}

fn spawn_tracked_ffmpeg(
    command: &mut Command,
) -> Result<(Arc<Mutex<Child>>, TrackedFfmpeg), String> {
    // Hold the same lock used by quiesce across spawn + registration. That
    // makes it impossible for updater shutdown to miss a just-created child.
    let mut tracker = ffmpeg_tracker().lock();
    if tracker.quiescing {
        return Err("Audio transcoding is shutting down for app exit".to_string());
    }
    let child = command
        .spawn()
        .map_err(|error| format!("Failed to start ffmpeg: {error}"))?;
    tracker.next_id = tracker.next_id.saturating_add(1);
    let id = tracker.next_id;
    let child = Arc::new(Mutex::new(child));
    tracker.children.insert(id, Arc::clone(&child));
    Ok((child, TrackedFfmpeg { id }))
}

fn stop_ffmpeg_child(child: &Arc<Mutex<Child>>) {
    let mut child = child.lock();
    match child.try_wait() {
        Ok(Some(_)) => {}
        Ok(None) | Err(_) => {
            let _ = child.kill();
        }
    }
    let _ = child.wait();
}

/// Permanently prevents new transcoders in this process, then kills and waits
/// for every active ffmpeg child. This is intentionally terminal-only: updater
/// installation can bypass Tauri's normal managed-state teardown on Windows.
pub fn quiesce_and_stop_ffmpeg() {
    let children = {
        let mut tracker = ffmpeg_tracker().lock();
        tracker.quiescing = true;
        tracker.children.values().cloned().collect::<Vec<_>>()
    };
    for child in children {
        stop_ffmpeg_child(&child);
    }
}

struct BufferedFileState {
    available_bytes: u64,
    finished: bool,
    cancelled: bool,
    error: Option<String>,
}

struct SharedBufferedFile {
    file: Mutex<File>,
    state: Mutex<BufferedFileState>,
    condvar: Condvar,
}

impl SharedBufferedFile {
    fn new(file: File) -> Self {
        Self {
            file: Mutex::new(file),
            state: Mutex::new(BufferedFileState {
                available_bytes: 0,
                finished: false,
                cancelled: false,
                error: None,
            }),
            condvar: Condvar::new(),
        }
    }

    fn append_bytes(&self, bytes_written: u64) {
        let mut state = self.state.lock();
        state.available_bytes += bytes_written;
        self.condvar.notify_all();
    }

    fn finish(&self) {
        let mut state = self.state.lock();
        state.finished = true;
        self.condvar.notify_all();
    }

    fn cancel(&self) {
        let mut state = self.state.lock();
        state.cancelled = true;
        state.finished = true;
        self.condvar.notify_all();
    }

    fn fail(&self, message: String) {
        let mut state = self.state.lock();
        state.error = Some(message);
        state.finished = true;
        self.condvar.notify_all();
    }

    fn is_finished(&self) -> bool {
        self.state.lock().finished
    }

    fn wait_for_bytes(&self, target_bytes: u64, timeout: Duration) -> Result<u64, String> {
        let start = Instant::now();
        let mut state = self.state.lock();
        loop {
            if state.available_bytes >= target_bytes || state.finished {
                return Ok(state.available_bytes);
            }
            if state.cancelled {
                return Err("Stream preparation cancelled".to_string());
            }
            if let Some(err) = state.error.clone() {
                return Err(err);
            }
            let elapsed = start.elapsed();
            if elapsed >= timeout {
                return Err("Timed out waiting for audio data".to_string());
            }
            self.condvar.wait_for(&mut state, timeout - elapsed);
        }
    }
}

struct BufferedStreamReader {
    shared: Arc<SharedBufferedFile>,
    position: u64,
}

impl BufferedStreamReader {
    fn new(shared: Arc<SharedBufferedFile>) -> Self {
        Self {
            shared,
            position: 0,
        }
    }
}

impl Read for BufferedStreamReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut state = self.shared.state.lock();

        loop {
            if self.position < state.available_bytes {
                let max_bytes = (state.available_bytes - self.position) as usize;
                let bytes_to_read = max_bytes.min(buf.len());
                drop(state);

                let mut file = self.shared.file.lock();
                file.seek(SeekFrom::Start(self.position))?;
                let bytes_read = file.read(&mut buf[..bytes_to_read])?;
                self.position += bytes_read as u64;
                return Ok(bytes_read);
            }

            if state.finished || state.cancelled {
                return Ok(0);
            }

            if let Some(err) = state.error.clone() {
                return Err(io::Error::new(io::ErrorKind::Other, err));
            }

            self.shared.condvar.wait(&mut state);
        }
    }
}

impl Seek for BufferedStreamReader {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let mut state = self.shared.state.lock();

        loop {
            let available = state.available_bytes as i128;
            let current = self.position as i128;

            let target = match pos {
                SeekFrom::Start(offset) => offset as i128,
                SeekFrom::Current(offset) => current + offset as i128,
                SeekFrom::End(offset) => available + offset as i128,
            };

            if target < 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Cannot seek before start of stream",
                ));
            }

            let target = target as u64;
            if target <= state.available_bytes || state.finished || state.cancelled {
                self.position = target.min(state.available_bytes);
                return Ok(self.position);
            }

            if let Some(err) = state.error.clone() {
                return Err(io::Error::new(io::ErrorKind::Other, err));
            }

            self.shared.condvar.wait(&mut state);
        }
    }
}

fn create_unlinked_stream_file() -> Result<(File, File), String> {
    let cache_dir = AppConfig::data_dir().join("stream-cache");
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create stream cache: {}", e))?;

    let path = cache_dir.join(format!("{}.audio", Ulid::new()));
    let writer = OpenOptions::new()
        .create(true)
        .truncate(true)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|e| format!("Failed to create stream buffer: {}", e))?;
    let reader = OpenOptions::new()
        .read(true)
        .open(&path)
        .map_err(|e| format!("Failed to open stream buffer: {}", e))?;

    let _ = std::fs::remove_file(&path);

    Ok((writer, reader))
}

fn should_use_ranged_fetch(url: &str) -> bool {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| {
            parsed
                .host_str()
                .map(|host| host.ends_with("googlevideo.com"))
        })
        .unwrap_or(false)
}

fn content_length_hint_from_url(url: &str) -> Option<u64> {
    reqwest::Url::parse(url).ok().and_then(|parsed| {
        parsed
            .query_pairs()
            .find(|(key, _)| key == "clen")
            .and_then(|(_, value)| value.parse::<u64>().ok())
    })
}

fn build_request(
    client: &reqwest::blocking::Client,
    url: &str,
    headers: &HashMap<String, String>,
    is_live: bool,
) -> reqwest::blocking::RequestBuilder {
    let mut request = client
        .get(url)
        .header("User-Agent", concat!("mewsik/", env!("CARGO_PKG_VERSION")));
    if is_live {
        request = request.header("Icy-MetaData", "0");
    }
    for (key, value) in headers {
        request = request.header(key, value);
    }
    request
}

fn open_http_response(
    client: &reqwest::blocking::Client,
    url: &str,
    headers: &HashMap<String, String>,
    is_live: bool,
    range: Option<(u64, u64)>,
) -> Result<reqwest::blocking::Response, String> {
    let mut request = build_request(client, url, headers, is_live);
    if let Some((start, end)) = range {
        request = request.header("Range", format!("bytes={start}-{end}"));
    }
    request
        .send()
        .and_then(|res| res.error_for_status())
        .map_err(|err| format!("Failed to open stream: {}", err))
}

fn spawn_download_worker(
    url: String,
    headers: HashMap<String, String>,
    mut writer: File,
    shared: Arc<SharedBufferedFile>,
    playback_session: Arc<AtomicU64>,
    session_id: u64,
    is_live: bool,
    event_tx: Sender<AudioEvent>,
    label: String,
) -> Result<(), String> {
    std::thread::Builder::new()
        .name(if is_live {
            "live-stream-download".to_string()
        } else {
            "http-stream-download".to_string()
        })
        .spawn(move || {
            use std::io::Read as _;

            let client = if is_live {
                None
            } else {
                match reqwest::blocking::Client::builder()
                    .connect_timeout(Duration::from_secs(10))
                    .timeout(Duration::from_secs(120))
                    .build()
                    .map_err(|err| format!("Failed to build streaming client: {err}"))
                {
                    Ok(client) => Some(client),
                    Err(err) => {
                        shared.fail(err.clone());
                        let _ = event_tx.send(AudioEvent::Error(format!(
                            "{} failed before playback: {}",
                            label, err
                        )));
                        return;
                    }
                }
            };

            let use_ranges = !is_live && should_use_ranged_fetch(&url);
            let total_hint = if use_ranges {
                content_length_hint_from_url(&url)
            } else {
                None
            };
            let mut next_offset = 0u64;
            let mut chunk = [0u8; 64 * 1024];

            'outer: loop {
                if playback_session.load(Ordering::SeqCst) != session_id {
                    shared.cancel();
                    break;
                }

                let range = if use_ranges {
                    let start = next_offset;
                    let end = total_hint
                        .map(|total| {
                            (start + GOOGLEVIDEO_RANGE_CHUNK_BYTES - 1).min(total.saturating_sub(1))
                        })
                        .unwrap_or(start + GOOGLEVIDEO_RANGE_CHUNK_BYTES - 1);
                    Some((start, end))
                } else {
                    None
                };

                let requested_bytes = range.map(|(start, end)| end.saturating_sub(start) + 1);
                let response_result = if is_live {
                    // Resolve, classify and pin every hop in the actual radio
                    // connection. Ordinary direct streams therefore do not
                    // need a separate throwaway content probe first.
                    crate::stations::network::open_blocking_public_stream(&url, &headers)
                } else {
                    open_http_response(
                        client.as_ref().expect("non-live client exists"),
                        &url,
                        &headers,
                        false,
                        range,
                    )
                };
                let mut response = match response_result {
                    Ok(response) => response,
                    Err(err) => {
                        shared.fail(err.clone());
                        let _ = event_tx.send(AudioEvent::Error(format!(
                            "{} connection failed: {}",
                            label, err
                        )));
                        return;
                    }
                };

                let mut bytes_read_this_request = 0u64;
                loop {
                    if playback_session.load(Ordering::SeqCst) != session_id {
                        shared.cancel();
                        break 'outer;
                    }

                    match response.read(&mut chunk) {
                        Ok(0) => {
                            if !use_ranges {
                                shared.finish();
                                break 'outer;
                            }
                            break;
                        }
                        Ok(bytes_read) => {
                            if let Err(err) = writer.write_all(&chunk[..bytes_read]) {
                                let message = format!("Failed to write buffered stream: {}", err);
                                shared.fail(message.clone());
                                let _ = event_tx.send(AudioEvent::Error(format!(
                                    "{} write failed: {}",
                                    label, err
                                )));
                                break 'outer;
                            }
                            shared.append_bytes(bytes_read as u64);
                            bytes_read_this_request += bytes_read as u64;
                            next_offset += bytes_read as u64;
                        }
                        Err(err) => {
                            let message = format!("Stream read failed: {}", err);
                            shared.fail(message.clone());
                            let _ = event_tx
                                .send(AudioEvent::Error(format!("{} read failed: {}", label, err)));
                            break 'outer;
                        }
                    }
                }

                if !use_ranges {
                    shared.finish();
                    break;
                }

                if bytes_read_this_request == 0 {
                    shared.finish();
                    break;
                }

                if let Some(total) = total_hint {
                    if next_offset >= total {
                        shared.finish();
                        break;
                    }
                }

                if let Some(expected) = requested_bytes {
                    if bytes_read_this_request < expected {
                        shared.finish();
                        break;
                    }
                }
            }
        })
        .map_err(|e| format!("Failed to spawn stream worker: {}", e))?;

    Ok(())
}

fn spawn_ffmpeg_transcode_worker(
    url: String,
    headers: HashMap<String, String>,
    seek_position_ms: Option<u64>,
    mut writer: File,
    shared: Arc<SharedBufferedFile>,
    playback_session: Arc<AtomicU64>,
    session_id: u64,
    event_tx: Sender<AudioEvent>,
    label: String,
) -> Result<(), String> {
    if ffmpeg_tracker().lock().quiescing {
        return Err("Audio transcoding is shutting down for app exit".to_string());
    }
    let ffmpeg = find_binary("ffmpeg").ok_or_else(|| {
        "ffmpeg is required for progressive YouTube playback but was not found".to_string()
    })?;

    std::thread::Builder::new()
        .name("ffmpeg-stream-transcode".to_string())
        .spawn(move || {
            let mut command = Command::new(ffmpeg);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                command.creation_flags(CREATE_NO_WINDOW);
            }
            command
                .arg("-hide_banner")
                .arg("-loglevel")
                .arg("error")
                .arg("-nostdin");

            if let Some(headers) = format_ffmpeg_headers(&headers) {
                command.arg("-headers").arg(headers);
            }

            if let Some(seek_ms) = seek_position_ms {
                command
                    .arg("-ss")
                    .arg(format!("{:.3}", seek_ms as f64 / 1000.0));
            }

            command
                .arg("-reconnect")
                .arg("1")
                .arg("-reconnect_streamed")
                .arg("1")
                .arg("-reconnect_delay_max")
                .arg("2")
                .arg("-i")
                .arg(&url)
                .arg("-vn")
                .arg("-codec:a")
                .arg("libmp3lame")
                .arg("-q:a")
                .arg("4")
                .arg("-f")
                .arg("mp3")
                .arg("pipe:1")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            let (child, _tracked_child) = match spawn_tracked_ffmpeg(&mut command) {
                Ok(tracked) => tracked,
                Err(err) => {
                    let message = err.to_string();
                    shared.fail(message.clone());
                    let _ = event_tx.send(AudioEvent::Error(format!(
                        "{} failed before playback: {}",
                        label, err
                    )));
                    return;
                }
            };

            let Some(mut stdout) = child.lock().stdout.take() else {
                stop_ffmpeg_child(&child);
                let message = "Failed to capture ffmpeg audio output".to_string();
                shared.fail(message.clone());
                let _ = event_tx.send(AudioEvent::Error(format!("{} failed: {}", label, message)));
                return;
            };

            let stderr_reader = child.lock().stderr.take().map(|mut stderr| {
                std::thread::spawn(move || {
                    let mut output = String::new();
                    let _ = stderr.read_to_string(&mut output);
                    output
                })
            });

            let mut chunk = [0u8; 64 * 1024];
            loop {
                if playback_session.load(Ordering::SeqCst) != session_id {
                    stop_ffmpeg_child(&child);
                    shared.cancel();
                    return;
                }

                match stdout.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(bytes_read) => {
                        if let Err(err) = writer.write_all(&chunk[..bytes_read]) {
                            stop_ffmpeg_child(&child);
                            let message = format!("Failed to write ffmpeg stream buffer: {}", err);
                            shared.fail(message.clone());
                            let _ = event_tx
                                .send(AudioEvent::Error(format!("{} failed: {}", label, message)));
                            return;
                        }
                        shared.append_bytes(bytes_read as u64);
                    }
                    Err(err) => {
                        stop_ffmpeg_child(&child);
                        let message = format!("Failed to read ffmpeg audio output: {}", err);
                        shared.fail(message.clone());
                        let _ = event_tx
                            .send(AudioEvent::Error(format!("{} failed: {}", label, message)));
                        return;
                    }
                }
            }

            let status = child.lock().wait();
            let stderr_output = stderr_reader
                .and_then(|handle| handle.join().ok())
                .unwrap_or_default();

            if playback_session.load(Ordering::SeqCst) != session_id {
                shared.cancel();
                return;
            }

            match status {
                Ok(status) if status.success() => shared.finish(),
                Ok(_) => {
                    let details = stderr_output.trim();
                    let message = if details.is_empty() {
                        "ffmpeg exited before producing a complete audio stream".to_string()
                    } else {
                        format!("ffmpeg failed to transcode the stream: {}", details)
                    };
                    shared.fail(message.clone());
                    let _ =
                        event_tx.send(AudioEvent::Error(format!("{} failed: {}", label, message)));
                }
                Err(err) => {
                    let message = format!("Failed to wait for ffmpeg: {}", err);
                    shared.fail(message.clone());
                    let _ =
                        event_tx.send(AudioEvent::Error(format!("{} failed: {}", label, message)));
                }
            }
        })
        .map_err(|e| format!("Failed to spawn ffmpeg stream worker: {}", e))?;

    Ok(())
}

pub fn fetch_http_audio_bytes(
    url: &str,
    headers: &HashMap<String, String>,
) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    if !should_use_ranged_fetch(url) {
        let response = open_http_response(&client, url, headers, false, None)?;
        return response
            .bytes()
            .map(|bytes| bytes.to_vec())
            .map_err(|e| format!("Failed to read remote audio: {}", e));
    }

    let mut bytes = Vec::new();
    let total_hint = content_length_hint_from_url(url);
    let mut next_offset = 0u64;

    loop {
        let start = next_offset;
        let end = total_hint
            .map(|total| (start + GOOGLEVIDEO_RANGE_CHUNK_BYTES - 1).min(total.saturating_sub(1)))
            .unwrap_or(start + GOOGLEVIDEO_RANGE_CHUNK_BYTES - 1);
        let expected = end.saturating_sub(start) + 1;
        let response = open_http_response(&client, url, headers, false, Some((start, end)))?;
        let chunk = response
            .bytes()
            .map_err(|e| format!("Failed to read remote audio: {}", e))?;

        if chunk.is_empty() {
            break;
        }

        next_offset += chunk.len() as u64;
        bytes.extend_from_slice(&chunk);

        if let Some(total) = total_hint {
            if next_offset >= total {
                break;
            }
        }

        if (chunk.len() as u64) < expected {
            break;
        }
    }

    Ok(bytes)
}

fn prepare_buffered_decoder(
    shared: Arc<SharedBufferedFile>,
    initial_buffer_bytes: usize,
    is_live: bool,
) -> Result<Box<dyn Source<Item = i16> + Send>, String> {
    let minimum_threshold = if is_live { 16 * 1024 } else { 64 * 1024 };
    let base_threshold = initial_buffer_bytes.max(minimum_threshold);
    let mut thresholds = if is_live {
        vec![
            minimum_threshold,
            (base_threshold / 2).max(minimum_threshold),
            base_threshold,
        ]
    } else {
        vec![
            (base_threshold / 2).max(minimum_threshold),
            base_threshold,
            (base_threshold * 3 / 2).max(base_threshold),
        ]
    };
    thresholds.sort_unstable();
    thresholds.dedup();
    let startup_deadline = Instant::now()
        + if is_live {
            Duration::from_secs(10)
        } else {
            Duration::from_secs(15)
        };

    let mut last_error = None;
    for threshold in thresholds {
        let remaining = startup_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }

        let available = shared.wait_for_bytes(threshold as u64, remaining)?;
        if available == 0 && shared.is_finished() {
            break;
        }

        let reader = BufferedStreamReader::new(Arc::clone(&shared));
        match Decoder::new(BufReader::new(reader)) {
            Ok(decoder) => return Ok(Box::new(decoder)),
            Err(err) => {
                last_error = Some(err.to_string());
                if shared.is_finished() {
                    break;
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "Timed out preparing audio stream".to_string()))
}

pub fn prepare_http_audio_source(
    url: String,
    headers: HashMap<String, String>,
    playback_session: Arc<AtomicU64>,
    session_id: u64,
    initial_buffer_bytes: usize,
    is_live: bool,
    event_tx: Sender<AudioEvent>,
    label: String,
) -> Result<Box<dyn Source<Item = i16> + Send>, String> {
    let (writer, reader) = create_unlinked_stream_file()?;
    let shared = Arc::new(SharedBufferedFile::new(reader));

    spawn_download_worker(
        url,
        headers,
        writer,
        Arc::clone(&shared),
        playback_session,
        session_id,
        is_live,
        event_tx,
        label,
    )?;

    prepare_buffered_decoder(shared, initial_buffer_bytes, is_live)
}

pub fn prepare_ffmpeg_audio_source(
    url: String,
    headers: HashMap<String, String>,
    seek_position_ms: Option<u64>,
    playback_session: Arc<AtomicU64>,
    session_id: u64,
    initial_buffer_bytes: usize,
    event_tx: Sender<AudioEvent>,
    label: String,
) -> Result<Box<dyn Source<Item = i16> + Send>, String> {
    let (writer, reader) = create_unlinked_stream_file()?;
    let shared = Arc::new(SharedBufferedFile::new(reader));

    spawn_ffmpeg_transcode_worker(
        url,
        headers,
        seek_position_ms,
        writer,
        Arc::clone(&shared),
        playback_session,
        session_id,
        event_tx,
        label,
    )?;

    prepare_buffered_decoder(shared, initial_buffer_bytes, false)
}
