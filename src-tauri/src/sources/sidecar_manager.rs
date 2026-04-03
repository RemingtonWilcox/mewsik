use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::env;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

const LEGACY_SOCKET_PATH: &str = "/tmp/mewsik-sidecar.sock";

pub struct SidecarManager {
    process: Arc<Mutex<Option<Child>>>,
    socket_path: PathBuf,
    request_id: AtomicU64,
}

#[derive(Serialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: u64,
    method: String,
    params: Value,
}

#[derive(Deserialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    id: Option<u64>,
    result: Option<Value>,
    error: Option<JsonRpcError>,
}

#[derive(Deserialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            process: Arc::new(Mutex::new(None)),
            socket_path: std::env::temp_dir()
                .join(format!("mewsik-sidecar-{}.sock", std::process::id())),
            request_id: AtomicU64::new(1),
        }
    }

    pub fn start(&self) -> Result<(), String> {
        // Check if already running
        {
            let proc = self.process.lock();
            if proc.is_some() {
                return Ok(());
            }
        }

        Self::remove_socket_if_exists(&self.socket_path);
        Self::remove_socket_if_exists(Path::new(LEGACY_SOCKET_PATH));
        let script_path = resolve_sidecar_script()?;
        let node_binary = resolve_node_binary()?;

        // Start the sidecar process
        let child = Command::new(node_binary)
            .arg(script_path)
            .arg(&self.socket_path)
            .spawn()
            .map_err(|e| format!("Failed to start sidecar: {}", e))?;

        *self.process.lock() = Some(child);

        // Wait for socket to be available
        for _ in 0..50 {
            std::thread::sleep(Duration::from_millis(100));
            if self.socket_path.exists() {
                return Ok(());
            }
        }

        self.stop();
        Err("Timed out waiting for sidecar socket".to_string())
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.request_id.fetch_add(1, Ordering::SeqCst);
        let request = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id,
            method: method.to_string(),
            params,
        };

        let request_str = serde_json::to_string(&request).map_err(|e| e.to_string())? + "\n";
        let mut stream = UnixStream::connect(&self.socket_path)
            .map_err(|e| format!("Failed to connect to sidecar: {}", e))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .map_err(|e| e.to_string())?;
        stream
            .write_all(request_str.as_bytes())
            .map_err(|e| format!("Failed to write to sidecar: {}", e))?;
        stream.flush().map_err(|e| e.to_string())?;

        // Read response
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|e| format!("Failed to read from sidecar: {}", e))?;

        let response: JsonRpcResponse =
            serde_json::from_str(&line).map_err(|e| format!("Invalid response: {}", e))?;

        if let Some(error) = response.error {
            return Err(format!("Sidecar error: {}", error.message));
        }

        response
            .result
            .ok_or_else(|| "No result from sidecar".to_string())
    }

    pub fn stop(&self) {
        if let Some(mut child) = self.process.lock().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Self::remove_socket_if_exists(&self.socket_path);
        Self::remove_socket_if_exists(Path::new(LEGACY_SOCKET_PATH));
    }

    pub fn is_running(&self) -> bool {
        self.process.lock().is_some()
    }

    fn remove_socket_if_exists(path: &Path) {
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.stop();
    }
}

fn resolve_sidecar_script() -> Result<PathBuf, String> {
    let cwd_candidate = std::env::current_dir()
        .map_err(|e| format!("Failed to read current dir: {}", e))?
        .join("sidecar/dist/index.cjs");
    if cwd_candidate.exists() {
        return Ok(cwd_candidate);
    }

    let exe = std::env::current_exe()
        .map_err(|e| format!("Failed to resolve current executable: {}", e))?;

    let mut candidates = Vec::new();
    if let Some(dir) = exe.parent() {
        candidates.push(dir.join("sidecar/dist/index.cjs"));
        if let Some(contents_dir) = dir.parent() {
            candidates.push(contents_dir.join("Resources/sidecar/dist/index.cjs"));
        }
    }

    for candidate in candidates {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err("Unable to locate sidecar/dist/index.cjs".to_string())
}

fn resolve_node_binary() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(path_var) = env::var_os("PATH") {
        for path in env::split_paths(&path_var) {
            candidates.push(path.join("node"));
        }
    }

    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/opt/local/bin/node"),
        PathBuf::from("/usr/bin/node"),
    ]);

    candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| {
            "Unable to locate a Node.js binary for the sidecar. Checked PATH, /opt/homebrew/bin/node, /usr/local/bin/node, /opt/local/bin/node, and /usr/bin/node.".to_string()
        })
}
