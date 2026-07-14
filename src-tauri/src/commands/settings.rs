use crate::config::AppConfig;
use parking_lot::Mutex;
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use tauri::State;

pub type ConfigState = Arc<Mutex<AppConfig>>;

fn library_path_key(path: &str, case_insensitive: bool) -> String {
    if case_insensitive {
        path.to_lowercase()
    } else {
        path.to_string()
    }
}

fn validate_library_paths(
    existing_paths: &[String],
    paths: Vec<String>,
    case_insensitive: bool,
    is_directory: impl Fn(&str) -> bool,
) -> Result<Vec<String>, String> {
    let existing = existing_paths
        .iter()
        .map(|path| library_path_key(path.trim(), case_insensitive))
        .collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    let mut validated = Vec::new();

    for raw_path in paths {
        let path = raw_path.trim();
        if path.is_empty() {
            continue;
        }

        let key = library_path_key(path, case_insensitive);
        if !seen.insert(key.clone()) {
            continue;
        }

        // Keep an exactly equivalent saved path removable even if its drive is
        // disconnected, but never let a different spelling bypass validation
        // on a case-sensitive platform.
        if !existing.contains(&key) && !is_directory(path) {
            return Err(format!(
                "Music folder does not exist or is not a directory: {path}"
            ));
        }

        validated.push(path.to_string());
    }

    Ok(validated)
}

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
    // Windows paths are case-insensitive for the app's supported target. On
    // Unix targets, preserve case because distinct paths may differ only by it.
    cfg.library_paths = validate_library_paths(&cfg.library_paths, paths, cfg!(windows), |path| {
        Path::new(path).is_dir()
    })?;
    cfg.save()
}

#[tauri::command]
pub fn get_library_paths(config: State<'_, ConfigState>) -> Result<Vec<String>, String> {
    Ok(config.lock().library_paths.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn case_sensitive_targets_preserve_distinct_existing_directories() {
        let existing = vec!["/Music/A".to_string()];
        let validated = validate_library_paths(
            &existing,
            vec!["/Music/A".to_string(), "/Music/a".to_string()],
            false,
            |path| path == "/Music/a",
        )
        .unwrap();

        assert_eq!(validated, vec!["/Music/A", "/Music/a"]);
    }

    #[test]
    fn differently_cased_missing_path_cannot_impersonate_existing_path() {
        let existing = vec!["/Music/A".to_string()];
        let result =
            validate_library_paths(&existing, vec!["/music/a".to_string()], false, |_| false);

        assert!(result.is_err());
    }

    #[test]
    fn case_insensitive_targets_dedupe_equivalent_paths() {
        let validated = validate_library_paths(
            &[],
            vec![r"C:\Music".to_string(), r"c:\music".to_string()],
            true,
            |_| true,
        )
        .unwrap();

        assert_eq!(validated, vec![r"C:\Music"]);
    }

    #[test]
    fn saved_disconnected_path_remains_removable() {
        let existing = vec!["/Volumes/Offline/Music".to_string()];
        let validated =
            validate_library_paths(&existing, existing.clone(), false, |_| false).unwrap();

        assert_eq!(validated, existing);
    }
}
