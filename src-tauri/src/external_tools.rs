use std::collections::HashMap;
use std::env;
use std::path::PathBuf;

fn candidate_binary_paths(binary_name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(path_var) = env::var_os("PATH") {
        candidates.extend(env::split_paths(&path_var).map(|dir| dir.join(binary_name)));
    }

    candidates.extend([
        PathBuf::from(format!("/opt/homebrew/bin/{binary_name}")),
        PathBuf::from(format!("/usr/local/bin/{binary_name}")),
        PathBuf::from(format!("/opt/local/bin/{binary_name}")),
        PathBuf::from(format!("/usr/bin/{binary_name}")),
    ]);

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
