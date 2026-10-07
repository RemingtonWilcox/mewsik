use std::collections::HashMap;
use std::env;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

static RUNTIME_RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RuntimeSource {
    Bundled,
    System,
    Workspace,
}

/// Register Tauri's platform-specific resource directory before any external
/// runtime is resolved. Canonicalizing it once lets every later lookup reject
/// symlinks that escape the signed/packaged resource tree.
pub(crate) fn configure_runtime_resource_dir(resource_dir: PathBuf) -> std::io::Result<()> {
    let canonical = resource_dir.canonicalize()?;

    match RUNTIME_RESOURCE_DIR.set(canonical.clone()) {
        Ok(()) => Ok(()),
        Err(_) if RUNTIME_RESOURCE_DIR.get() == Some(&canonical) => Ok(()),
        Err(_) => Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "runtime resource directory was already configured differently",
        )),
    }
}

fn runtime_source_policy(allow_dev_fallbacks: bool) -> Vec<RuntimeSource> {
    if allow_dev_fallbacks {
        vec![
            RuntimeSource::System,
            RuntimeSource::Bundled,
            RuntimeSource::Workspace,
        ]
    } else {
        vec![RuntimeSource::Bundled]
    }
}

fn binary_names(binary_name: &str) -> Vec<String> {
    let mut names = vec![binary_name.to_string()];
    let exe_suffix = env::consts::EXE_SUFFIX;

    if !exe_suffix.is_empty() && !binary_name.ends_with(exe_suffix) {
        names.push(format!("{binary_name}{exe_suffix}"));
    }

    names
}

fn is_safe_resource_path(relative_path: &Path) -> bool {
    !relative_path.as_os_str().is_empty()
        && relative_path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

/// Resolve a regular file inside the canonical Tauri resource directory.
/// Both the root and target are canonicalized so a packaged symlink cannot
/// redirect execution to PATH, the working directory, or another writable
/// location.
pub(crate) fn find_bundled_resource(relative_path: &Path) -> Option<PathBuf> {
    if !is_safe_resource_path(relative_path) {
        return None;
    }

    let resource_dir = RUNTIME_RESOURCE_DIR.get()?;
    let candidate = resource_dir.join(relative_path).canonicalize().ok()?;

    if candidate.starts_with(resource_dir) && candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

fn bundled_app_binary_paths(binary_name: &str) -> Vec<PathBuf> {
    binary_names(binary_name)
        .into_iter()
        .filter_map(|name| find_bundled_resource(&Path::new("bin").join(name)))
        .collect()
}

#[cfg(debug_assertions)]
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

#[cfg(debug_assertions)]
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

    for source in runtime_source_policy(cfg!(debug_assertions)) {
        match source {
            RuntimeSource::Bundled => candidates.extend(bundled_app_binary_paths(binary_name)),
            #[cfg(debug_assertions)]
            RuntimeSource::System => candidates.extend(system_binary_paths(binary_name)),
            #[cfg(debug_assertions)]
            RuntimeSource::Workspace => candidates.extend(workspace_binary_paths(binary_name)),
            #[cfg(not(debug_assertions))]
            RuntimeSource::System | RuntimeSource::Workspace => unreachable!(
                "release runtime policy must never include development fallback sources"
            ),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_policy_only_allows_bundled_resources() {
        assert_eq!(runtime_source_policy(false), vec![RuntimeSource::Bundled]);
    }

    #[test]
    fn development_policy_keeps_ergonomic_fallback_order() {
        assert_eq!(
            runtime_source_policy(true),
            vec![
                RuntimeSource::System,
                RuntimeSource::Bundled,
                RuntimeSource::Workspace,
            ]
        );
    }

    #[test]
    fn bundled_resource_paths_must_be_strictly_relative() {
        assert!(is_safe_resource_path(Path::new("bin/node")));
        assert!(is_safe_resource_path(Path::new("sidecar/dist/index.cjs")));
        assert!(!is_safe_resource_path(Path::new("../node")));
        assert!(!is_safe_resource_path(Path::new("bin/../node")));
        assert!(!is_safe_resource_path(Path::new("")));
        assert!(!is_safe_resource_path(Path::new("/tmp/node")));
    }
}
