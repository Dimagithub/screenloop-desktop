mod auth;
mod recorder;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch (e.g. from a screenloop:// link on Windows) hands its link to the running app.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(recorder::Recorder::default())
        .invoke_handler(tauri::generate_handler![
            auth::start_auth_listener,
            auth::secret_get,
            auth::secret_set,
            auth::secret_remove,
            recorder::list_devices,
            recorder::start_recording,
            recorder::pause_recording,
            recorder::resume_recording,
            recorder::set_mute,
            recorder::recording_state,
            recorder::completed_parts,
            recorder::save_manifest,
            recorder::list_unsent,
            recorder::delete_session,
            recorder::recover_parts,
            recorder::stop_recording,
            recorder::screenshot,
            recorder::upload_file,
            recorder::file_size,
            recorder::extract_audio_segments,
            recorder::open_controls,
            recorder::set_controls_height,
            recorder::open_overlay,
            recorder::set_overlay_interactive,
            recorder::close_controls
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
