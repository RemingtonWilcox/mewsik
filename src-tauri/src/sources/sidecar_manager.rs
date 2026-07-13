use crate::external_tools::{find_binary, find_bundled_resource};
use crossbeam_channel::{bounded, RecvTimeoutError, Sender};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// Upper bound on a single sidecar round-trip. Stream resolution can chain
/// several upstream fetches (InnerTube client fallbacks), so this is generous.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

type PendingMap = Arc<Mutex<HashMap<u64, Sender<JsonRpcResponse>>>>;

pub struct SidecarManager {
    inner: Arc<Mutex<Inner>>,
    pending: PendingMap,
    request_id: AtomicU64,
}

struct Inner {
    child: Option<Child>,
    stdin: Option<BufWriter<ChildStdin>>,
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
            })),
            pending: Arc::new(Mutex::new(HashMap::new())),
            request_id: AtomicU64::new(1),
        }
    }

    pub fn start(&self) -> Result<(), String> {
        let mut inner = self.inner.lock();
        reap_if_dead(&mut inner, &self.pending);
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
        inner.child = Some(child);

        // Route responses to waiting callers by request id. The thread exits
        // when the child's stdout closes, failing any in-flight calls fast.
        let pending = Arc::clone(&self.pending);
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(line) => line,
                    Err(_) => break,
                };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<JsonRpcResponse>(trimmed) {
                    Ok(response) => {
                        let waiter = response.id.and_then(|id| pending.lock().remove(&id));
                        match waiter {
                            Some(tx) => {
                                let _ = tx.send(response);
                            }
                            None => log::debug!(
                                target: "mewsik::sidecar",
                                "response with no waiter (timed out caller?): {}",
                                trimmed
                            ),
                        }
                    }
                    Err(e) => log::warn!(
                        target: "mewsik::sidecar",
                        "unparseable sidecar line: {} ({})",
                        trimmed,
                        e
                    ),
                }
            }
            pending.lock().clear();
        });

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

        let (tx, rx) = bounded(1);
        self.pending.lock().insert(id, tx);

        // Hold the inner lock only for the write; the response arrives via the
        // reader thread, so slow calls don't serialize unrelated requests.
        let write_result = {
            let mut inner = self.inner.lock();
            if inner.child.is_none() {
                Err("Sidecar not running".to_string())
            } else {
                inner
                    .stdin
                    .as_mut()
                    .ok_or_else(|| "Sidecar stdin missing".to_string())
                    .and_then(|stdin| {
                        stdin
                            .write_all(request_str.as_bytes())
                            .map_err(|e| format!("Failed to write to sidecar: {}", e))?;
                        stdin
                            .flush()
                            .map_err(|e| format!("Failed to flush sidecar stdin: {}", e))
                    })
            }
        };
        if let Err(e) = write_result {
            self.pending.lock().remove(&id);
            return Err(e);
        }

        let response = match rx.recv_timeout(CALL_TIMEOUT) {
            Ok(response) => response,
            Err(RecvTimeoutError::Timeout) => {
                self.pending.lock().remove(&id);
                return Err(format!(
                    "Sidecar request '{}' timed out after {}s",
                    method,
                    CALL_TIMEOUT.as_secs()
                ));
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err("Sidecar exited before responding".to_string());
            }
        };

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
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.pending.lock().clear();
    }

    pub fn is_running(&self) -> bool {
        let mut inner = self.inner.lock();
        reap_if_dead(&mut inner, &self.pending);
        inner.child.is_some()
    }
}

/// Detect a child that exited on its own (crash, OOM) and clean up so callers
/// see "not running" instead of writing into a dead pipe forever.
fn reap_if_dead(inner: &mut Inner, pending: &PendingMap) {
    let dead = match inner.child.as_mut() {
        Some(child) => !matches!(child.try_wait(), Ok(None)),
        None => return,
    };
    if dead {
        inner.child = None;
        inner.stdin = None;
        pending.lock().clear();
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.stop();
    }
}

fn resolve_sidecar_script() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let cwd_candidate = std::env::current_dir()
            .map_err(|e| format!("Failed to read current dir: {}", e))?
            .join("sidecar/dist/index.cjs");
        if cwd_candidate.is_file() {
            return cwd_candidate
                .canonicalize()
                .map_err(|e| format!("Failed to resolve development sidecar script: {e}"));
        }
    }

    find_bundled_resource(std::path::Path::new("sidecar/dist/index.cjs")).ok_or_else(|| {
        "Unable to locate the packaged sidecar at sidecar/dist/index.cjs in the app resource directory"
            .to_string()
    })
}

fn resolve_node_binary() -> Result<PathBuf, String> {
    find_binary("node").ok_or_else(|| {
        if cfg!(debug_assertions) {
            "Unable to locate a Node.js binary for the sidecar in PATH, packaged resources, or development resources."
        } else {
            "Unable to locate the packaged Node.js binary in the app resource directory."
        }
        .to_string()
    })
}
