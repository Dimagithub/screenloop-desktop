mod auth;
mod recorder;
mod sysaudio;

use tauri::Manager;

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
            recorder::raise_controls,
            recorder::close_controls
        ])
        // Closing the main window quits the app even if the floating bar is open.
        .on_window_event(|w, e| {
            // controls gone => never leave a click-capturing overlay behind
            if w.label() == "controls" && matches!(e, tauri::WindowEvent::Destroyed) {
                if let Some(o) = w.app_handle().get_webview_window("overlay") {
                    let _ = o.close();
                }
            }
            if w.label() == "main" && matches!(e, tauri::WindowEvent::Destroyed) {
                w.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Never leave ffmpeg running after exit: a running ffmpeg.exe blocks updates on Windows.
        .run(|app, ev| {
            if let tauri::RunEvent::Exit = ev {
                recorder::stop_on_exit(app);
            }
        });
}
