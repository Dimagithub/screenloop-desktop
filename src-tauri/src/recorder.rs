//! macOS recorder: drives an ffmpeg child (avfoundation) that writes playable MP4 parts
//! plus a matching audio-only WebM/Opus part for transcripts.
// ponytail: ffmpeg + avfoundation; swap for ScreenCaptureKit (excludes our own windows,
// system audio) when the floating controls land.
use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Instant;
use tauri::{Manager, State};


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


/// Bundled LGPL ffmpeg sidecar (next to the app binary); falls back to PATH when running from source.
fn ffmpeg() -> std::path::PathBuf {
    let bundled = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" })));
    bundled.filter(|p| p.exists()).unwrap_or_else(|| "ffmpeg".into())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn list_devices(_app: tauri::AppHandle) -> Result<Devices, String> {
    let out = hidden(Command::new(ffmpeg()))
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

// Windows: monitors come from Tauri (index = DXGI output index for ddagrab), mics from dshow.
#[cfg(windows)]
#[tauri::command]
pub fn list_devices(app: tauri::AppHandle) -> Result<Devices, String> {
    let screens = app
        .available_monitors()
        .map_err(|e| e.to_string())?
        .iter()
        .enumerate()
        .map(|(i, m)| Device { index: i.to_string(), name: format!("Display {} ({}x{})", i + 1, m.size().width, m.size().height) })
        .collect();
    let out = hidden(Command::new(ffmpeg()))
        .args(["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"])
        .output()
        .map_err(|e| format!("ffmpeg not found: {e}"))?;
    let text = String::from_utf8_lossy(&out.stderr);
    // Lines look like:  [dshow @ ...] "Microphone (Realtek)" (audio)
    let mics = text
        .lines()
        .filter(|l| l.trim_end().ends_with("(audio)"))
        .filter_map(|l| l.split('"').nth(1))
        .map(|n| Device { index: n.into(), name: n.into() })
        .collect();
    Ok(Devices { screens, mics })
}

/// No flashing console window when spawning ffmpeg from the GUI app on Windows.
fn hidden(#[allow(unused_mut)] mut c: Command) -> Command {
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut c, 0x0800_0000);
    c
}

fn bitrate(h: u32, fps: u32) -> u32 {
    // Same rule as the web recorder: pixels * fps * bpp, clamped 250k..2.5M.
    ((h as f64 * h as f64 * 16.0 / 9.0 * fps as f64 * 0.07) as u32).clamp(250_000, 2_500_000)
}

// ---- Session engine -------------------------------------------------------------------------
// ffmpeg cannot pause, so a recording is a list of "runs". Pause/resume and mute/unmute end the
// current ffmpeg and start a new one that continues the part numbering. Part start times are on
// the session clock (paused time excluded), matching the web recorder.

#[derive(Default)]
pub struct Recorder(Mutex<Option<Session>>);

struct Session {
    dir: PathBuf,
    screen: String,
    mic: Option<String>,
    height: u32,
    fps: u32,
    seg: u32,
    muted: bool,
    paused: bool,
    next_part: u32,
    clock: f64, // seconds recorded in finished runs
    runs: Vec<Run>,
    cur: Option<Cur>,
}

struct Run {
    first_part: u32,
    start: f64,
    len: f64,
    audio: bool,
}

struct Cur {
    child: Child,
    started: Instant,
    first_part: u32,
    audio: bool,
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

#[derive(Serialize)]
pub struct State_ {
    elapsed: f64,
    paused: bool,
    muted: bool,
}

impl Session {
    fn elapsed(&self) -> f64 {
        self.clock + self.cur.as_ref().map_or(0.0, |c| c.started.elapsed().as_secs_f64())
    }

    fn begin_run(&mut self) -> Result<(), String> {
        let audio = self.mic.is_some() && !self.muted;
        let seg = self.seg.to_string();
        let (height, fps) = (self.height, self.fps);
        let b = bitrate(height, fps);
        let mic = if audio { self.mic.clone() } else { None };
        let mut cmd = hidden(Command::new(ffmpeg()));
        cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
        let (audio_in, vf, venc): (usize, String, Vec<String>);
        #[cfg(target_os = "macos")]
        {
            let input = format!("{}:{}", self.screen, mic.as_deref().unwrap_or("none"));
            cmd.args(["-f", "avfoundation", "-capture_cursor", "1", "-framerate", &fps.to_string(), "-i", &input]);
            audio_in = 0;
            vf = format!("scale=-2:{height}");
            venc = ["-c:v", "h264_videotoolbox", "-realtime", "1"].map(String::from).to_vec();
        }
        #[cfg(windows)]
        {
            // ddagrab = Desktop Duplication (fast, includes cursor); frames are GPU textures, so download them.
            cmd.args(["-f", "lavfi", "-i", &format!("ddagrab=output_idx={}:framerate={fps}:draw_mouse=1", self.screen)]);
            if let Some(m) = &mic {
                cmd.args(["-use_wallclock_as_timestamps", "1", "-f", "dshow", "-i", &format!("audio={m}")]);
            }
            audio_in = 1;
            vf = format!("hwdownload,format=bgra,scale=-2:{height}");
            venc = ["-c:v", "h264_mf"].map(String::from).to_vec(); // ponytail: MF picks the MFT; prefer nvenc/qsv/amf when present
        }
        let n = self.next_part.to_string();
        cmd.args(["-map", "0:v", "-vf", &vf]).args(&venc);
        cmd.args(["-b:v", &b.to_string(), "-pix_fmt", "yuv420p", "-g", &(fps * 2).to_string(), "-force_key_frames", &format!("expr:gte(t,n_forced*{seg})")]);
        if mic.is_some() {
            cmd.args(["-map", &format!("{audio_in}:a"), "-c:a", "aac", "-b:a", "64k"]);
        }
        cmd.args(["-f", "segment", "-segment_time", &seg, "-segment_format", "mp4", "-reset_timestamps", "1", "-segment_start_number", &n])
            .arg(self.dir.join("p%d.mp4"));
        if mic.is_some() {
            cmd.args(["-map", &format!("{audio_in}:a"), "-vn", "-c:a", "libopus", "-b:a", "32k", "-f", "segment", "-segment_time", &seg, "-segment_format", "webm", "-reset_timestamps", "1", "-segment_start_number", &n])
                .arg(self.dir.join("p%d.audio.webm"));
        }
        let child = cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().map_err(|e| format!("ffmpeg: {e}"))?;
        self.cur = Some(Cur { child, started: Instant::now(), first_part: self.next_part, audio });
        Ok(())
    }

    fn end_run(&mut self) {
        let Some(mut c) = self.cur.take() else { return };
        let len = c.started.elapsed().as_secs_f64();
        if let Some(stdin) = c.child.stdin.as_mut() {
            let _ = stdin.write_all(b"q"); // graceful: lets ffmpeg finalize the MP4 moov atom
        }
        let _ = c.child.wait();
        let mut n = c.first_part;
        while self.dir.join(format!("p{n}.mp4")).exists() {
            n += 1;
        }
        self.runs.push(Run { first_part: c.first_part, start: self.clock, len, audio: c.audio });
        self.clock += len;
        self.next_part = n.max(c.first_part + 1);
    }
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
    let mut s = Session { dir: dir.clone(), screen, mic, height, fps, seg: chunk_seconds.max(120), muted: false, paused: false, next_part: 1, clock: 0.0, runs: vec![], cur: None };
    s.begin_run()?;
    *slot = Some(s);
    Ok(dir.to_string_lossy().into())
}

fn with<R>(state: &State<Recorder>, f: impl FnOnce(&mut Session) -> Result<R, String>) -> Result<R, String> {
    f(state.0.lock().unwrap().as_mut().ok_or("Not recording")?)
}

#[tauri::command]
pub fn pause_recording(state: State<Recorder>) -> Result<(), String> {
    with(&state, |s| {
        if !s.paused {
            s.end_run();
            s.paused = true;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn resume_recording(state: State<Recorder>) -> Result<(), String> {
    with(&state, |s| {
        if s.paused {
            s.paused = false;
            s.begin_run()?;
        }
        Ok(())
    })
}

/// Mute/unmute the mic: the next run is recorded without (or with) audio.
#[tauri::command]
pub fn set_mute(state: State<Recorder>, muted: bool) -> Result<(), String> {
    with(&state, |s| {
        if s.mic.is_none() || s.muted == muted {
            return Ok(());
        }
        s.muted = muted;
        if !s.paused {
            s.end_run();
            s.begin_run()?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn recording_state(state: State<Recorder>) -> Result<State_, String> {
    with(&state, |s| Ok(State_ { elapsed: s.elapsed(), paused: s.paused, muted: s.muted }))
}

#[tauri::command]
pub fn stop_recording(state: State<Recorder>) -> Result<Finished, String> {
    let mut s = state.0.lock().unwrap().take().ok_or("Not recording")?;
    s.end_run();
    let seg = s.seg as f64;
    let mut parts = vec![];
    for r in &s.runs {
        for k in 0.. {
            let n = r.first_part + k;
            let path = s.dir.join(format!("p{n}.mp4"));
            let Ok(meta) = std::fs::metadata(&path) else { break };
            let start = r.start + k as f64 * seg;
            let dur = (r.len - k as f64 * seg).min(seg);
            if dur < 1.0 {
                continue; // too short to be playable
            }
            let audio = s.dir.join(format!("p{n}.audio.webm"));
            parts.push(Part {
                path: path.to_string_lossy().into(),
                audio_path: if r.audio && audio.exists() { audio.to_string_lossy().into() } else { String::new() },
                start_seconds: start.round() as u32,
                duration_seconds: dur.round() as u32,
                size_bytes: meta.len(),
            });
        }
    }
    if parts.is_empty() {
        return Err("Nothing was recorded. Check Screen Recording permission for ScreenLoop.".into());
    }
    parts.truncate(50); // server limit
    Ok(Finished { parts, duration_seconds: s.clock.round() as u32 })
}

/// Grab a JPEG of one monitor (includes any drawn markup; excludes our protected control windows).
#[tauri::command]
pub fn screenshot(app: tauri::AppHandle, screen: String) -> Result<String, String> {
    let idx: usize = screen.parse().unwrap_or(0);
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    let m = monitors.get(idx).or(monitors.first()).ok_or("No monitor found")?;
    let img = m.capture_image().map_err(|e| e.to_string())?;
    // Shrink to ~1280 wide to keep comment screenshots small.
    let (w, h) = (img.width(), img.height());
    let img = if w > 1280 { image::imageops::resize(&img, 1280, h * 1280 / w, image::imageops::FilterType::Triangle) } else { img };
    let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("shots");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.jpg", uuid()));
    rgb.save_with_format(&path, image::ImageFormat::Jpeg).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into())
}

/// PUT a local file to a Supabase signed upload URL (streamed, not buffered).
#[tauri::command]
pub async fn upload_file(path: String, url: String, content_type: String) -> Result<(), String> {
    let file = tokio::fs::File::open(&path).await.map_err(|e| e.to_string())?;
    let len = file.metadata().await.map_err(|e| e.to_string())?.len();
    let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(file));
    let res = reqwest::Client::new().put(url).header("content-type", content_type).header("content-length", len).body(body).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Upload failed ({})", res.status()));
    }
    Ok(())
}

#[tauri::command]
pub fn file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(path).map(|m| m.len()).map_err(|e| e.to_string())
}

// ---- Windows: floating bar (capture-protected) and drawing overlay (captured on purpose) ----
use tauri::{WebviewUrl, WebviewWindowBuilder};

const BAR_W: f64 = 520.0;
const BAR_H: f64 = 72.0;
const BAR_MARGIN: f64 = 48.0;

fn bar_pos(app: &tauri::AppHandle, h: f64) -> Option<(f64, f64)> {
    let m = app.primary_monitor().ok()??;
    let s = m.scale_factor();
    let size = m.size().to_logical::<f64>(s);
    let pos = m.position().to_logical::<f64>(s);
    Some((pos.x + (size.width - BAR_W) / 2.0, pos.y + size.height - h - BAR_MARGIN))
}

/// Floating control bar: always on top, undecorated, excluded from screen capture (content
/// protection), so it never appears in the recording on any monitor setup.
#[tauri::command]
pub fn open_controls(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("controls") {
        return w.show().map_err(|e| e.to_string());
    }
    let mut b = WebviewWindowBuilder::new(&app, "controls", WebviewUrl::App("index.html?view=controls".into()))
        .title("ScreenLoop controls")
        .inner_size(BAR_W, BAR_H)
        .decorations(false)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .content_protected(true)
        .transparent(true)
        .shadow(false)
        .focused(false);
    if let Some((x, y)) = bar_pos(&app, BAR_H) {
        b = b.position(x, y);
    }
    b.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// Grow/shrink the bar window upward (for the tool tray, comment box, prompts) keeping its bottom edge fixed.
#[tauri::command]
pub fn set_controls_height(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    let w = app.get_webview_window("controls").ok_or("no controls")?;
    let h = height.max(BAR_H);
    w.set_size(tauri::LogicalSize::new(BAR_W, h)).map_err(|e| e.to_string())?;
    if let Some((x, y)) = bar_pos(&app, h) {
        w.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Transparent full-screen canvas on one monitor for live markup. NOT content protected, so
/// strokes are part of the recording. Click-through until draw mode is turned on.
#[tauri::command]
pub fn open_overlay(app: tauri::AppHandle, screen: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("overlay") {
        return w.show().map_err(|e| e.to_string());
    }
    let idx: usize = screen.parse().unwrap_or(0);
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let m = monitors.get(idx).or(monitors.first()).ok_or("No monitor")?;
    let s = m.scale_factor();
    let (size, pos) = (m.size().to_logical::<f64>(s), m.position().to_logical::<f64>(s));
    let w = WebviewWindowBuilder::new(&app, "overlay", WebviewUrl::App("index.html?view=overlay".into()))
        .title("ScreenLoop markup")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .shadow(false)
        .focused(false)
        .position(pos.x, pos.y)
        .inner_size(size.width, size.height)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = w.set_ignore_cursor_events(true);
    // keep the control bar above the overlay
    if let Some(c) = app.get_webview_window("controls") {
        let _ = c.set_always_on_top(true);
    }
    Ok(())
}

#[tauri::command]
pub fn set_overlay_interactive(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    let w = app.get_webview_window("overlay").ok_or("no overlay")?;
    w.set_ignore_cursor_events(!on).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_controls(app: tauri::AppHandle) {
    for l in ["controls", "overlay"] {
        if let Some(w) = app.get_webview_window(l) {
            let _ = w.close();
        }
    }
}

fn uuid() -> String {
    format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())
}

#[derive(Serialize)]
pub struct AudioSeg {
    path: String,
    start: u32,
}

#[derive(Serialize)]
pub struct Extracted {
    segments: Vec<AudioSeg>,
    duration_seconds: u32,
}

/// Cut an existing video's sound into 16 kHz mono WAV pieces of 5 minutes (what the transcript
/// pipeline expects for uploads) and report its duration.
#[tauri::command]
pub fn extract_audio_segments(app: tauri::AppHandle, path: String) -> Result<Extracted, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("uploads").join(uuid());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = hidden(Command::new(ffmpeg()))
        .args(["-hide_banner", "-y", "-i", &path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "segment", "-segment_time", "300", "-reset_timestamps", "1"])
        .arg(dir.join("s%d.wav"))
        .output()
        .map_err(|e| format!("ffmpeg: {e}"))?;
    let log = String::from_utf8_lossy(&out.stderr);
    // Duration is printed as "Duration: HH:MM:SS.xx" in the input description.
    let dur = log
        .lines()
        .find_map(|l| l.trim().strip_prefix("Duration: "))
        .and_then(|d| d.split(',').next())
        .map(|d| d.split(':').map(|x| x.parse::<f64>().unwrap_or(0.0)).fold(0.0, |a, x| a * 60.0 + x))
        .unwrap_or(0.0);
    let mut segments = vec![];
    for n in 0.. {
        let p = dir.join(format!("s{n}.wav")); // segment muxer numbers from 0
        if !p.exists() {
            break;
        }
        segments.push(AudioSeg { path: p.to_string_lossy().into(), start: n * 300 });
    }
    if segments.is_empty() {
        return Err("This video has no sound we can use.".into());
    }
    Ok(Extracted { segments, duration_seconds: dur.round() as u32 })
}
