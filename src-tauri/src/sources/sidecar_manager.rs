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

type PendingMap = Arc<Mutex<HashMap<u64, PendingRequest>>>;

struct PendingRequest {
    generation: u64,
    response_tx: Sender<JsonRpcResponse>,
}

pub struct SidecarManager {
    inner: Arc<Mutex<Inner>>,
    pending: PendingMap,
    request_id: AtomicU64,
}

struct Inner {
    child: Option<Child>,
    stdin: Option<BufWriter<ChildStdin>>,
    generation: u64,
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
                generation: 0,
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

        let script_path = child_argument_path(&resolve_sidecar_script()?);
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
        let generation = next_generation(inner.generation);
        let child_id = child.id();

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
        inner.generation = generation;

        log::info!(
            target: "mewsik::sidecar",
            "spawned sidecar generation {} as pid {} (node: {}, script: {})",
            generation,
            child_id,
            node_binary.display(),
            script_path.display()
        );

        // Route responses to waiting callers by request id. The thread exits
        // when the child's stdout closes, failing only calls issued to that
        // process generation. An older reader must never clear requests for a
        // replacement child that started before this thread observed EOF.
        let pending = Arc::clone(&self.pending);
        let lifecycle = Arc::clone(&self.inner);
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
                        let waiter = response
                            .id
                            .and_then(|id| take_pending_request(&pending, id, generation));
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

            let active_reader = {
                let mut inner = lifecycle.lock();
                if inner.generation != generation {
                    false
                } else {
                    inner.stdin.take();
                    if let Some(mut child) = inner.child.take() {
                        match child.try_wait() {
                            Ok(Some(status)) => log::warn!(
                                target: "mewsik::sidecar",
                                "sidecar generation {} pid {} exited: {}",
                                generation,
                                child.id(),
                                status
                            ),
                            Ok(None) => {
                                log::warn!(
                                    target: "mewsik::sidecar",
                                    "sidecar generation {} pid {} closed stdout while still running; terminating it",
                                    generation,
                                    child.id()
                                );
                                let _ = child.kill();
                                let _ = child.wait();
                            }
                            Err(error) => log::warn!(
                                target: "mewsik::sidecar",
                                "could not read exit status for sidecar generation {} pid {}: {}",
                                generation,
                                child.id(),
                                error
                            ),
                        }
                    }
                    true
                }
            };

            let cleared = clear_pending_generation(&pending, generation);
            if active_reader {
                log::warn!(
                    target: "mewsik::sidecar",
                    "sidecar generation {} reader closed; failed {} pending request(s)",
                    generation,
                    cleared
                );
            } else {
                log::debug!(
                    target: "mewsik::sidecar",
                    "stale sidecar reader for generation {} closed; removed {} matching pending request(s) without touching the active generation",
                    generation,
                    cleared
                );
            }
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

        // Hold the inner lock only for the write; the response arrives via the
        // reader thread, so slow calls don't serialize unrelated requests.
        let (generation, write_result) = {
            let mut inner = self.inner.lock();
            if inner.child.is_none() {
                (inner.generation, Err("Sidecar not running".to_string()))
            } else {
                let generation = inner.generation;
                self.pending.lock().insert(
                    id,
                    PendingRequest {
                        generation,
                        response_tx: tx,
                    },
                );
                let result = inner
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
                    });
                (generation, result)
            }
        };
        if let Err(e) = write_result {
            remove_pending_request(&self.pending, id, generation);
            return Err(e);
        }

        let response = match rx.recv_timeout(CALL_TIMEOUT) {
            Ok(response) => response,
            Err(RecvTimeoutError::Timeout) => {
                remove_pending_request(&self.pending, id, generation);
                return Err(format!(
                    "Sidecar request '{}' in generation {} timed out after {}s",
                    method,
                    generation,
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
        let generation = inner.generation;
        inner.stdin.take();
        if let Some(mut child) = inner.child.take() {
            let child_id = child.id();
            let _ = child.kill();
            match child.wait() {
                Ok(status) => log::info!(
                    target: "mewsik::sidecar",
                    "stopped sidecar generation {} pid {}: {}",
                    generation,
                    child_id,
                    status
                ),
                Err(error) => log::warn!(
                    target: "mewsik::sidecar",
                    "failed waiting for sidecar generation {} pid {} to stop: {}",
                    generation,
                    child_id,
                    error
                ),
            }
        }
        clear_pending_generation(&self.pending, generation);
    }

    pub fn restart(&self) -> Result<(), String> {
        log::warn!(target: "mewsik::sidecar", "restarting sidecar on request");
        self.stop();
        self.start()
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
    let generation = inner.generation;
    let Some(child) = inner.child.as_mut() else {
        return;
    };

    match child.try_wait() {
        Ok(None) => {}
        Ok(Some(status)) => {
            log::warn!(
                target: "mewsik::sidecar",
                "reaped exited sidecar generation {} pid {}: {}",
                generation,
                child.id(),
                status
            );
            inner.child = None;
            inner.stdin = None;
            clear_pending_generation(pending, generation);
        }
        Err(error) => {
            // A transient try_wait failure is not proof that the child died.
            // Keep the handles intact so a healthy process is not orphaned.
            log::warn!(
                target: "mewsik::sidecar",
                "could not inspect sidecar generation {} pid {}: {}",
                generation,
                child.id(),
                error
            );
        }
    }
}

fn take_pending_request(
    pending: &PendingMap,
    id: u64,
    generation: u64,
) -> Option<Sender<JsonRpcResponse>> {
    let mut requests = pending.lock();
    if requests
        .get(&id)
        .is_some_and(|request| request.generation == generation)
    {
        requests.remove(&id).map(|request| request.response_tx)
    } else {
        None
    }
}

fn remove_pending_request(pending: &PendingMap, id: u64, generation: u64) -> bool {
    take_pending_request(pending, id, generation).is_some()
}

fn clear_pending_generation(pending: &PendingMap, generation: u64) -> usize {
    let mut requests = pending.lock();
    let before = requests.len();
    requests.retain(|_, request| request.generation != generation);
    before - requests.len()
}

fn next_generation(current: u64) -> u64 {
    current.wrapping_add(1).max(1)
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.stop();
    }
}

fn resolve_sidecar_script() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let cwd =
            std::env::current_dir().map_err(|e| format!("Failed to read current dir: {}", e))?;
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        for candidate in [
            cwd.join("sidecar/dist/index.cjs"),
            manifest_dir.join("../sidecar/dist/index.cjs"),
        ] {
            if candidate.is_file() {
                return candidate
                    .canonicalize()
                    .map_err(|e| format!("Failed to resolve development sidecar script: {e}"));
            }
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

fn child_argument_path(path: &std::path::Path) -> PathBuf {
    #[cfg(windows)]
    {
        // std::fs::canonicalize returns a verbatim `\\?\C:\...` path on
        // Windows. That form is correct for filesystem validation, but Node
        // interprets it as a malformed entry script and exits with EISDIR on
        // `C:`. Simplify only after canonicalization/security checks finish.
        dunce::simplified(path).to_path_buf()
    }

    #[cfg(not(windows))]
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::{
        child_argument_path, clear_pending_generation, next_generation, take_pending_request,
        JsonRpcResponse, PendingMap, PendingRequest,
    };
    use crossbeam_channel::{bounded, TryRecvError};
    use parking_lot::Mutex;
    use std::collections::HashMap;
    use std::sync::Arc;

    fn pending_map() -> PendingMap {
        Arc::new(Mutex::new(HashMap::new()))
    }

    #[test]
    fn stale_reader_cannot_take_new_generation_response_waiter() {
        let pending = pending_map();
        let (response_tx, response_rx) = bounded::<JsonRpcResponse>(1);
        pending.lock().insert(
            41,
            PendingRequest {
                generation: 2,
                response_tx,
            },
        );

        assert!(take_pending_request(&pending, 41, 1).is_none());
        assert!(pending.lock().contains_key(&41));
        assert!(matches!(response_rx.try_recv(), Err(TryRecvError::Empty)));

        assert!(take_pending_request(&pending, 41, 2).is_some());
        assert!(!pending.lock().contains_key(&41));
        assert!(matches!(
            response_rx.try_recv(),
            Err(TryRecvError::Disconnected)
        ));
    }

    #[test]
    fn generation_cleanup_preserves_replacement_process_waiters() {
        let pending = pending_map();
        let (old_tx, old_rx) = bounded::<JsonRpcResponse>(1);
        let (new_tx, new_rx) = bounded::<JsonRpcResponse>(1);
        {
            let mut requests = pending.lock();
            requests.insert(
                10,
                PendingRequest {
                    generation: 7,
                    response_tx: old_tx,
                },
            );
            requests.insert(
                11,
                PendingRequest {
                    generation: 8,
                    response_tx: new_tx,
                },
            );
        }

        assert_eq!(clear_pending_generation(&pending, 7), 1);
        assert!(!pending.lock().contains_key(&10));
        assert!(pending.lock().contains_key(&11));
        assert!(matches!(old_rx.try_recv(), Err(TryRecvError::Disconnected)));
        assert!(matches!(new_rx.try_recv(), Err(TryRecvError::Empty)));
    }

    #[test]
    fn process_generations_never_use_zero() {
        assert_eq!(next_generation(0), 1);
        assert_eq!(next_generation(9), 10);
        assert_eq!(next_generation(u64::MAX), 1);
    }

    #[cfg(windows)]
    #[test]
    fn node_entry_script_uses_a_normal_windows_path() {
        let simplified = child_argument_path(std::path::Path::new(
            r"\\?\C:\Users\tester\mewsik\sidecar\dist\index.cjs",
        ));
        assert_eq!(
            simplified,
            std::path::PathBuf::from(r"C:\Users\tester\mewsik\sidecar\dist\index.cjs")
        );
    }

    #[test]
    #[ignore = "explicit live sidecar restart smoke test"]
    fn live_replacement_generation_handles_the_exact_search() {
        use serde_json::json;

        let manager = super::SidecarManager::new();
        manager.start().expect("start first sidecar generation");
        let first = manager
            .call(
                "youtube.search",
                json!({ "query": "Ella Langley Choosin' Texas", "page": 0 }),
            )
            .expect("first generation search");
        assert!(
            first
                .get("items")
                .and_then(|items| items.as_array())
                .is_some_and(|items| !items.is_empty()),
            "first generation should return YouTube results"
        );

        manager.restart().expect("restart sidecar generation");
        let replacement = manager
            .call(
                "soundcloud.search",
                json!({ "query": "Ella Langley Choosin' Texas", "page": 0 }),
            )
            .expect("replacement generation search");
        assert!(
            replacement
                .get("items")
                .and_then(|items| items.as_array())
                .is_some_and(|items| !items.is_empty()),
            "replacement generation should return SoundCloud results"
        );
        manager.stop();
    }
}
