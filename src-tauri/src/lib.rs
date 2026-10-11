mod auth;
mod recorder;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(recorder::Recorder::default())
        .invoke_handler(tauri::generate_handler![
            auth::start_auth_listener,
            recorder::list_devices,
            recorder::start_recording,
            recorder::pause_recording,
            recorder::resume_recording,
            recorder::set_mute,
            recorder::recording_state,
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
