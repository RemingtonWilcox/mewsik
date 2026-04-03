use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};

const SERVICE_NAME: &str = "app.mewsik";

pub fn store_credential(key: &str, value: &str) -> Result<(), String> {
    // Try to delete existing first
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
    delete_generic_password(SERVICE_NAME, key).map_err(|e| format!("Keychain delete error: {}", e))
}
