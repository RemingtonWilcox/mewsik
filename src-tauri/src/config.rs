use directories::{ProjectDirs, UserDirs};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub library_paths: Vec<String>,
    pub audio_device: Option<String>,
    pub normalization_enabled: bool,
    pub last_volume: f32,
    /// User-selected destination for new downloads. Existing downloads retain
    /// their absolute paths and are never moved implicitly.
    pub download_directory: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            library_paths: Vec::new(),
            audio_device: None,
            normalization_enabled: true,
            last_volume: 1.0,
            download_directory: None,
        }
    }
}

fn preferred_download_dir(
    audio_dir: Option<&Path>,
    downloads_dir: Option<&Path>,
    private_data_dir: &Path,
) -> PathBuf {
    audio_dir
        .or(downloads_dir)
        .map(|base| base.join("Mewsik"))
        .unwrap_or_else(|| private_data_dir.join("downloads"))
}

fn write_config_atomically(path: &Path, data: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Config path has no parent directory".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let temp_path = parent.join(format!(".config-{}.tmp", ulid::Ulid::new()));
    let write_result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(|e| e.to_string())?;
        file.write_all(data).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&temp_path, path).map_err(|e| e.to_string())?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    write_result
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

    pub fn default_download_dir() -> PathBuf {
        let user_dirs = UserDirs::new();
        preferred_download_dir(
            user_dirs.as_ref().and_then(UserDirs::audio_dir),
            user_dirs.as_ref().and_then(UserDirs::download_dir),
            &Self::data_dir(),
        )
    }

    pub fn download_dir(&self) -> PathBuf {
        self.download_directory
            .as_deref()
            .filter(|path| !path.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(Self::default_download_dir)
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
        let data = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        write_config_atomically(&path, data.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_config_without_download_directory_keeps_existing_settings() {
        let config: AppConfig = serde_json::from_str(
            r#"{
                "library_paths": ["C:\\Music"],
                "audio_device": "Speakers",
                "normalization_enabled": false,
                "last_volume": 0.42
            }"#,
        )
        .expect("old config should deserialize");

        assert_eq!(config.library_paths, vec![r"C:\Music"]);
        assert_eq!(config.audio_device.as_deref(), Some("Speakers"));
        assert!(!config.normalization_enabled);
        assert_eq!(config.last_volume, 0.42);
        assert_eq!(config.download_directory, None);
    }

    #[test]
    fn music_folder_is_preferred_for_user_facing_downloads() {
        let result = preferred_download_dir(
            Some(Path::new("/Users/listener/Music")),
            Some(Path::new("/Users/listener/Downloads")),
            Path::new("/private/mewsik"),
        );

        assert_eq!(result, PathBuf::from("/Users/listener/Music/Mewsik"));
    }

    #[test]
    fn regular_downloads_folder_is_the_public_fallback() {
        let result = preferred_download_dir(
            None,
            Some(Path::new("/Users/listener/Downloads")),
            Path::new("/private/mewsik"),
        );

        assert_eq!(result, PathBuf::from("/Users/listener/Downloads/Mewsik"));
    }

    #[test]
    fn explicit_directory_wins_without_affecting_private_app_data() {
        let config = AppConfig {
            download_directory: Some("/Volumes/Music Drive/Mewsik ".to_string()),
            ..AppConfig::default()
        };

        assert_eq!(
            config.download_dir(),
            PathBuf::from("/Volumes/Music Drive/Mewsik ")
        );
    }

    #[test]
    fn atomic_writer_replaces_existing_config() {
        let root = std::env::temp_dir().join(format!("mewsik-config-{}", ulid::Ulid::new()));
        let path = root.join("config.json");
        std::fs::create_dir_all(&root).expect("create temp config directory");
        std::fs::write(&path, b"old").expect("write old config");

        write_config_atomically(&path, b"new").expect("replace config");

        assert_eq!(std::fs::read(&path).expect("read config"), b"new");
        let _ = std::fs::remove_dir_all(root);
    }
}
