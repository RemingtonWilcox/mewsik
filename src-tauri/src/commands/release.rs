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

/// The public feed every release publishes (also the desktop updater endpoint).
const LATEST_RELEASE_FEED: &str =
    "https://github.com/RemingtonWilcox/mewsik/releases/latest/download/latest.json";
/// Public TestFlight link; iPhone builds update there, never in-app.
const TESTFLIGHT_URL: &str = "https://testflight.apple.com/join/5GCnVzzR";

#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestRelease {
    version: String,
    #[serde(alias = "pub_date")]
    pub_date: Option<String>,
}

/// Reads the newest published version from the release feed. The iPhone app
/// uses it to point people at TestFlight; desktop uses the updater plugin.
#[tauri::command]
pub async fn get_latest_release() -> Result<LatestRelease, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent(concat!("mewsik/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    client
        .get(LATEST_RELEASE_FEED)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?
        .json::<LatestRelease>()
        .await
        .map_err(|e| e.to_string())
}

/// Opens the public TestFlight page (the TestFlight app on an iPhone).
#[tauri::command]
pub fn open_testflight(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(TESTFLIGHT_URL, None::<&str>)
        .map_err(|e| e.to_string())
}
