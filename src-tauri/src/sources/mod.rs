pub mod orchestrator;
pub mod provider;
#[cfg(not(target_os = "ios"))]
pub mod sidecar;
#[cfg(not(target_os = "ios"))]
pub mod sidecar_manager;
pub mod stream_cache;
#[cfg(not(target_os = "ios"))]
pub mod youtube;

#[cfg(not(target_os = "ios"))]
pub use sidecar_manager::SidecarManager;
pub use stream_cache::StreamCache;

// iOS stub: the Node.js sidecar can't run on iOS. We keep the type so command
// signatures still compile; calls into it will fail, but on iOS we don't
// register sidecar-dependent commands (see lib.rs invoke_handler) and remote
// sources (YouTube/SoundCloud/Bandcamp) aren't surfaced. State is still
// managed so anything taking State<Arc<SidecarManager>> resolves at runtime.
#[cfg(target_os = "ios")]
pub mod sidecar_manager_ios {
    use serde_json::Value;

    pub struct SidecarManager;

    impl SidecarManager {
        pub fn new() -> Self {
            Self
        }
        pub fn start(&self) -> Result<(), String> {
            Err("Sidecar is not available on iOS".to_string())
        }
        pub fn stop(&self) {}
        pub fn is_running(&self) -> bool {
            false
        }
        pub fn call(&self, _method: &str, _payload: Value) -> Result<Value, String> {
            Err("Sidecar is not available on iOS".to_string())
        }
    }
}

#[cfg(target_os = "ios")]
pub use sidecar_manager_ios::SidecarManager;
