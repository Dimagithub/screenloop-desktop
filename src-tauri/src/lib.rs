mod recorder;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(recorder::Recorder::default())
        .invoke_handler(tauri::generate_handler![
            recorder::list_devices,
            recorder::start_recording,
            recorder::stop_recording,
            recorder::upload_file,
            recorder::open_controls,
            recorder::close_controls
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
