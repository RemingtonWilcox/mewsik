// iOS Now Playing integration. Bridges to Swift code in
// `src-tauri/gen/apple/Sources/mewsik/NowPlaying.swift`.
//
// On iOS this lets Mewsik:
//   - Keep audio playing when the screen locks (AVAudioSession .playback).
//   - Show the current track on the lock screen / Control Center.
//   - Receive AirPods double-tap, lock-screen play/pause, headphone gestures,
//     CarPlay, and Apple Watch as `AudioCommand`s into the engine.

use crate::audio::engine::AudioCommand;
use crate::audio::queue::RepeatMode;
use crate::db::models::PlaybackState;
use crossbeam_channel::Sender;
use parking_lot::Mutex;
use std::ffi::CString;
use std::os::raw::{c_char, c_longlong};
use std::sync::OnceLock;

// Command IDs must stay in sync with NowPlaying.swift.
const CMD_RESUME: i32 = 0;
const CMD_PAUSE: i32 = 1;
const CMD_TOGGLE: i32 = 2;
const CMD_NEXT: i32 = 3;
const CMD_PREV: i32 = 4;
const CMD_STOP: i32 = 5;
const CMD_SEEK: i32 = 6;
const CMD_INTERRUPTED: i32 = 7;
const CMD_RESET_OUTPUT: i32 = 8;

extern "C" {
    fn mewsik_now_playing_setup(handler: extern "C" fn(i32, c_longlong));
    fn mewsik_now_playing_update(
        title: *const c_char,
        artist: *const c_char,
        album: *const c_char,
        artwork_url: *const c_char,
        duration_ms: c_longlong,
        position_ms: c_longlong,
        is_playing: bool,
        is_live: bool,
    );
    fn mewsik_now_playing_clear();
}

static REMOTE_TX: OnceLock<Mutex<Option<Sender<AudioCommand>>>> = OnceLock::new();
// Tracks the most recently observed `is_playing` so the togglePlayPause
// remote command can pick the right action.
static LAST_IS_PLAYING: OnceLock<Mutex<bool>> = OnceLock::new();

fn remote_tx() -> &'static Mutex<Option<Sender<AudioCommand>>> {
    REMOTE_TX.get_or_init(|| Mutex::new(None))
}

fn last_is_playing() -> &'static Mutex<bool> {
    LAST_IS_PLAYING.get_or_init(|| Mutex::new(false))
}

extern "C" fn remote_command_handler(cmd_id: i32, payload: c_longlong) {
    let tx_lock = remote_tx().lock();
    let Some(tx) = tx_lock.as_ref() else { return };

    let cmd = match cmd_id {
        CMD_RESUME => AudioCommand::Resume,
        CMD_PAUSE => AudioCommand::Pause,
        CMD_TOGGLE => {
            if *last_is_playing().lock() {
                AudioCommand::Pause
            } else {
                AudioCommand::Resume
            }
        }
        CMD_NEXT => AudioCommand::Next,
        CMD_PREV => AudioCommand::Prev,
        CMD_STOP => AudioCommand::Stop,
        CMD_SEEK => AudioCommand::Seek(payload.max(0) as u64),
        CMD_INTERRUPTED => AudioCommand::Interrupted,
        CMD_RESET_OUTPUT => AudioCommand::ResetOutput,
        _ => return,
    };

    let _ = tx.send(cmd);
}

/// Activates the iOS audio session, registers remote command handlers, and
/// stores the channel used to dispatch remote commands back into the engine.
/// Safe to call multiple times — Swift side guards against double-setup.
pub fn setup(cmd_tx: Sender<AudioCommand>) {
    *remote_tx().lock() = Some(cmd_tx);
    unsafe {
        mewsik_now_playing_setup(remote_command_handler);
    }
}

/// Pushes the current playback state into MPNowPlayingInfoCenter so the lock
/// screen / Control Center / AirPods reflect what's playing.
pub fn update(state: &PlaybackState) {
    *last_is_playing().lock() = state.is_playing;

    // Suppress the lock-screen entry entirely if there's nothing to show.
    if state.current_title.is_none()
        && state.current_artist.is_none()
        && state.current_source_url.is_none()
        && state.current_recording_id.is_none()
    {
        unsafe { mewsik_now_playing_clear() };
        return;
    }

    let title = CString::new(state.current_title.clone().unwrap_or_default()).unwrap_or_default();
    let artist = CString::new(state.current_artist.clone().unwrap_or_default()).unwrap_or_default();
    // PlaybackState doesn't carry album separately; pass empty.
    let album = CString::new("").unwrap_or_default();
    let artwork_url =
        CString::new(state.current_album_art.clone().unwrap_or_default()).unwrap_or_default();

    let is_live = state.source.as_deref() == Some("radio");

    unsafe {
        mewsik_now_playing_update(
            title.as_ptr(),
            artist.as_ptr(),
            album.as_ptr(),
            artwork_url.as_ptr(),
            state.duration_ms as c_longlong,
            state.position_ms as c_longlong,
            state.is_playing,
            is_live,
        );
    }
}

// Suppress dead-code warnings on platforms where this module isn't reachable.
#[allow(dead_code)]
fn _force_use(_: RepeatMode) {}
