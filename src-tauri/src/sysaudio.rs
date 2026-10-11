//! System ("computer") audio via loopback capture on the default output device:
//! WASAPI loopback on Windows, a CoreAudio tap on macOS 14.6+ (cpal). Samples go to a raw
//! f32le file next to the recording and are mixed into the parts when they are complete.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};

pub struct SysCapture {
    stop: mpsc::Sender<()>,
    thread: Option<std::thread::JoinHandle<()>>,
    pub info: SysInfo,
}

#[derive(Clone)]
pub struct SysInfo {
    pub path: PathBuf,
    pub rate: u32,
    pub channels: u16,
}

fn writer_cb<T: Sample + Send + 'static>(w: Arc<Mutex<BufWriter<std::fs::File>>>) -> impl FnMut(&[T], &cpal::InputCallbackInfo) + Send + 'static
where
    f32: cpal::FromSample<T>,
{
    move |data: &[T], _| {
        if let Ok(mut w) = w.lock() {
            for s in data {
                let _ = w.write_all(&s.to_sample::<f32>().to_le_bytes());
            }
        }
    }
}

/// Start capturing what the computer is playing. Err means "no system audio" and must not stop the recording.
pub fn start(path: &Path) -> Result<SysCapture, String> {
    let path = path.to_path_buf();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<SysInfo, String>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let p2 = path.clone();
    // The stream is created and dropped on its own thread (streams are not Send on every platform).
    let thread = std::thread::spawn(move || {
        let setup = (|| -> Result<(cpal::Stream, SysInfo), String> {
            let host = cpal::default_host();
            let dev = host.default_output_device().ok_or("No audio output device")?;
            let cfg = dev.default_output_config().map_err(|e| e.to_string())?;
            let file = std::fs::File::create(&p2).map_err(|e| e.to_string())?;
            let w = Arc::new(Mutex::new(BufWriter::new(file)));
            let err = |e: cpal::Error| eprintln!("system audio: {e}");
            // Building an *input* stream on an *output* device is loopback capture.
            let stream = match cfg.sample_format() {
                SampleFormat::F32 => dev.build_input_stream(cfg.clone().into(), writer_cb::<f32>(w), err, None),
                SampleFormat::I16 => dev.build_input_stream(cfg.clone().into(), writer_cb::<i16>(w), err, None),
                SampleFormat::I32 => dev.build_input_stream(cfg.clone().into(), writer_cb::<i32>(w), err, None),
                f => return Err(format!("Unsupported audio format {f}")),
            }
            .map_err(|e| e.to_string())?;
            stream.play().map_err(|e| e.to_string())?;
            Ok((stream, SysInfo { path: p2.clone(), rate: cfg.sample_rate() as u32, channels: cfg.channels() as u16 }))
        })();
        match setup {
            Ok((stream, info)) => {
                let _ = ready_tx.send(Ok(info));
                let _ = stop_rx.recv();
                drop(stream);
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
            }
        }
    });
    match ready_rx.recv().map_err(|e| e.to_string())? {
        Ok(info) => Ok(SysCapture { stop: stop_tx, thread: Some(thread), info }),
        Err(e) => Err(e),
    }
}

impl SysCapture {
    pub fn stop(mut self) -> SysInfo {
        let _ = self.stop.send(());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        self.info.clone()
    }
}
