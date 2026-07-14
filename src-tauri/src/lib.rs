#![allow(dead_code)]

pub mod analysis;
mod audio;
mod commands;
mod config;
mod db;
mod discovery;
mod download;
mod external_tools;
mod keychain;
mod metadata;
mod sources;
mod stations;

use audio::AudioEngine;
use commands::external_search::ExternalSearchRuntime;
use commands::settings::ConfigState;
use config::AppConfig;
use discovery::feed::{DiscoveryFeedRuntime, SharedDiscoveryFeedRuntime};
use download::DownloadManager;
use parking_lot::Mutex;
use sources::{SidecarManager, StreamCache};
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cfg = AppConfig::load();

    // Ensure data directory exists
    let data_dir = AppConfig::data_dir();
    std::fs::create_dir_all(&data_dir).expect("failed to create data directory");

    // Init database
    let db_path = AppConfig::db_path();
    let db = db::init_db(&db_path).expect("failed to initialize database");

    // Init audio engine
    let engine = Arc::new(AudioEngine::new(db.clone()));
    let engine_for_setup = Arc::clone(&engine);

    // Config state
    let config_state: ConfigState = Arc::new(Mutex::new(cfg));

    // Sidecar manager (lazy-started)
    let sidecar = Arc::new(SidecarManager::new());
    let downloads = Arc::new(DownloadManager::default());

    // Stream URL pre-resolution cache
    let stream_cache: StreamCache =
        Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
    let external_search_runtime = Arc::new(ExternalSearchRuntime::default());
    let discovery_feed_runtime: SharedDiscoveryFeedRuntime =
        Arc::new(DiscoveryFeedRuntime::default());
    let startup_db = db.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .setup(move |app| {
            external_tools::configure_runtime_resource_dir(app.path().resource_dir()?)?;
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            stations::health::spawn_favorite_station_health_check(startup_db.clone());
            engine_for_setup.set_app_handle(app.handle().clone());
            Ok(())
        })
        .manage(db)
        .manage(engine)
        .manage(config_state)
        .manage(sidecar)
        .manage(downloads)
        .manage(stream_cache)
        .manage(external_search_runtime)
        .manage(discovery_feed_runtime)
        .invoke_handler(tauri::generate_handler![
            // Library
            commands::library::scan_library,
            commands::library::get_library_tracks,
            commands::library::get_all_artists,
            commands::library::get_all_albums,
            commands::library::get_artist,
            commands::library::get_artist_tracks,
            commands::library::get_album_tracks,
            commands::library::save_to_library,
            commands::library::remove_from_library,
            // Playback
            commands::playback::play_recording,
            commands::playback::pause,
            commands::playback::stop_playback,
            commands::playback::resume,
            commands::playback::seek,
            commands::playback::set_volume,
            commands::playback::next_track,
            commands::playback::prev_track,
            commands::playback::set_shuffle,
            commands::playback::set_repeat,
            commands::playback::get_playback_state,
            commands::playback::get_playback_waveform,
            commands::playback::play_tracks_from,
            commands::playback::add_to_queue,
            commands::playback::play_next,
            commands::playback::play_queue_index,
            commands::playback::get_queue,
            commands::playback::remove_from_queue,
            commands::playback::clear_queue,
            // Playlists
            commands::playlists::get_playlists,
            commands::playlists::create_playlist,
            commands::playlists::delete_playlist,
            commands::playlists::add_to_playlist,
            commands::playlists::remove_from_playlist,
            commands::playlists::get_playlist_tracks,
            commands::playlists::reorder_playlist_track,
            commands::playlists::update_playlist,
            // Search
            commands::search::search_library,
            // Settings
            commands::settings::get_settings,
            commands::settings::update_library_paths,
            commands::settings::get_library_paths,
            // Smart playlists
            commands::smart_playlists::create_smart_playlist,
            commands::smart_playlists::evaluate_smart_playlist,
            // External search
            commands::external_search::search_external,
            commands::external_search::search_all_sources,
            commands::external_search::ensure_external_recording,
            commands::external_search::play_external,
            commands::external_search::start_sidecar,
            commands::external_search::stop_sidecar,
            commands::external_search::sidecar_status,
            // Discovery
            commands::discovery::get_daily_mix,
            commands::discovery::get_rediscover,
            commands::discovery::get_play_stats,
            commands::discovery::get_recently_played,
            commands::discovery::get_search_discovery_feed,
            // Downloads
            commands::downloads::get_downloads,
            commands::downloads::download_recording,
            commands::downloads::cancel_download,
            commands::downloads::delete_download,
            commands::downloads::reveal_download_path,
            // Visual score (track analysis)
            commands::analysis::get_track_analysis,
            commands::analysis::request_track_analysis,
            // Stations
            commands::stations::search_radio_stations,
            commands::stations::search_radio_stations_advanced,
            commands::stations::browse_radio_stations,
            commands::stations::get_radio_station_details,
            commands::stations::save_station,
            commands::stations::get_favorite_stations,
            commands::stations::verify_favorite_stations,
            commands::stations::verify_station_urls,
            commands::stations::toggle_station_favorite,
            commands::stations::play_station,
            commands::stations::play_station_search_result,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
