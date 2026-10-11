//! macOS recorder: drives an ffmpeg child (avfoundation) that writes playable MP4 parts
//! plus a matching audio-only WebM/Opus part for transcripts.
// ponytail: system ffmpeg + avfoundation for the spike; swap for ScreenCaptureKit
// (excludes our own windows, system audio) and a bundled ffmpeg sidecar before shipping.
use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Instant;
use tauri::{Manager, State};

#[derive(Default)]
pub struct Recorder(Mutex<Option<Active>>);

struct Active {
    child: Child,
    dir: PathBuf,
    started: Instant,
}

#[derive(Serialize)]
pub struct Device {
    index: String,
    name: String,
}

#[derive(Serialize)]
pub struct Devices {
    screens: Vec<Device>,
    mics: Vec<Device>,
}

#[derive(Serialize)]
pub struct Part {
    path: String,
    audio_path: String,
    start_seconds: u32,
    duration_seconds: u32,
    size_bytes: u64,
}

#[derive(Serialize)]
pub struct Finished {
    parts: Vec<Part>,
    duration_seconds: u32,
}

const FFMPEG: &str = "ffmpeg"; // ponytail: PATH lookup; bundle as a Tauri sidecar

#[tauri::command]
pub fn list_devices() -> Result<Devices, String> {
    let out = Command::new(FFMPEG)
        .args(["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""])
        .output()
        .map_err(|e| format!("ffmpeg not found: {e}"))?;
    let text = String::from_utf8_lossy(&out.stderr);
    let (mut screens, mut mics, mut audio) = (vec![], vec![], false);
    for line in text.lines() {
        if line.contains("audio devices") {
            audio = true;
            continue;
        }
        let Some(rest) = line.split("] [").nth(1) else { continue };
        let Some((idx, name)) = rest.split_once("] ") else { continue };
        let d = Device { index: idx.into(), name: name.into() };
        if audio {
            mics.push(d);
        } else if name.starts_with("Capture screen") {
            screens.push(d);
        }
    }
    Ok(Devices { screens, mics })
}

fn bitrate(h: u32, fps: u32) -> u32 {
    // Same rule as the web recorder: pixels * fps * bpp, clamped 250k..2.5M.
    ((h as f64 * h as f64 * 16.0 / 9.0 * fps as f64 * 0.07) as u32).clamp(250_000, 2_500_000)
}

#[tauri::command]
pub fn start_recording(
    app: tauri::AppHandle,
    state: State<Recorder>,
    screen: String,
    mic: Option<String>,
    height: u32,
    fps: u32,
    chunk_seconds: u32,
) -> Result<String, String> {
    let mut slot = state.0.lock().unwrap();
    if slot.is_some() {
        return Err("Already recording".into());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("recordings").join(uuid());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let input = format!("{}:{}", screen, mic.as_deref().unwrap_or("none"));
    let seg = chunk_seconds.max(120).to_string();
    let b = bitrate(height, fps);
    let mut cmd = Command::new(FFMPEG);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-f", "avfoundation", "-capture_cursor", "1", "-framerate", &fps.to_string(), "-i", &input]);
    // Output 1: video(+mic) parts.
    cmd.args(["-map", "0:v", "-vf", &format!("scale=-2:{height}"), "-c:v", "libx264", "-preset", "veryfast", "-b:v", &b.to_string(), "-pix_fmt", "yuv420p", "-g", &(fps * 2).to_string(), "-force_key_frames", &format!("expr:gte(t,n_forced*{seg})")]);
    if mic.is_some() {
        cmd.args(["-map", "0:a", "-c:a", "aac", "-b:a", "64k"]);
    }
    cmd.args(["-f", "segment", "-segment_time", &seg, "-segment_format", "mp4", "-reset_timestamps", "1", "-segment_start_number", "1"])
        .arg(dir.join("p%d.mp4"));
    // Output 2: audio-only parts for the transcript pipeline.
    if mic.is_some() {
        cmd.args(["-map", "0:a", "-vn", "-c:a", "libopus", "-b:a", "32k", "-f", "segment", "-segment_time", &seg, "-segment_format", "webm", "-reset_timestamps", "1", "-segment_start_number", "1"])
            .arg(dir.join("p%d.audio.webm"));
    }
    let child = cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().map_err(|e| format!("ffmpeg: {e}"))?;
    *slot = Some(Active { child, dir: dir.clone(), started: Instant::now() });
    Ok(dir.to_string_lossy().into())
}

#[tauri::command]
pub fn stop_recording(state: State<Recorder>, chunk_seconds: u32) -> Result<Finished, String> {
    let Active { mut child, dir, started } = state.0.lock().unwrap().take().ok_or("Not recording")?;
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(b"q"); // graceful: lets ffmpeg finalize the MP4 moov atom
    }
    child.wait().map_err(|e| e.to_string())?;
    let total = started.elapsed().as_secs() as u32;
    let seg = chunk_seconds.max(120);
    let mut parts = vec![];
    for n in 1.. {
        let path = dir.join(format!("p{n}.mp4"));
        let Ok(meta) = std::fs::metadata(&path) else { break };
        let start = (n - 1) * seg;
        let audio = dir.join(format!("p{n}.audio.webm"));
        parts.push(Part {
            path: path.to_string_lossy().into(),
            audio_path: if audio.exists() { audio.to_string_lossy().into() } else { String::new() },
            start_seconds: start,
            duration_seconds: total.saturating_sub(start).min(seg),
            size_bytes: meta.len(),
        });
    }
    if parts.is_empty() {
        return Err("Nothing was recorded. Check Screen Recording permission for ScreenLoop.".into());
    }
    Ok(Finished { parts, duration_seconds: total })
}

fn uuid() -> String {
    format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())
}

/// PUT a local file to a Supabase signed upload URL (streamed, not buffered).
#[tauri::command]
pub async fn upload_file(path: String, url: String, content_type: String) -> Result<(), String> {
    let file = tokio::fs::File::open(&path).await.map_err(|e| e.to_string())?;
    let len = file.metadata().await.map_err(|e| e.to_string())?.len();
    let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(file));
    let res = reqwest::Client::new()
        .put(url)
        .header("content-type", content_type)
        .header("content-length", len)
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Upload failed ({})", res.status()));
    }
    Ok(())
}
