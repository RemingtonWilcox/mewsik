use crate::audio::AudioEngine;
use crate::db::DbPool;
use crate::download::DownloadManager;
use crate::sources::SidecarManager;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseRuntimeInfo {
    app_version: &'static str,
    update_channel: Option<&'static str>,
    updater_configured: bool,
    platform: &'static str,
    architecture: &'static str,
}

/// Describes capabilities baked into this exact executable.
///
/// Normal local builds deliberately omit MEWSIK_UPDATE_CHANNEL, so the UI can
/// distinguish "updates are not configured for this build" from a network
/// failure. The release workflow sets the value only after it has generated a
/// valid updater configuration and passed its signing preflight.
#[tauri::command]
pub fn get_release_runtime_info() -> ReleaseRuntimeInfo {
    let update_channel = option_env!("MEWSIK_UPDATE_CHANNEL")
        .map(str::trim)
        .filter(|channel| !channel.is_empty());

    ReleaseRuntimeInfo {
        app_version: env!("CARGO_PKG_VERSION"),
        update_channel,
        updater_configured: update_channel.is_some(),
        platform: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallReadiness {
    ready: bool,
    active_downloads: usize,
}

/// Atomically closes the music-download admission gate before checking for
/// active jobs. Once clear, explicitly tears down native children and audio
/// because the Windows updater can terminate without RunEvent::Exit.
#[tauri::command]
pub fn prepare_update_install(
    downloads: State<'_, Arc<DownloadManager>>,
    db: State<'_, DbPool>,
    engine: State<'_, Arc<AudioEngine>>,
    sidecar: State<'_, Arc<SidecarManager>>,
) -> Result<UpdateInstallReadiness, String> {
    let active_downloads = downloads.prepare_update_install(&db)?;
    if active_downloads > 0 {
        return Ok(UpdateInstallReadiness {
            ready: false,
            active_downloads,
        });
    }

    sidecar.shutdown();
    engine.shutdown_for_exit();
    Ok(UpdateInstallReadiness {
        ready: true,
        active_downloads: 0,
    })
}
