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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    /// When the response headers arrived (the connection is established).
    connected_at: Option<Instant>,
    /// When the first body bytes landed in the buffer.
    first_bytes_at: Option<Instant>,
    /// Bitrate the server advertised in its ICY / Icecast headers.
    advertised_kbps: Option<u32>,
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
                connected_at: None,
                first_bytes_at: None,
                advertised_kbps: None,
            }),
            condvar: Condvar::new(),
        }
    }

    fn append_bytes(&self, bytes_written: u64) {
        let mut state = self.state.lock();
        if state.first_bytes_at.is_none() && bytes_written > 0 {
            state.first_bytes_at = Some(Instant::now());
        }
        state.available_bytes += bytes_written;
        self.condvar.notify_all();
    }

    fn mark_connected(&self, advertised_kbps: Option<u32>) {
        let mut state = self.state.lock();
        if state.connected_at.is_none() {
            state.connected_at = Some(Instant::now());
        }
        state.advertised_kbps = advertised_kbps;
        self.condvar.notify_all();
    }

    /// Blocks until the response headers arrived, the stream ended, or the
    /// timeout passed. Returns the advertised bitrate, if any.
    fn wait_for_connection(&self, timeout: Duration) -> Result<Option<u32>, String> {
        let start = Instant::now();
        let mut state = self.state.lock();
        loop {
            if state.connected_at.is_some() || state.available_bytes > 0 {
                return Ok(state.advertised_kbps);
            }
            if state.cancelled {
                return Err("Stream preparation cancelled".to_string());
            }
            if let Some(err) = state.error.clone() {
                return Err(err);
            }
            if state.finished {
                return Ok(state.advertised_kbps);
            }
            let elapsed = start.elapsed();
            if elapsed >= timeout {
                return Err("Timed out connecting to the stream".to_string());
            }
            self.condvar.wait_for(&mut state, timeout - elapsed);
        }
    }

    /// Up to `max_len` bytes from the start of the buffer.
    fn peek_prefix(&self, max_len: usize) -> io::Result<Vec<u8>> {
        let available = self.state.lock().available_bytes;
        let len = available.min(max_len as u64) as usize;
        let mut prefix = vec![0; len];
        let mut file = self.file.lock();
        file.seek(SeekFrom::Start(0))?;
        file.read_exact(&mut prefix)?;
        Ok(prefix)
    }

    fn timeline(&self) -> (Option<Instant>, Option<Instant>) {
        let state = self.state.lock();
        (state.connected_at, state.first_bytes_at)
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

/// Bounds the format probe on a live stream. symphonia scans up to 1 MiB for
/// a format marker and this reader blocks until bytes arrive, so a stream the
/// probe does not recognise would otherwise stall startup for minutes (1 MiB
/// of a 64 kbps stream is over two minutes of real time). While active, reads
/// stop at `max_bytes` (reported as end of stream) and waiting past
/// `deadline` fails. Released once the decoder exists.
struct ProbeLimit {
    active: AtomicBool,
    max_bytes: u64,
    deadline: Instant,
}

impl ProbeLimit {
    fn new(max_bytes: u64, deadline: Instant) -> Self {
        Self {
            active: AtomicBool::new(true),
            max_bytes,
            deadline,
        }
    }

    fn release(&self) {
        self.active.store(false, Ordering::SeqCst);
    }

    fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }
}

struct BufferedStreamReader {
    shared: Arc<SharedBufferedFile>,
    position: u64,
    probe_limit: Option<Arc<ProbeLimit>>,
}

impl BufferedStreamReader {
    fn new(shared: Arc<SharedBufferedFile>) -> Self {
        Self {
            shared,
            position: 0,
            probe_limit: None,
        }
    }

    fn with_probe_limit(shared: Arc<SharedBufferedFile>, limit: Arc<ProbeLimit>) -> Self {
        Self {
            shared,
            position: 0,
            probe_limit: Some(limit),
        }
    }

    fn active_probe_limit(&self) -> Option<&ProbeLimit> {
        self.probe_limit
            .as_deref()
            .filter(|limit| limit.is_active())
    }
}

impl Read for BufferedStreamReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut state = self.shared.state.lock();

        loop {
            let probe_cap = self.active_probe_limit().map(|limit| limit.max_bytes);
            if probe_cap.is_some_and(|cap| self.position >= cap) {
                return Ok(0);
            }
            if self.position < state.available_bytes {
                let mut max_bytes = (state.available_bytes - self.position) as usize;
                if let Some(cap) = probe_cap {
                    max_bytes = max_bytes.min((cap - self.position) as usize);
                }
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

            match self.active_probe_limit().map(|limit| limit.deadline) {
                Some(deadline) => {
                    if Instant::now() >= deadline {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "Timed out recognising the stream format",
                        ));
                    }
                    self.shared.condvar.wait_until(&mut state, deadline);
                }
                None => self.shared.condvar.wait(&mut state),
            }
        }
    }
}

/// Total length of the ADTS frame whose header starts `header`, if it is one.
fn adts_frame_len(header: &[u8]) -> Option<usize> {
    if header.len() < 7 || header[0] != 0xFF || header[1] & 0xF6 != 0xF0 {
        return None;
    }
    let len = (usize::from(header[3] & 0x03) << 11)
        | (usize::from(header[4]) << 3)
        | (usize::from(header[5]) >> 5);
    (len >= 7).then_some(len)
}

/// Where the first MPEG-2 ADTS frame (sync `FF F9`) starts, if the stream is
/// MPEG-2 ADTS. A candidate only counts when its length lands on another
/// ADTS header, so a stray `FF F9` in other data is not mistaken for one.
fn find_mpeg2_adts_start(prefix: &[u8]) -> Option<usize> {
    (0..prefix.len().saturating_sub(7)).find(|&at| {
        if prefix[at] != 0xFF || prefix[at + 1] != 0xF9 {
            return false;
        }
        let Some(len) = adts_frame_len(&prefix[at..]) else {
            return false;
        };
        prefix.get(at + len..).and_then(adts_frame_len).is_some()
    })
}

/// symphonia 0.5 only recognises MPEG-4 ADTS frames (sync `FF F1`). Many AAC
/// radio streams send MPEG-2 ADTS (`FF F9`), identical apart from the ID
/// bit, so the probe never finds a marker and the station never starts. This
/// reader walks the ADTS frames and rewrites only that header byte, leaving
/// the audio payload untouched. Any surprise (lost sync, a seek) switches it
/// to plain pass-through.
struct AdtsMpeg2Patch<R> {
    inner: R,
    header: [u8; 7],
    header_len: usize,
    header_pos: usize,
    /// Bytes to pass through before the next frame header.
    remaining: u64,
    passthrough: bool,
}

impl<R: Read> AdtsMpeg2Patch<R> {
    fn new(inner: R, first_frame_at: usize) -> Self {
        Self {
            inner,
            header: [0; 7],
            header_len: 0,
            header_pos: 0,
            remaining: first_frame_at as u64,
            passthrough: false,
        }
    }

    fn read_header(&mut self) -> io::Result<()> {
        let mut filled = 0;
        while filled < self.header.len() {
            match self.inner.read(&mut self.header[filled..]) {
                Ok(0) => break,
                Ok(read) => filled += read,
                Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
                Err(err) => return Err(err),
            }
        }
        self.header_len = filled;
        self.header_pos = 0;
        match adts_frame_len(&self.header[..filled]) {
            Some(len) => {
                if self.header[1] == 0xF9 {
                    self.header[1] = 0xF1;
                }
                self.remaining = (len - self.header.len()) as u64;
            }
            None => self.passthrough = true,
        }
        Ok(())
    }
}

impl<R: Read> Read for AdtsMpeg2Patch<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if self.header_pos < self.header_len {
            let count = (self.header_len - self.header_pos).min(buf.len());
            buf[..count].copy_from_slice(&self.header[self.header_pos..self.header_pos + count]);
            self.header_pos += count;
            return Ok(count);
        }
        if self.passthrough {
            return self.inner.read(buf);
        }
        if self.remaining > 0 {
            let limit = buf
                .len()
                .min(self.remaining.min(usize::MAX as u64) as usize);
            let read = self.inner.read(&mut buf[..limit])?;
            self.remaining -= read as u64;
            return Ok(read);
        }
        self.read_header()?;
        if self.header_len == 0 {
            return Ok(0);
        }
        self.read(buf)
    }
}

impl<R: Read + Seek> Seek for AdtsMpeg2Patch<R> {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let pending = (self.header_len - self.header_pos) as i64;
        if pos == SeekFrom::Current(0) {
            let inner = self.inner.stream_position()?;
            return Ok(inner.saturating_sub(pending as u64));
        }
        let target = match pos {
            SeekFrom::Current(offset) => SeekFrom::Current(offset - pending),
            other => other,
        };
        self.header_len = 0;
        self.header_pos = 0;
        self.passthrough = true;
        self.inner.seek(target)
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
                    Ok(response) => {
                        let headers = response.headers();
                        let header_text =
                            |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
                        shared.mark_connected(advertised_bitrate_kbps(
                            header_text("icy-br"),
                            header_text("ice-audio-info"),
                        ));
                        response
                    }
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

/// Seconds of audio a live stream buffers before it starts playing. Enough
/// to ride out ordinary network jitter without making the listener wait for
/// a fixed byte count that is several seconds long at low bitrates.
const LIVE_START_BUFFER_MS: u64 = 1_000;
/// Floor for the live start buffer: room for the format probe and the first
/// frames even on very low bitrate streams.
const LIVE_START_MIN_BYTES: usize = 6 * 1024;
/// Ceiling for the live start buffer (about 1 s of a 1.3 Mbps lossless
/// stream), so a server advertising an absurd bitrate cannot stall startup.
const LIVE_START_MAX_BYTES: usize = 160 * 1024;
/// Assumed bitrate when neither the server nor the station record says.
/// 128 kbps reproduces the previous fixed 16 KiB threshold.
const LIVE_DEFAULT_KBPS: u32 = 128;
const LIVE_STARTUP_TIMEOUT: Duration = Duration::from_secs(12);
/// Most a live format probe may read. Real streams show a marker within the
/// first few KiB; symphonia's own limit is 1 MiB.
const LIVE_PROBE_MAX_BYTES: u64 = 512 * 1024;
const LIVE_ADTS_SCAN_BYTES: usize = 8 * 1024;

fn plausible_kbps(kbps: u32) -> Option<u32> {
    (8..=3_200).contains(&kbps).then_some(kbps)
}

/// Reads the bitrate a radio server advertises: `icy-br: 128` (Shoutcast and
/// Icecast) or `ice-audio-info: ice-samplerate=44100;ice-bitrate=128`.
/// Values outside 8..=3200 kbps are treated as unknown.
pub(crate) fn advertised_bitrate_kbps(
    icy_br: Option<&str>,
    ice_audio_info: Option<&str>,
) -> Option<u32> {
    fn leading_number(text: &str) -> Option<u32> {
        let digits: String = text
            .trim()
            .chars()
            .take_while(|ch| ch.is_ascii_digit())
            .collect();
        digits.parse::<u32>().ok()
    }

    let from_icy = icy_br
        .and_then(|value| value.split(',').next())
        .and_then(leading_number)
        .and_then(plausible_kbps);
    from_icy.or_else(|| {
        ice_audio_info?.split(';').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            let key = key.trim().to_ascii_lowercase();
            if key == "ice-bitrate" || key == "bitrate" {
                leading_number(value).and_then(plausible_kbps)
            } else {
                None
            }
        })
    })
}

/// Bytes to buffer before a live stream starts: about
/// `LIVE_START_BUFFER_MS` of audio at the stream's bitrate, clamped to a
/// sane floor and ceiling.
pub(crate) fn live_start_threshold_bytes(bitrate_kbps: Option<u32>) -> usize {
    let kbps = bitrate_kbps
        .and_then(plausible_kbps)
        .unwrap_or(LIVE_DEFAULT_KBPS);
    // kbps * 1000 / 8 bytes per second, scaled to the buffer duration.
    let bytes = u64::from(kbps) * 125 * LIVE_START_BUFFER_MS / 1_000;
    (bytes as usize).clamp(LIVE_START_MIN_BYTES, LIVE_START_MAX_BYTES)
}

/// Where the time went while a live stream started. Every duration is
/// measured from the `started` instant handed to `prepare_live_audio_source`
/// (the engine's PlayUrl receipt).
#[derive(Debug, Clone, Copy, Default)]
pub struct LiveStartReport {
    pub connected: Option<Duration>,
    pub first_bytes: Option<Duration>,
    pub buffered: Option<Duration>,
    pub decoder_ready: Option<Duration>,
    pub threshold_bytes: usize,
    pub bitrate_kbps: Option<u32>,
    pub bitrate_from_server: bool,
    /// MPEG-2 ADTS headers were rewritten so symphonia recognises the AAC.
    pub adts_patched: bool,
}

impl LiveStartReport {
    fn fill_timeline(&mut self, shared: &SharedBufferedFile, started: Instant) {
        let (connected_at, first_bytes_at) = shared.timeline();
        self.connected = connected_at.map(|at| at.saturating_duration_since(started));
        self.first_bytes = first_bytes_at.map(|at| at.saturating_duration_since(started));
    }
}

fn format_ms(duration: Option<Duration>) -> String {
    duration
        .map(|value| format!("{}ms", value.as_millis()))
        .unwrap_or_else(|| "-".to_string())
}

impl std::fmt::Display for LiveStartReport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let kbps = self
            .bitrate_kbps
            .map(|kbps| kbps.to_string())
            .unwrap_or_else(|| "?".to_string());
        let origin = if self.bitrate_from_server {
            " from server"
        } else {
            ""
        };
        write!(
            f,
            "connected {} | first bytes {} | buffered {} KiB ({} kbps{}) {} | decoder ready {}{}",
            format_ms(self.connected),
            format_ms(self.first_bytes),
            self.threshold_bytes / 1024,
            kbps,
            origin,
            format_ms(self.buffered),
            format_ms(self.decoder_ready),
            if self.adts_patched {
                " (MPEG-2 ADTS)"
            } else {
                ""
            },
        )
    }
}

/// Waits for about one second of live audio, then builds the decoder.
/// `on_connected` runs once the server answered, so the engine can move its
/// stage from "connecting" to "buffering".
fn prepare_live_decoder(
    shared: Arc<SharedBufferedFile>,
    bitrate_hint_kbps: Option<u32>,
    started: Instant,
    on_connected: impl FnOnce(),
) -> Result<(Box<dyn Source<Item = i16> + Send>, LiveStartReport), String> {
    let deadline = Instant::now() + LIVE_STARTUP_TIMEOUT;
    let mut report = LiveStartReport::default();

    let advertised = shared.wait_for_connection(LIVE_STARTUP_TIMEOUT)?;
    on_connected();
    report.bitrate_from_server = advertised.is_some();
    report.bitrate_kbps = advertised.or(bitrate_hint_kbps.and_then(plausible_kbps));
    report.threshold_bytes = live_start_threshold_bytes(report.bitrate_kbps);

    // One retry with a bigger buffer covers a probe that tripped over a
    // partial frame at the start of the server's burst.
    let mut last_error = None;
    for threshold in [report.threshold_bytes, report.threshold_bytes * 4] {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let available = shared.wait_for_bytes(threshold as u64, remaining)?;
        if available == 0 && shared.is_finished() {
            break;
        }
        if report.buffered.is_none() {
            report.buffered = Some(started.elapsed());
        }

        // The reader blocks for more bytes instead of reporting EOF, so the
        // probe never fails just because the buffer is still filling; the
        // probe limit keeps an unrecognised format from stalling for minutes.
        let limit = Arc::new(ProbeLimit::new(LIVE_PROBE_MAX_BYTES, deadline));
        let reader =
            BufferedStreamReader::with_probe_limit(Arc::clone(&shared), Arc::clone(&limit));
        let adts_start = shared
            .peek_prefix(LIVE_ADTS_SCAN_BYTES)
            .ok()
            .and_then(|prefix| find_mpeg2_adts_start(&prefix));
        report.adts_patched = adts_start.is_some();
        let decoder = match adts_start {
            Some(offset) => Decoder::new(BufReader::new(AdtsMpeg2Patch::new(reader, offset)))
                .map(|decoder| Box::new(decoder) as Box<dyn Source<Item = i16> + Send>),
            None => Decoder::new(BufReader::new(reader))
                .map(|decoder| Box::new(decoder) as Box<dyn Source<Item = i16> + Send>),
        };
        limit.release();
        match decoder {
            Ok(decoder) => {
                report.decoder_ready = Some(started.elapsed());
                report.fill_timeline(&shared, started);
                return Ok((decoder, report));
            }
            Err(err) => {
                last_error = Some(err.to_string());
                if shared.is_finished() {
                    break;
                }
            }
        }
    }

    report.fill_timeline(&shared, started);
    log::info!("live stream failed to start: {report}");
    Err(last_error.unwrap_or_else(|| "Timed out preparing audio stream".to_string()))
}

fn prepare_buffered_decoder(
    shared: Arc<SharedBufferedFile>,
    initial_buffer_bytes: usize,
) -> Result<Box<dyn Source<Item = i16> + Send>, String> {
    let minimum_threshold = 64 * 1024;
    let base_threshold = initial_buffer_bytes.max(minimum_threshold);
    let mut thresholds = vec![
        (base_threshold / 2).max(minimum_threshold),
        base_threshold,
        (base_threshold * 3 / 2).max(base_threshold),
    ];
    thresholds.sort_unstable();
    thresholds.dedup();
    let startup_deadline = Instant::now() + Duration::from_secs(15);

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

/// Progressive download of a finite remote track (not live radio).
pub fn prepare_http_audio_source(
    url: String,
    headers: HashMap<String, String>,
    playback_session: Arc<AtomicU64>,
    session_id: u64,
    initial_buffer_bytes: usize,
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
        false,
        event_tx,
        label,
    )?;

    prepare_buffered_decoder(shared, initial_buffer_bytes)
}

/// Opens a live radio stream. Returns once about a second of audio is
/// buffered and the decoder has its first frame, with a timing report.
#[allow(clippy::too_many_arguments)]
pub fn prepare_live_audio_source(
    url: String,
    playback_session: Arc<AtomicU64>,
    session_id: u64,
    bitrate_hint_kbps: Option<u32>,
    started: Instant,
    on_connected: impl FnOnce(),
    event_tx: Sender<AudioEvent>,
    label: String,
) -> Result<(Box<dyn Source<Item = i16> + Send>, LiveStartReport), String> {
    let (writer, reader) = create_unlinked_stream_file()?;
    let shared = Arc::new(SharedBufferedFile::new(reader));

    spawn_download_worker(
        url,
        HashMap::new(),
        writer,
        Arc::clone(&shared),
        playback_session,
        session_id,
        true,
        event_tx,
        label,
    )?;

    prepare_live_decoder(shared, bitrate_hint_kbps, started, on_connected)
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

    prepare_buffered_decoder(shared, initial_buffer_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_threshold_is_about_one_second_of_audio() {
        assert_eq!(live_start_threshold_bytes(Some(128)), 16_000);
        assert_eq!(live_start_threshold_bytes(Some(320)), 40_000);
        assert_eq!(live_start_threshold_bytes(Some(64)), 8_000);
    }

    #[test]
    fn live_threshold_defaults_to_the_old_sixteen_kib_class() {
        assert_eq!(live_start_threshold_bytes(None), 16_000);
        // Out-of-range bitrates are noise, not information.
        assert_eq!(live_start_threshold_bytes(Some(0)), 16_000);
        assert_eq!(live_start_threshold_bytes(Some(90_000)), 16_000);
    }

    #[test]
    fn live_threshold_is_clamped() {
        assert_eq!(live_start_threshold_bytes(Some(24)), LIVE_START_MIN_BYTES);
        assert_eq!(
            live_start_threshold_bytes(Some(3_200)),
            LIVE_START_MAX_BYTES
        );
    }

    #[test]
    fn parses_icy_and_icecast_bitrate_headers() {
        assert_eq!(advertised_bitrate_kbps(Some("128"), None), Some(128));
        assert_eq!(advertised_bitrate_kbps(Some(" 96, 96 "), None), Some(96));
        assert_eq!(
            advertised_bitrate_kbps(
                None,
                Some("ice-samplerate=44100;ice-bitrate=192;ice-channels=2")
            ),
            Some(192)
        );
        assert_eq!(
            advertised_bitrate_kbps(None, Some("channels=2;samplerate=48000;bitrate=64")),
            Some(64)
        );
        assert_eq!(
            advertised_bitrate_kbps(Some("0"), Some("bitrate=320")),
            Some(320)
        );
        assert_eq!(advertised_bitrate_kbps(Some("fast"), None), None);
        assert_eq!(advertised_bitrate_kbps(None, Some("ice-channels=2")), None);
    }

    fn adts_frame(len: usize, sync: u8, fill: u8) -> Vec<u8> {
        let mut frame = vec![
            0xFF,
            sync,
            0x50,
            0x80 | ((len >> 11) as u8 & 0x03),
            (len >> 3) as u8,
            ((len & 0x07) as u8) << 5 | 0x1F,
            0xFC,
        ];
        frame.resize(len, fill);
        // A sync-like pair inside the payload must never be rewritten.
        frame[len - 2] = 0xFF;
        frame[len - 1] = 0xF9;
        frame
    }

    fn read_in_chunks(mut reader: impl Read, chunk: usize) -> Vec<u8> {
        let mut out = Vec::new();
        let mut buf = vec![0; chunk];
        loop {
            let read = reader.read(&mut buf).unwrap();
            if read == 0 {
                return out;
            }
            out.extend_from_slice(&buf[..read]);
        }
    }

    #[test]
    fn finds_mpeg2_adts_after_leading_junk() {
        let mut stream = vec![0x00, 0xFF, 0xF9, 0x12];
        stream.extend(adts_frame(300, 0xF9, 0xAA));
        stream.extend(adts_frame(280, 0xF9, 0xBB));
        assert_eq!(find_mpeg2_adts_start(&stream), Some(4));
    }

    #[test]
    fn ignores_mpeg4_adts_and_other_formats() {
        let mut mpeg4 = adts_frame(300, 0xF1, 0xAA);
        mpeg4.extend(adts_frame(300, 0xF1, 0xAA));
        assert_eq!(find_mpeg2_adts_start(&mpeg4), None);
        assert_eq!(
            find_mpeg2_adts_start(b"ID3 not audio at all, just text"),
            None
        );
    }

    #[test]
    fn adts_patch_rewrites_only_frame_headers() {
        let junk = vec![0x01, 0x02, 0x03];
        let frames = [adts_frame(300, 0xF9, 0xAA), adts_frame(257, 0xF9, 0xBB)];
        let mut stream = junk.clone();
        for frame in &frames {
            stream.extend(frame);
        }

        let mut expected = junk.clone();
        for frame in &frames {
            let mut patched = frame.clone();
            patched[1] = 0xF1;
            expected.extend(patched);
        }

        for chunk in [1, 3, 7, 64, 4096] {
            let reader = AdtsMpeg2Patch::new(io::Cursor::new(stream.clone()), junk.len());
            assert_eq!(
                read_in_chunks(reader, chunk),
                expected,
                "chunk size {chunk}"
            );
        }
    }

    #[test]
    fn adts_patch_passes_through_after_losing_sync() {
        let mut stream = adts_frame(64, 0xF9, 0xAA);
        stream.extend_from_slice(&[0x00; 32]);
        stream.extend(adts_frame(64, 0xF9, 0xAA));
        let output = read_in_chunks(AdtsMpeg2Patch::new(io::Cursor::new(stream.clone()), 0), 16);
        // Only the first header is patched; everything after the lost sync
        // is left exactly as received.
        let mut expected = stream;
        expected[1] = 0xF1;
        assert_eq!(output, expected);
    }

    #[test]
    fn adts_patch_reports_its_logical_position() {
        let stream = adts_frame(64, 0xF9, 0xAA);
        let mut reader = AdtsMpeg2Patch::new(io::Cursor::new(stream), 0);
        let mut two = [0u8; 2];
        reader.read_exact(&mut two).unwrap();
        assert_eq!(reader.stream_position().unwrap(), 2);
    }

    /// Live measurement against real stations, for the latency report:
    /// `MEWSIK_LIVE_URLS=url1,url2 cargo test live_start_latency -- --ignored --nocapture`
    /// Prints when the old fixed 16 KiB threshold and the new bitrate-sized
    /// threshold were reached on the same connection.
    #[test]
    #[ignore]
    fn live_start_latency() {
        let urls = std::env::var("MEWSIK_LIVE_URLS").unwrap_or_default();
        for url in urls.split(',').map(str::trim).filter(|url| !url.is_empty()) {
            let started = Instant::now();
            let (writer, reader) = create_unlinked_stream_file().expect("stream file");
            let shared = Arc::new(SharedBufferedFile::new(reader));
            let session = Arc::new(AtomicU64::new(1));
            let (event_tx, _event_rx) = crossbeam_channel::unbounded();
            spawn_download_worker(
                url.to_string(),
                HashMap::new(),
                writer,
                Arc::clone(&shared),
                Arc::clone(&session),
                1,
                true,
                event_tx,
                "latency probe".to_string(),
            )
            .expect("download worker");

            let old_watch = {
                let shared = Arc::clone(&shared);
                std::thread::spawn(move || {
                    shared
                        .wait_for_bytes(16 * 1024, Duration::from_secs(15))
                        .ok()
                        .map(|_| started.elapsed())
                })
            };
            let result = prepare_live_decoder(Arc::clone(&shared), None, started, || ());
            let old_16k = old_watch.join().ok().flatten();
            match result {
                Ok((_decoder, report)) => {
                    let decode_cost = report
                        .decoder_ready
                        .zip(report.buffered)
                        .map(|(ready, buffered)| ready.saturating_sub(buffered));
                    let old_ready = old_16k.zip(decode_cost).map(|(at, cost)| at + cost);
                    println!(
                        "{url}\n  new: {report}\n  old: 16 KiB reached {} | decoder ready ~{}",
                        format_ms(old_16k),
                        format_ms(old_ready)
                    );
                }
                Err(err) => println!("{url}\n  failed: {err}"),
            }
            session.store(2, Ordering::SeqCst);
        }
    }
}
