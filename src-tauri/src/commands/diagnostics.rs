//! "Save log file": copies the app's own log into one text file the user can
//! attach to a bug report. Nothing is sent anywhere; the file lands in
//! Downloads (desktop) or the app's Documents folder, which the Files app
//! shows (iPhone).

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Newest log text kept in the export. The plugin rotates at 512 KB, so this
/// keeps the current file plus the tail of an older one at most.
const MAX_EXPORT_BYTES: usize = 1_500_000;

#[tauri::command]
pub fn save_log_file(app: AppHandle) -> Result<String, String> {
    let paths = app.path();
    let log_dir = paths.app_log_dir().map_err(|e| e.to_string())?;
    let out_dir = export_dir(&app)?;
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("Couldn't create {}: {e}", out_dir.display()))?;

    let home = paths.home_dir().ok();
    let body = redact_home(&collect_logs(&log_dir), home.as_deref());
    let now = chrono::Local::now();
    let header = format!(
        "mewsik {} on {} {}\nSaved {}\n\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        now.format("%Y-%m-%d %H:%M:%S %:z"),
    );
    let out = out_dir.join(format!("mewsik-log-{}.txt", now.format("%Y%m%d-%H%M%S")));
    std::fs::write(&out, format!("{header}{body}"))
        .map_err(|e| format!("Couldn't write {}: {e}", out.display()))?;
    log::info!("saved log file ({} bytes)", body.len());

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        use tauri_plugin_opener::OpenerExt;
        let _ = app.opener().reveal_item_in_dir(&out);
    }
    Ok(out.to_string_lossy().into_owned())
}

fn export_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let paths = app.path();
    if cfg!(any(target_os = "ios", target_os = "android")) {
        paths.document_dir().map_err(|e| e.to_string())
    } else {
        paths
            .download_dir()
            .or_else(|_| paths.desktop_dir())
            .map_err(|e| e.to_string())
    }
}

/// Every `.log` file in the folder, oldest first, trimmed to the newest
/// `MAX_EXPORT_BYTES`.
fn collect_logs(dir: &Path) -> String {
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "log"))
        .map(|path| {
            let modified = std::fs::metadata(&path)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            (modified, path)
        })
        .collect();
    files.sort();
    let mut text = String::new();
    for (_, path) in files {
        if let Ok(bytes) = std::fs::read(&path) {
            text.push_str(&String::from_utf8_lossy(&bytes));
        }
    }
    if text.is_empty() {
        return "(the log is empty)\n".to_string();
    }
    if text.len() > MAX_EXPORT_BYTES {
        let mut cut = text.len() - MAX_EXPORT_BYTES;
        while !text.is_char_boundary(cut) {
            cut += 1;
        }
        // Start on a whole line.
        if let Some(newline) = text[cut..].find('\n') {
            cut += newline + 1;
        }
        text.drain(..cut);
    }
    text
}

/// Replace the user's home folder with `~` so the file doesn't carry their
/// account name.
fn redact_home(text: &str, home: Option<&Path>) -> String {
    let Some(home) = home.map(|h| h.to_string_lossy().into_owned()) else {
        return text.to_string();
    };
    if home.len() < 3 {
        return text.to_string();
    }
    let mut out = text.replace(&home, "~");
    // Windows paths also show up with forward slashes.
    let forward = home.replace('\\', "/");
    if forward != home {
        out = out.replace(&forward, "~");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_both_slash_styles() {
        let home = Path::new(r"C:\Users\someone");
        let text = r"scan C:\Users\someone\Music and C:/Users/someone/Music";
        assert_eq!(redact_home(text, Some(home)), r"scan ~\Music and ~/Music");
    }

    #[test]
    fn trims_to_newest_whole_lines() {
        let dir = std::env::temp_dir().join(format!("mewsik-log-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let line = "x".repeat(99) + "\n";
        std::fs::write(dir.join("a.log"), line.repeat(20_000)).unwrap();
        let text = collect_logs(&dir);
        assert!(text.len() <= MAX_EXPORT_BYTES);
        assert!(text.starts_with('x') && text.ends_with('\n'));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
