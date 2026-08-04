// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(exit_code) = vault_notes_app_lib::run_image_worker_from_args() {
        std::process::exit(exit_code);
    }
    vault_notes_app_lib::run()
}
