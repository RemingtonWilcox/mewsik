use crate::config::AppConfig;
use parking_lot::Mutex;
use std::sync::Arc;
use tauri::State;

pub type ConfigState = Arc<Mutex<AppConfig>>;

#[tauri::command]
pub fn get_settings(config: State<'_, ConfigState>) -> Result<AppConfig, String> {
    Ok(config.lock().clone())
}

#[tauri::command]
pub fn update_library_paths(
    config: State<'_, ConfigState>,
    paths: Vec<String>,
) -> Result<(), String> {
    let mut cfg = config.lock();
    cfg.library_paths = paths;
    cfg.save()
}

#[tauri::command]
pub fn get_library_paths(config: State<'_, ConfigState>) -> Result<Vec<String>, String> {
    Ok(config.lock().library_paths.clone())
}
