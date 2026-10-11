import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, type ResolvedLink } from "./lib/api";

interface Device { index: string; name: string }
interface Part { path: string; audio_path: string; start_seconds: number; duration_seconds: number; size_bytes: number }
interface Finished { parts: Part[]; duration_seconds: number }
type Upload = { path: string; signedUrl: string; audioPath: string; audioSignedUrl: string };

const QUALITY = { low: [540, 8], moderate: [720, 10], high: [1440, 15] } as const; // matches web presets

export default function Recorder({ token, link, onDone }: { token: string; link: ResolvedLink; onDone: () => void }) {
  const [screens, setScreens] = useState<Device[]>([]);
  const [mics, setMics] = useState<Device[]>([]);
  const [screen, setScreen] = useState("");
  const [mic, setMic] = useState("");
  const [state, setState] = useState<"idle" | "recording" | "sending" | "sent">("idle");
  const [secs, setSecs] = useState(0);
  const [msg, setMsg] = useState("");
  const timer = useRef<number>(0);
  const chunk = Math.max(2, link.chunkMinutes ?? 30) * 60;

  useEffect(() => {
    invoke<{ screens: Device[]; mics: Device[] }>("list_devices")
      .then((d) => { setScreens(d.screens); setMics(d.mics); setScreen(d.screens[0]?.index ?? ""); setMic(d.mics[0]?.index ?? ""); })
      .catch((e) => setMsg(String(e)));
  }, []);

  const start = async () => {
    setMsg("");
    const [h, fps] = QUALITY[(link.quality as keyof typeof QUALITY) ?? "moderate"] ?? QUALITY.moderate;
    try {
      await invoke("start_recording", { screen, mic: mic || null, height: h, fps, chunkSeconds: chunk });
      setState("recording"); setSecs(0);
      timer.current = window.setInterval(() => setSecs((s) => s + 1), 1000);
    } catch (e) { setMsg(String(e)); }
  };

  const stopAndSend = async () => {
    clearInterval(timer.current);
    setState("sending");
    try {
      const done = await invoke<Finished>("stop_recording", { chunkSeconds: chunk });
      const parts = [];
      for (const [i, p] of done.parts.entries()) {
        setMsg(`Uploading part ${i + 1} of ${done.parts.length}…`);
        const u = await api<Upload>("create-upload", { token, ext: "mp4", part: i });
        await invoke("upload_file", { path: p.path, url: u.signedUrl, contentType: "video/mp4" });
        if (p.audio_path) await invoke("upload_file", { path: p.audio_path, url: u.audioSignedUrl, contentType: "audio/webm" });
        parts.push({ path: u.path, audioPath: p.audio_path ? u.audioPath : null, startSeconds: p.start_seconds, durationSeconds: p.duration_seconds, sizeBytes: p.size_bytes });
      }
      setMsg("Finishing…");
      await api("finalize", {
        token, path: parts[0]!.path, audioPath: parts[0]!.audioPath, parts, origin: import.meta.env.VITE_WEB_URL,
        durationSeconds: done.duration_seconds, sizeBytes: parts.reduce((a, p) => a + p.sizeBytes, 0),
        trimStartSeconds: 0, trimEndSeconds: done.duration_seconds, quality: link.quality ?? "moderate", source: "recorded",
      });
      setState("sent"); setMsg("Sent. Thank you!");
    } catch (e) { setState("idle"); setMsg(String(e)); }
  };

  const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  return (
    <div className="col">
      <h1>{link.title}</h1>
      <ul>{link.prompts?.map((p) => <li key={p}>{p}</li>)}</ul>
      {state === "idle" && (<>
        <label>Screen <select value={screen} onChange={(e) => setScreen(e.target.value)}>{screens.map((d) => <option key={d.index} value={d.index}>{d.name}</option>)}</select></label>
        <label>Microphone <select value={mic} onChange={(e) => setMic(e.target.value)}><option value="">None</option>{mics.map((d) => <option key={d.index} value={d.index}>{d.name}</option>)}</select></label>
        <button onClick={start} disabled={!screen}>Start recording</button>
      </>)}
      {state === "recording" && (<><p>● Recording {mmss}</p><button onClick={stopAndSend}>Stop &amp; send</button></>)}
      {state === "sending" && <p>{msg || "Working…"}</p>}
      {state === "sent" && <button onClick={onDone}>Done</button>}
      {state !== "sending" && msg && <p className={state === "sent" ? "" : "err"}>{msg}</p>}
      {state === "idle" && <button onClick={onDone}>Back</button>}
    </div>
  );
}
