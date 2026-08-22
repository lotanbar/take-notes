use base64::{engine::general_purpose, Engine as _};
use notify::RecommendedWatcher;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

fn watches() -> &'static Mutex<HashMap<String, Debouncer<RecommendedWatcher>>> {
    static WATCHES: OnceLock<Mutex<HashMap<String, Debouncer<RecommendedWatcher>>>> =
        OnceLock::new();
    WATCHES.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentChangedPayload {
    watch_id: String,
    data_b64: String,
    size: u64,
}

// Word (and most office apps) save via delete+rename rather than an in-place
// write, so the file can be transiently missing or locked right after the
// debounced event fires. A short retry window rides that out.
fn read_with_retry(path: &Path) -> Option<Vec<u8>> {
    for attempt in 0..5 {
        match std::fs::read(path) {
            Ok(bytes) => return Some(bytes),
            Err(_) if attempt < 4 => thread::sleep(Duration::from_millis(150)),
            Err(_) => return None,
        }
    }
    None
}

#[tauri::command]
pub fn start_attachment_watch(
    app: AppHandle,
    watch_id: String,
    path: String,
) -> Result<(), String> {
    watches().lock().unwrap().remove(&watch_id);

    let target_path = PathBuf::from(&path);
    let watch_dir = target_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| target_path.clone());

    let emit_target = target_path.clone();
    let emit_watch_id = watch_id.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        move |res: DebounceEventResult| {
            let events = match res {
                Ok(events) => events,
                Err(_) => return,
            };
            // Each attachment gets its own private temp directory. React to any
            // event in that directory: Office applications commonly save through
            // a temporary file followed by a rename, so the event path is not
            // guaranteed to equal the final target even though its bytes changed.
            if events.is_empty() {
                return;
            }
            let Some(bytes) = read_with_retry(&emit_target) else {
                return;
            };
            let data_b64 = general_purpose::STANDARD.encode(&bytes);
            let _ = app.emit(
                "attachment-file-changed",
                AttachmentChangedPayload {
                    watch_id: emit_watch_id.clone(),
                    data_b64,
                    size: bytes.len() as u64,
                },
            );
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(&watch_dir, notify::RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    watches().lock().unwrap().insert(watch_id, debouncer);
    Ok(())
}

#[tauri::command]
pub fn stop_attachment_watch(watch_id: String) -> Result<(), String> {
    watches().lock().unwrap().remove(&watch_id);
    Ok(())
}

#[tauri::command]
pub fn stop_all_attachment_watches() -> Result<(), String> {
    watches().lock().unwrap().clear();
    Ok(())
}
