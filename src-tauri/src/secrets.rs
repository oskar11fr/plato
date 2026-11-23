//! API keys in the OS keychain (macOS Keychain, Windows Credential Manager,
//! Secret Service on Linux). Keys are never written to the workspace and
//! never sent to the web view.

use keyring::Entry;

const SERVICE: &str = "se.oskar.plato";

fn entry(provider: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, provider).map_err(|e| e.to_string())
}

/// Env var checked when the keychain has no key, handy during development.
fn env_var(provider: &str) -> Option<String> {
    let name = format!("{}_API_KEY", provider.to_uppercase());
    std::env::var(name).ok().filter(|k| !k.trim().is_empty())
}

pub fn get_api_key(provider: &str) -> Option<String> {
    entry(provider).ok().and_then(|e| e.get_password().ok()).or_else(|| env_var(provider))
}

#[tauri::command]
pub async fn set_api_key(provider: String, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("API key is empty".into());
    }
    entry(&provider)?.set_password(key).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn has_api_key(provider: String) -> bool {
    get_api_key(&provider).is_some()
}

#[tauri::command]
pub async fn delete_api_key(provider: String) -> Result<(), String> {
    match entry(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
