use std::collections::HashMap;
use std::env;
use std::path::PathBuf;

fn binary_names(binary_name: &str) -> Vec<String> {
    let mut names = vec![binary_name.to_string()];
    let exe_suffix = env::consts::EXE_SUFFIX;

    if !exe_suffix.is_empty() && !binary_name.ends_with(exe_suffix) {
        names.push(format!("{binary_name}{exe_suffix}"));
    }

    names
}

fn workspace_binary_paths(binary_name: &str) -> Vec<PathBuf> {
    let names = binary_names(binary_name);
    let mut candidates = Vec::new();

    if let Ok(cwd) = env::current_dir() {
        for name in &names {
            candidates.push(cwd.join("src-tauri/resources/bin").join(name));
            candidates.push(cwd.join("resources/bin").join(name));
            candidates.push(cwd.join("bin").join(name));
        }
    }

    candidates
}

fn bundled_app_binary_paths(binary_name: &str) -> Vec<PathBuf> {
    let names = binary_names(binary_name);
    let mut candidates = Vec::new();

    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            for name in &names {
                candidates.push(exe_dir.join("bin").join(name));

                if let Some(contents_dir) = exe_dir.parent() {
                    candidates.push(contents_dir.join("Resources/bin").join(name));
                    candidates.push(contents_dir.join("resources/bin").join(name));
                }
            }
        }
    }

    candidates
}

fn system_binary_paths(binary_name: &str) -> Vec<PathBuf> {
    let names = binary_names(binary_name);
    let mut candidates = Vec::new();

    if let Some(path_var) = env::var_os("PATH") {
        for dir in env::split_paths(&path_var) {
            for name in &names {
                candidates.push(dir.join(name));
            }
        }
    }

    for name in &names {
        candidates.extend([
            PathBuf::from(format!("/opt/homebrew/bin/{name}")),
            PathBuf::from(format!("/usr/local/bin/{name}")),
            PathBuf::from(format!("/opt/local/bin/{name}")),
            PathBuf::from(format!("/usr/bin/{name}")),
        ]);
    }

    candidates
}

fn candidate_binary_paths(binary_name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    match binary_name {
        // Prefer known-good local toolchains during development, but keep the
        // packaged app self-contained with bundled fallbacks.
        "ffmpeg" | "node" => {
            candidates.extend(system_binary_paths(binary_name));
            candidates.extend(bundled_app_binary_paths(binary_name));
            candidates.extend(workspace_binary_paths(binary_name));
        }
        _ => {
            candidates.extend(bundled_app_binary_paths(binary_name));
            candidates.extend(system_binary_paths(binary_name));
            candidates.extend(workspace_binary_paths(binary_name));
        }
    }

    candidates
}

pub(crate) fn find_binary(binary_name: &str) -> Option<PathBuf> {
    candidate_binary_paths(binary_name)
        .into_iter()
        .find(|path| path.is_file())
}

pub(crate) fn format_ffmpeg_headers(headers: &HashMap<String, String>) -> Option<String> {
    if headers.is_empty() {
        return None;
    }

    let mut lines = String::new();
    for (key, value) in headers {
        let sanitized_value = value.replace(['\r', '\n'], " ");
        lines.push_str(key);
        lines.push_str(": ");
        lines.push_str(&sanitized_value);
        lines.push_str("\r\n");
    }

    Some(lines)
}
