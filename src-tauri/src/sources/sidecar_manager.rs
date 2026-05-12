use crate::external_tools::find_binary;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;

pub struct SidecarManager {
    inner: Arc<Mutex<Inner>>,
    request_id: AtomicU64,
}

struct Inner {
    child: Option<Child>,
    stdin: Option<BufWriter<ChildStdin>>,
    stdout: Option<BufReader<ChildStdout>>,
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
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    #[allow(dead_code)]
    id: Option<u64>,
    result: Option<Value>,
    error: Option<JsonRpcError>,
}

#[derive(Deserialize)]
struct JsonRpcError {
    #[allow(dead_code)]
    code: i32,
    message: String,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                child: None,
                stdin: None,
                stdout: None,
            })),
            request_id: AtomicU64::new(1),
        }
    }

    pub fn start(&self) -> Result<(), String> {
        let mut inner = self.inner.lock();
        if inner.child.is_some() {
            return Ok(());
        }

        let script_path = resolve_sidecar_script()?;
        let node_binary = resolve_node_binary()?;

        let mut command = Command::new(&node_binary);
        command
            .arg(&script_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Suppress console window flash when the GUI host spawns the Node sidecar on Windows.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("Failed to start sidecar: {}", e))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to capture sidecar stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture sidecar stdout".to_string())?;
        let stderr = child.stderr.take();

        inner.stdin = Some(BufWriter::new(stdin));
        inner.stdout = Some(BufReader::new(stdout));
        inner.child = Some(child);

        // Drain stderr in the background so a chatty child can't block on a full pipe.
        if let Some(stderr) = stderr {
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    log::info!(target: "mewsik::sidecar", "{}", line);
                }
            });
        }

        Ok(())
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

        let mut inner = self.inner.lock();
        if inner.child.is_none() {
            return Err("Sidecar not running".to_string());
        }

        {
            let stdin = inner
                .stdin
                .as_mut()
                .ok_or_else(|| "Sidecar stdin missing".to_string())?;
            stdin
                .write_all(request_str.as_bytes())
                .map_err(|e| format!("Failed to write to sidecar: {}", e))?;
            stdin
                .flush()
                .map_err(|e| format!("Failed to flush sidecar stdin: {}", e))?;
        }

        let mut line = String::new();
        let bytes_read = {
            let stdout = inner
                .stdout
                .as_mut()
                .ok_or_else(|| "Sidecar stdout missing".to_string())?;
            stdout
                .read_line(&mut line)
                .map_err(|e| format!("Failed to read from sidecar: {}", e))?
        };

        if bytes_read == 0 {
            return Err("Sidecar closed stdout before responding".to_string());
        }

        let response: JsonRpcResponse = serde_json::from_str(line.trim())
            .map_err(|e| format!("Invalid response: {} (raw: {})", e, line.trim()))?;

        if let Some(error) = response.error {
            return Err(format!("Sidecar error: {}", error.message));
        }

        response
            .result
            .ok_or_else(|| "No result from sidecar".to_string())
    }

    pub fn stop(&self) {
        let mut inner = self.inner.lock();
        inner.stdin.take();
        inner.stdout.take();
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    pub fn is_running(&self) -> bool {
        self.inner.lock().child.is_some()
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
        candidates.push(dir.join("resources/sidecar/dist/index.cjs"));
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
    find_binary("node").ok_or_else(|| {
        "Unable to locate a Node.js binary for the sidecar. Checked bundled app resources and PATH."
            .to_string()
    })
}
