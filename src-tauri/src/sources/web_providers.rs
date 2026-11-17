//! Online providers running inside the app's own web view.
//!
//! iOS does not let an app start other programs, so the Node sidecar that
//! searches and resolves YouTube, SoundCloud and Bandcamp on the desktop
//! cannot run there. The same provider code is bundled for the web view
//! instead (`static/web-providers.js`, built from `sidecar/src/web.ts`). Rust
//! sends each request as a `providers:request` event and the page answers
//! with `providers_reply`. The page does its network requests through
//! `native_fetch`, so browser cross-origin rules do not apply, and YouTube's
//! player snippets are evaluated by `providers_eval` in an embedded engine
//! because the page's content security policy forbids `eval`.
//!
//! Set `MEWSIK_WEB_PROVIDERS=1` to use this path on the desktop for testing.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use crossbeam_channel::{bounded, RecvTimeoutError, Sender};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// True when providers must run in the web view instead of a child process.
pub fn enabled() -> bool {
    cfg!(any(target_os = "ios", target_os = "android"))
        || std::env::var_os("MEWSIK_WEB_PROVIDERS").is_some_and(|v| v != "0")
}

fn app() -> &'static OnceLock<AppHandle> {
    static APP: OnceLock<AppHandle> = OnceLock::new();
    &APP
}

type Reply = Result<Value, String>;

fn pending() -> &'static Mutex<HashMap<u64, Sender<Reply>>> {
    static PENDING: OnceLock<Mutex<HashMap<u64, Sender<Reply>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn set_app_handle(handle: AppHandle) {
    let _ = app().set(handle);
}

#[derive(Serialize, Clone)]
struct ProviderRequest<'a> {
    id: u64,
    method: &'a str,
    params: &'a Value,
}

/// Sends one request to the page and waits for its answer.
pub fn call(id: u64, method: &str, params: &Value, timeout: Duration) -> Reply {
    let app = app()
        .get()
        .ok_or_else(|| "Online search is still starting".to_string())?;
    let (tx, rx) = bounded(1);
    pending().lock().insert(id, tx);
    if let Err(err) = app.emit("providers:request", ProviderRequest { id, method, params }) {
        pending().lock().remove(&id);
        return Err(format!("Could not reach online search: {err}"));
    }
    match rx.recv_timeout(timeout) {
        Ok(reply) => reply,
        Err(RecvTimeoutError::Timeout) => {
            pending().lock().remove(&id);
            Err(format!(
                "Online search request '{method}' timed out after {}s",
                timeout.as_secs()
            ))
        }
        Err(RecvTimeoutError::Disconnected) => Err("Online search stopped".to_string()),
    }
}

#[tauri::command]
pub async fn providers_reply(
    id: u64,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    if let Some(tx) = pending().lock().remove(&id) {
        let _ = tx.send(match error {
            Some(message) => Err(message),
            None => Ok(result.unwrap_or(Value::Null)),
        });
    }
    Ok(())
}

/// Runs one self-contained script (YouTube's signature and `n` functions,
/// which end in `return ...`) and returns its result as JSON.
#[tauri::command]
pub async fn providers_eval(code: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || eval_script(&code))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn eval_script(code: &str) -> Result<Value, String> {
    use boa_engine::{Context, Source};
    let mut context = Context::default();
    let source = format!("JSON.stringify((function() {{\n{code}\n}})())");
    let value = context
        .eval(Source::from_bytes(source.as_bytes()))
        .map_err(|e| format!("Player script failed: {e}"))?;
    if value.is_undefined() {
        return Ok(Value::Null);
    }
    let text = value
        .to_string(&mut context)
        .map_err(|e| format!("Player script failed: {e}"))?
        .to_std_string_escaped();
    serde_json::from_str(&text).map_err(|e| format!("Player script returned bad JSON: {e}"))
}

#[derive(Deserialize)]
pub struct NativeRequest {
    url: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    headers: Vec<(String, String)>,
    /// Base64 request body.
    #[serde(default)]
    body: Option<String>,
}

#[derive(Serialize)]
pub struct NativeResponse {
    status: u16,
    status_text: String,
    url: String,
    headers: Vec<(String, String)>,
    /// Base64 response body.
    body: String,
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default()
    })
}

/// `fetch` for the provider page, done by the app instead of the web view so
/// any site can be reached and any header sent.
#[tauri::command]
pub async fn native_fetch(request: NativeRequest) -> Result<NativeResponse, String> {
    let url = reqwest::Url::parse(&request.url).map_err(|e| format!("Bad URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("Unsupported URL scheme: {}", url.scheme()));
    }
    let method = request
        .method
        .as_deref()
        .unwrap_or("GET")
        .parse::<reqwest::Method>()
        .map_err(|e| e.to_string())?;
    let mut builder = client().request(method, url);
    for (name, value) in &request.headers {
        // reqwest sets these itself, and asking for compression it will not
        // undo would hand the page compressed bytes.
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "host" | "content-length" | "connection" | "accept-encoding"
        ) {
            continue;
        }
        builder = builder.header(name, value);
    }
    if let Some(body) = request.body {
        builder = builder.body(B64.decode(body).map_err(|e| e.to_string())?);
    }
    let response = builder.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let url = response.url().to_string();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(k, v)| Some((k.as_str().to_string(), v.to_str().ok()?.to_string())))
        .collect();
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    Ok(NativeResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        url,
        headers,
        body: B64.encode(bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluates_player_snippets() {
        let value = eval_script(
            "var a = function(s){ return s.split('').reverse().join(''); };\n\
             return { sig: a('cba'), n: [1,2].map(function(x){ return x * 2; }) };",
        )
        .unwrap();
        assert_eq!(value, serde_json::json!({ "sig": "abc", "n": [2, 4] }));
        assert_eq!(eval_script("return undefined;").unwrap(), Value::Null);
        assert!(eval_script("throw new Error('boom')").is_err());
    }
}
