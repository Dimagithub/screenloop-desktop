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
use std::collections::HashSet;
use tauri::{Manager, State};
use crate::sysaudio::{self, SysCapture, SysInfo};


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
    audio_only: bool,
    system_audio: bool,
    mixed: HashSet<u32>,
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
    sys: Option<SysInfo>,
}

struct Cur {
    child: Child,
    started: Instant,
    first_part: u32,
    audio: bool,
    sys: Option<SysCapture>,
}

#[derive(Serialize, Clone)]
pub struct Part {
    n: u32,
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

fn main_file(dir: &std::path::Path, n: u32, audio_only: bool) -> PathBuf {
    dir.join(if audio_only { format!("p{n}.voice.webm") } else { format!("p{n}.mp4") })
}

fn make_part(dir: &std::path::Path, n: u32, audio_only: bool, with_audio: bool, start: f64, dur: f64) -> Option<Part> {
    let path = main_file(dir, n, audio_only);
    let meta = std::fs::metadata(&path).ok()?;
    if dur < 1.0 {
        return None; // too short to be playable
    }
    let side = dir.join(format!("p{n}.audio.webm"));
    let audio_path = if audio_only {
        path.to_string_lossy().into()
    } else if with_audio && side.exists() {
        side.to_string_lossy().into()
    } else {
        String::new()
    };
    Some(Part { n, path: path.to_string_lossy().into(), audio_path, start_seconds: start.round() as u32, duration_seconds: dur.round() as u32, size_bytes: meta.len() })
}

/// Where computer audio starts relative to the ffmpeg run (ffmpeg takes a moment to produce its first frame).
// ponytail: fixed calibration constant; measure per machine if lip-sync of system sounds matters
const SYS_AUDIO_LEAD_SECS: f64 = 0.4;

/// Replace `file`'s audio with its own audio mixed with the computer audio (or just the computer audio
/// when the file had none). Video is copied untouched. Returns false (file left as it was) on any failure.
fn mix_into(file: &std::path::Path, sys: &SysInfo, offset: f64, dur: f64, has_audio: bool, codec: &str, br: &str, container: &str) -> bool {
    if std::fs::metadata(&sys.path).map(|m| m.len()).unwrap_or(0) < (sys.rate as u64 * sys.channels as u64 * 4) {
        return false; // less than a second of sound: nothing to mix
    }
    let tmp = file.with_extension(format!("mix.{container}"));
    let mut c = hidden(Command::new(ffmpeg()));
    c.args(["-hide_banner", "-loglevel", "error", "-y", "-i"]).arg(file);
    c.args(["-ss", &format!("{offset:.3}"), "-t", &format!("{dur:.3}"), "-f", "f32le", "-ar", &sys.rate.to_string(), "-ac", &sys.channels.to_string(), "-i"]).arg(&sys.path);
    let video = container == "mp4";
    let filter = if has_audio { "[0:a][1:a]amix=inputs=2:duration=first:normalize=0[a]" } else { "[1:a]anull[a]" };
    c.args(["-filter_complex", filter]);
    if video {
        c.args(["-map", "0:v", "-c:v", "copy"]);
    }
    c.args(["-map", "[a]", "-c:a", codec, "-b:a", br, "-t", &format!("{dur:.3}")]);
    if video {
        c.args(["-movflags", "frag_keyframe+empty_moov+default_base_moof"]);
    }
    c.arg(&tmp);
    let ok = c.output().map(|o| o.status.success()).unwrap_or(false) && std::fs::rename(&tmp, file).is_ok();
    if !ok {
        let _ = std::fs::remove_file(&tmp);
    }
    ok
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
        let n = self.next_part.to_string();
        let mut cmd = hidden(Command::new(ffmpeg()));
        cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
        if self.audio_only {
            // Voice only: one Opus file per part serves as both the "video" file and the transcript audio.
            let m = self.mic.clone().ok_or("Choose a microphone for a voice-only recording")?;
            #[cfg(target_os = "macos")]
            cmd.args(["-f", "avfoundation", "-i", &format!(":{m}")]);
            #[cfg(windows)]
            cmd.args(["-use_wallclock_as_timestamps", "1", "-f", "dshow", "-i", &format!("audio={m}")]);
            if self.muted {
                cmd.args(["-af", "volume=0"]);
            }
            cmd.args(["-vn", "-c:a", "libopus", "-b:a", "32k", "-f", "segment", "-segment_time", &seg, "-segment_format", "webm", "-reset_timestamps", "1", "-segment_start_number", &n])
                .arg(self.dir.join("p%d.voice.webm"));
            let child = cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().map_err(|e| format!("ffmpeg: {e}"))?;
            let sys = self.start_sys();
            self.cur = Some(Cur { child, started: Instant::now(), first_part: self.next_part, audio: true, sys });
            return Ok(());
        }
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
        cmd.args(["-map", "0:v", "-vf", &vf]).args(&venc);
        cmd.args(["-b:v", &b.to_string(), "-pix_fmt", "yuv420p", "-g", &(fps * 2).to_string(), "-force_key_frames", &format!("expr:gte(t,n_forced*{seg})")]);
        if mic.is_some() {
            cmd.args(["-map", &format!("{audio_in}:a"), "-c:a", "aac", "-b:a", "64k"]);
        }
        // Fragmented MP4: a part cut short by a crash is still playable.
        cmd.args(["-f", "segment", "-segment_time", &seg, "-segment_format", "mp4", "-segment_format_options", "movflags=frag_keyframe+empty_moov+default_base_moof", "-reset_timestamps", "1", "-segment_start_number", &n])
            .arg(self.dir.join("p%d.mp4"));
        if mic.is_some() {
            cmd.args(["-map", &format!("{audio_in}:a"), "-vn", "-c:a", "libopus", "-b:a", "32k", "-f", "segment", "-segment_time", &seg, "-segment_format", "webm", "-reset_timestamps", "1", "-segment_start_number", &n])
                .arg(self.dir.join("p%d.audio.webm"));
        }
        let child = cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().map_err(|e| format!("ffmpeg: {e}"))?;
        let sys = self.start_sys();
        self.cur = Some(Cur { child, started: Instant::now(), first_part: self.next_part, audio, sys });
        Ok(())
    }

    fn end_run(&mut self) {
        let Some(mut c) = self.cur.take() else { return };
        let len = c.started.elapsed().as_secs_f64();
        if let Some(stdin) = c.child.stdin.as_mut() {
            let _ = stdin.write_all(b"q"); // graceful: lets ffmpeg finalize the files
        }
        let _ = c.child.wait();
        let sys = c.sys.take().map(|x| x.stop());
        let mut n = c.first_part;
        while main_file(&self.dir, n, self.audio_only).exists() {
            n += 1;
        }
        self.runs.push(Run { first_part: c.first_part, start: self.clock, len, audio: c.audio, sys });
        self.clock += len;
        self.next_part = n.max(c.first_part + 1);
    }

    fn start_sys(&self) -> Option<SysCapture> {
        if !self.system_audio {
            return None;
        }
        match sysaudio::start(&self.dir.join(format!("sys_{}.raw", self.next_part))) {
            Ok(c) => Some(c),
            Err(e) => {
                eprintln!("system audio unavailable: {e}"); // recording continues without it
                None
            }
        }
    }

    /// Mix the computer audio of a run into its finished parts (video + transcript audio), once per part.
    fn mix_ready(&mut self, include_current: bool) {
        let seg = self.seg as f64;
        let parts = self.parts(include_current);
        for p in parts {
            if self.mixed.contains(&p.n) {
                continue;
            }
            // The run that produced this part is the latest one that started at or before it.
            let mut owner: Option<(u32, SysInfo, bool)> = None;
            for r in &self.runs {
                if r.first_part <= p.n {
                    owner = r.sys.clone().map(|i| (r.first_part, i, r.audio));
                }
            }
            if let Some(c) = &self.cur {
                if c.first_part <= p.n {
                    owner = c.sys.as_ref().map(|x| (c.first_part, x.info.clone(), c.audio));
                }
            }
            let Some((first, sys, has_mic)) = owner else { continue };
            let offset = SYS_AUDIO_LEAD_SECS + (p.n - first) as f64 * seg;
            let dur = p.duration_seconds as f64;
            let ok = if self.audio_only {
                mix_into(std::path::Path::new(&p.path), &sys, offset, dur, has_mic, "libopus", "32k", "webm")
            } else {
                let a = mix_into(std::path::Path::new(&p.path), &sys, offset, dur, has_mic, "aac", "64k", "mp4");
                if !p.audio_path.is_empty() {
                    mix_into(std::path::Path::new(&p.audio_path), &sys, offset, dur, has_mic, "libopus", "32k", "webm");
                }
                a
            };
            if ok {
                self.mixed.insert(p.n);
            }
        }
    }

    /// Parts that will not change any more: every part of finished runs, and all but the newest of the current run.
    fn parts(&self, include_current: bool) -> Vec<Part> {
        let seg = self.seg as f64;
        let mut out = vec![];
        for r in &self.runs {
            for k in 0.. {
                let n = r.first_part + k;
                if !main_file(&self.dir, n, self.audio_only).exists() {
                    break;
                }
                let dur = (r.len - k as f64 * seg).min(seg);
                out.extend(make_part(&self.dir, n, self.audio_only, r.audio, r.start + k as f64 * seg, dur));
            }
        }
        if let (true, Some(c)) = (include_current, &self.cur) {
            let mut n = c.first_part;
            while main_file(&self.dir, n + 1, self.audio_only).exists() {
                let k = (n - c.first_part) as f64;
                out.extend(make_part(&self.dir, n, self.audio_only, c.audio, self.clock + k * seg, seg));
                n += 1;
            }
        }
        out.truncate(50); // server limit
        out
    }
}

#[tauri::command]
pub fn start_recording(
    app: tauri::AppHandle,
    state: State<Recorder>,
    screen: String,
    mic: Option<String>,
    audio_only: bool,
    system_audio: bool,
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
    let mut s = Session { dir: dir.clone(), screen, mic, audio_only, system_audio, mixed: HashSet::new(), height, fps, seg: chunk_seconds.max(120), muted: false, paused: false, next_part: 1, clock: 0.0, runs: vec![], cur: None };
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

/// Parts that are final while recording continues (for background upload).
#[tauri::command]
pub fn completed_parts(state: State<Recorder>) -> Result<Vec<Part>, String> {
    with(&state, |s| {
        s.mix_ready(true);
        Ok(s.parts(true))
    })
}

#[tauri::command]
pub fn stop_recording(state: State<Recorder>) -> Result<Finished, String> {
    let mut s = state.0.lock().unwrap().take().ok_or("Not recording")?;
    s.end_run();
    s.mix_ready(false);
    let parts = s.parts(false);
    if parts.is_empty() {
        return Err("Nothing was recorded. Check Screen Recording and Microphone permission for ScreenLoop.".into());
    }
    Ok(Finished { parts, duration_seconds: s.clock.round() as u32 })
}

/// App is quitting: end the running ffmpeg so the part on disk is closed and the process is gone.
pub fn stop_on_exit(app: &tauri::AppHandle) {
    if let Some(mut s) = app.state::<Recorder>().0.lock().unwrap().take() {
        s.end_run();
    }
}

// ---- Crash recovery: manifests + rebuilding parts from files on disk ----

fn sessions_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("recordings"))
}

/// Only paths inside our recordings folder are ever touched.
fn session_dir(app: &tauri::AppHandle, dir: &str) -> Result<PathBuf, String> {
    let root = sessions_dir(app)?;
    let p = PathBuf::from(dir);
    if p.parent() != Some(root.as_path()) {
        return Err("Not a recording folder".into());
    }
    Ok(p)
}

#[tauri::command]
pub fn save_manifest(app: tauri::AppHandle, dir: String, json: String) -> Result<(), String> {
    std::fs::write(session_dir(&app, &dir)?.join("session.json"), json).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct Unsent {
    dir: String,
    manifest: String,
}

/// Recording folders that have a manifest but were never sent (newest first).
#[tauri::command]
pub fn list_unsent(app: tauri::AppHandle, state: State<Recorder>) -> Result<Vec<Unsent>, String> {
    let live = state.0.lock().unwrap().as_ref().map(|s| s.dir.clone());
    let mut out = vec![];
    let Ok(rd) = std::fs::read_dir(sessions_dir(&app)?) else { return Ok(out) };
    for e in rd.flatten() {
        let p = e.path();
        if Some(&p) == live.as_ref() {
            continue;
        }
        if let Ok(m) = std::fs::read_to_string(p.join("session.json")) {
            out.push(Unsent { dir: p.to_string_lossy().into(), manifest: m });
        }
    }
    out.sort_by(|a, b| b.dir.cmp(&a.dir));
    Ok(out)
}

#[tauri::command]
pub fn delete_session(app: tauri::AppHandle, dir: String) -> Result<(), String> {
    let p = session_dir(&app, &dir)?;
    std::fs::remove_dir_all(p).map_err(|e| e.to_string())
}

fn probe_secs(path: &std::path::Path) -> f64 {
    let Ok(out) = hidden(Command::new(ffmpeg())).args(["-hide_banner", "-i"]).arg(path).output() else { return 0.0 };
    String::from_utf8_lossy(&out.stderr)
        .lines()
        .find_map(|l| l.trim().strip_prefix("Duration: "))
        .and_then(|d| d.split(',').next())
        .map(|d| d.split(':').map(|x| x.parse::<f64>().unwrap_or(0.0)).fold(0.0, |a, x| a * 60.0 + x))
        .unwrap_or(0.0)
}

/// Rebuild the part list of an interrupted recording from the files that survived.
#[tauri::command]
pub fn recover_parts(app: tauri::AppHandle, dir: String, audio_only: bool) -> Result<Finished, String> {
    let p = session_dir(&app, &dir)?;
    let mut parts = vec![];
    let mut clock = 0.0;
    for n in 1..=999u32 {
        let f = main_file(&p, n, audio_only);
        if !f.exists() {
            if n > 1 && !main_file(&p, n + 1, audio_only).exists() {
                break;
            }
            continue;
        }
        let dur = probe_secs(&f);
        if let Some(part) = make_part(&p, n, audio_only, true, clock, dur) {
            clock += dur;
            parts.push(part);
        }
    }
    if parts.is_empty() {
        return Err("Nothing could be recovered from this recording.".into());
    }
    parts.truncate(50);
    Ok(Finished { parts, duration_seconds: clock.round() as u32 })
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
pub async fn open_controls(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("controls") {
        return w.show().map_err(|e| e.to_string());
    }
    let mut b = WebviewWindowBuilder::new(&app, "controls", WebviewUrl::App("index.html".into()))
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
pub async fn open_overlay(app: tauri::AppHandle, screen: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("overlay") {
        return w.show().map_err(|e| e.to_string());
    }
    let idx: usize = screen.parse().unwrap_or(0);
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let m = monitors.get(idx).or(monitors.first()).ok_or("No monitor")?;
    let s = m.scale_factor();
    let (size, pos) = (m.size().to_logical::<f64>(s), m.position().to_logical::<f64>(s));
    let w = WebviewWindowBuilder::new(&app, "overlay", WebviewUrl::App("index.html".into()))
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
    w.set_ignore_cursor_events(!on).map_err(|e| e.to_string())?;
    if on {
        let _ = w.set_focus(); // so Esc reaches the overlay
        // the bar must stay above the interactive overlay so it can always be clicked to leave drawing
        if let Some(c) = app.get_webview_window("controls") {
            let _ = c.set_always_on_top(false);
            let _ = c.set_always_on_top(true);
        }
    }
    Ok(())
}

/// Put the bar back above the overlay (called after strokes and tool changes) so it never ends up under the crosshair canvas.
#[tauri::command]
pub fn raise_controls(app: tauri::AppHandle) {
    if let Some(c) = app.get_webview_window("controls") {
        let _ = c.set_always_on_top(false);
        let _ = c.set_always_on_top(true);
    }
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
