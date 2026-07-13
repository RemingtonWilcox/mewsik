#[cfg(target_os = "macos")]
mod imp {
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    const SERVICE_NAME: &str = "app.mewsik";

    pub fn store_credential(key: &str, value: &str) -> Result<(), String> {
        let _ = delete_generic_password(SERVICE_NAME, key);
        set_generic_password(SERVICE_NAME, key, value.as_bytes())
            .map_err(|e| format!("Keychain store error: {}", e))
    }

    pub fn get_credential(key: &str) -> Result<Option<String>, String> {
        match get_generic_password(SERVICE_NAME, key) {
            Ok(bytes) => {
                let value = String::from_utf8(bytes.to_vec())
                    .map_err(|e| format!("UTF-8 decode error: {}", e))?;
                Ok(Some(value))
            }
            Err(_) => Ok(None),
        }
    }

    pub fn delete_credential(key: &str) -> Result<(), String> {
        delete_generic_password(SERVICE_NAME, key)
            .map_err(|e| format!("Keychain delete error: {}", e))
    }
}

// Non-macOS stub: secure credential storage isn't wired up yet on Windows/Linux.
// The Rust build needs these symbols to exist; calling them returns an error so
// any feature that depends on stored credentials surfaces as a user-visible failure
// rather than silently storing secrets in plaintext.
#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn store_credential(_key: &str, _value: &str) -> Result<(), String> {
        Err("Secure credential storage is not implemented on this platform".to_string())
    }

    pub fn get_credential(_key: &str) -> Result<Option<String>, String> {
        Ok(None)
    }

    pub fn delete_credential(_key: &str) -> Result<(), String> {
        Ok(())
    }
}

// Not consumed by any feature yet (intended for upcoming credential needs,
// e.g. Last.fm API keys); kept so the cross-platform API surface stays compiled.
#[allow(unused_imports)]
pub use imp::{delete_credential, get_credential, store_credential};
