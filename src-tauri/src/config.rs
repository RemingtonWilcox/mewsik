use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub library_paths: Vec<String>,
    pub audio_device: Option<String>,
    pub normalization_enabled: bool,
    pub last_volume: f32,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            library_paths: Vec::new(),
            audio_device: None,
            normalization_enabled: true,
            last_volume: 1.0,
        }
    }
}

impl AppConfig {
    pub fn data_dir() -> PathBuf {
        ProjectDirs::from("app", "mewsik", "mewsik")
            .map(|dirs| dirs.data_dir().to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."))
    }

    pub fn config_path() -> PathBuf {
        Self::data_dir().join("config.json")
    }

    pub fn db_path() -> PathBuf {
        Self::data_dir().join("library.db")
    }

    pub fn load() -> Self {
        let path = Self::config_path();
        if path.exists() {
            let data = std::fs::read_to_string(&path).unwrap_or_default();
            serde_json::from_str(&data).unwrap_or_default()
        } else {
            Self::default()
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let data = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, data).map_err(|e| e.to_string())?;
        Ok(())
    }
}
