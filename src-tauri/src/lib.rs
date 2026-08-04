mod attachment_watch;
mod attachments;
mod vault;
mod history;
mod clipboard;

use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            vault::open_vault_file,
            vault::vault_append_blob,
            vault::vault_write_header,
            vault::read_vault_blob,
            vault::vault_create_fresh,
            vault::backup_vault_file,
            vault::finalize_vault_write,
            vault::vault_file_exists,
            vault::copy_file_atomic,
            vault::resolve_live_vault_path,
            history::history_status,
            history::history_initialize,
            history::history_checkpoint,
            clipboard::read_native_clipboard,
            attachments::write_temp_attachment,
            attachments::save_attachment_to_path,
            attachment_watch::start_attachment_watch,
            attachment_watch::stop_attachment_watch,
            attachment_watch::stop_all_attachment_watches
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
