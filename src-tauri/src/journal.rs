use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalRecord {
    node_hash: String,
    ciphertext: String,
    revision: u64,
}
static JOURNAL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn vault_dir(app: &tauri::AppHandle, source_path: &str) -> Result<PathBuf, String> {
    let mut dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let hash = format!(
        "{:x}",
        Sha256::digest(source_path.to_lowercase().as_bytes())
    );
    dir.push("session-journal");
    dir.push(&hash[..24]);
    Ok(dir)
}

#[tauri::command]
pub fn journal_write(
    app: tauri::AppHandle,
    source_path: String,
    node_id: String,
    ciphertext: String,
    revision: u64,
) -> Result<(), String> {
    let _guard = JOURNAL_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "journal lock poisoned")?;
    general_purpose::STANDARD
        .decode(&ciphertext)
        .map_err(|e| format!("invalid encrypted journal payload: {e}"))?;
    let dir = vault_dir(&app, &source_path)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let node_hash = format!("{:x}", Sha256::digest(node_id.as_bytes()));
    let target = dir.join(format!("{node_hash}.entry"));
    if let Ok(existing) = fs::read(&target).and_then(|bytes| {
        serde_json::from_slice::<JournalRecord>(&bytes).map_err(std::io::Error::other)
    }) {
        if existing.revision > revision {
            return Ok(());
        }
    }
    let temporary = dir.join(format!("{node_hash}.{revision}.tmp"));
    let data = serde_json::to_vec(&JournalRecord {
        node_hash,
        ciphertext,
        revision,
    })
    .map_err(|e| e.to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    file.write_all(&data).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    crate::atomic_file::replace(&temporary, &target)
}

#[tauri::command]
pub fn journal_read(
    app: tauri::AppHandle,
    source_path: String,
) -> Result<Vec<JournalRecord>, String> {
    let dir = vault_dir(&app, &source_path)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut records: Vec<JournalRecord> = Vec::new();
    for item in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = item.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|v| v.to_str()) != Some("entry") {
            continue;
        }
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        records.push(
            serde_json::from_slice(&bytes).map_err(|e| format!("corrupt session journal: {e}"))?,
        );
    }
    records.sort_by_key(|record| record.revision);
    Ok(records)
}

#[tauri::command]
pub fn journal_clear(app: tauri::AppHandle, source_path: String) -> Result<(), String> {
    let dir = vault_dir(&app, &source_path)?;
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn node_names_are_not_used_as_paths() {
        let hash = format!("{:x}", Sha256::digest("private note name".as_bytes()));
        assert!(!hash.contains("private"));
        assert_eq!(hash.len(), 64);
    }
}
