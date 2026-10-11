import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, type ResolvedLink } from "./lib/api";

interface Device { index: string; name: string }
interface Part { path: string; audio_path: string; start_seconds: number; duration_seconds: number; size_bytes: number }
interface Finished { parts: Part[]; duration_seconds: number }
type Upload = { path: string; signedUrl: string; audioPath: string; audioSignedUrl: string };
type Quality = "low" | "moderate" | "high";

const QUALITY: Record<Quality, [number, number]> = { low: [540, 8], moderate: [720, 10], high: [1440, 15] }; // same presets as web
const LABEL: Record<Quality, string> = { low: "Save data", moderate: "Standard", high: "Sharp" };
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;

export default function Recorder({ token, link, onDone }: { token: string; link: ResolvedLink; onDone: () => void }) {
  const [screens, setScreens] = useState<Device[]>([]);
  const [mics, setMics] = useState<Device[]>([]);
  const [screen, setScreen] = useState("");
  const [mic, setMic] = useState("");
  const [quality, setQuality] = useState<Quality>((link.quality as Quality) ?? "moderate");
  const [stage, setStage] = useState<"setup" | "recording" | "review" | "sending" | "sent">("setup");
  const [done, setDone] = useState<Finished | null>(null);
  const [notes, setNotes] = useState("");
  const [msg, setMsg] = useState("");
  const chunk = Math.max(2, link.chunkMinutes ?? 30) * 60;
  const stopping = useRef(false);

  useEffect(() => {
    invoke<{ screens: Device[]; mics: Device[] }>("list_devices")
      .then((d) => { setScreens(d.screens); setMics(d.mics); setScreen(d.screens[0]?.index ?? ""); setMic(d.mics[0]?.index ?? ""); })
      .catch((e) => setMsg(String(e)));
  }, []);

  const finish = async () => {
    if (stopping.current) return;
    stopping.current = true;
    try {
      const res = await invoke<Finished>("stop_recording", { chunkSeconds: chunk });
      await invoke("close_controls");
      const w = getCurrentWindow(); await w.unminimize(); await w.setFocus();
      setDone(res); setStage("review");
    } catch (e) {
      await invoke("close_controls");
      const w = getCurrentWindow(); await w.unminimize();
      setMsg(String(e)); setStage("setup");
    } finally { stopping.current = false; }
  };

  useEffect(() => {
    if (stage !== "recording") return;
    const un = listen("controls-stop", finish);
    return () => { un.then((f) => f()); };
  }, [stage]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setMsg("");
    const [h, fps] = QUALITY[quality];
    try {
      await invoke("start_recording", { screen, mic: mic || null, height: h, fps, chunkSeconds: chunk });
      await invoke("open_controls");
      setStage("recording");
      await getCurrentWindow().minimize(); // get out of the way; the floating bar takes over
    } catch (e) { setMsg(String(e)); }
  };

  const send = async () => {
    if (!done) return;
    setStage("sending");
    try {
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
        token, path: parts[0]!.path, audioPath: parts[0]!.audioPath, parts, notes, origin: import.meta.env.VITE_WEB_URL,
        durationSeconds: done.duration_seconds, sizeBytes: parts.reduce((a, p) => a + p.sizeBytes, 0),
        trimStartSeconds: 0, trimEndSeconds: done.duration_seconds, quality, source: "recorded",
      });
      setMsg(""); setStage("sent");
    } catch (e) { setMsg(String(e)); setStage("review"); }
  };

  const title = (
    <div className="topbar">
      <div className="brand">{stage === "setup" && <button className="linkbtn" onClick={onDone}>‹ Back</button>}<span>{link.title}</span>{link.sender && <span className="muted">from {link.sender.name}</span>}</div>
      {done && stage === "review" && <span className="chip">Recorded {fmt(done.duration_seconds)}</span>}
    </div>
  );

  if (stage === "sent") return (<>{title}<div className="page" style={{ justifyContent: "center" }}><div className="sendbox"><h1>Sent</h1><p className="muted">Thank you. Your recording is being turned into a document.</p><button className="btn lime" onClick={onDone}>Done</button></div></div></>);
  if (stage === "sending") return (<>{title}<div className="page" style={{ justifyContent: "center" }}><div className="sendbox"><h1>Sending…</h1><p className="muted">{msg || "Working…"}</p></div></div></>);
  if (stage === "recording") return (<>{title}<div className="page" style={{ justifyContent: "center" }}><div className="sendbox"><h1>Recording</h1><p className="muted">Use the floating bar to stop. It is never part of your recording.</p><button className="btn danger" onClick={finish}>Stop recording</button></div></div></>);

  if (stage === "review" && done) return (
    <>{title}
      <div className="setup">
        <div className="left">
          <div className="preview"><div className="screen" /><span className="pill">{done.parts.length} part{done.parts.length > 1 ? "s" : ""} · {fmt(done.duration_seconds)}</span></div>
        </div>
        <div className="right">
          <div className="field"><label htmlFor="notes" className="eyebrow">Notes</label><textarea id="notes" className="input" placeholder="Anything you want to add" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          <div className="spacer" />
          {msg && <p className="err">{msg}</p>}
          <button className="btn lime big" onClick={send}>Send{link.sender ? ` to ${link.sender.name.split(" ")[0]}` : ""}</button>
          <div style={{ display: "flex", justifyContent: "space-between" }}><button className="linkbtn" onClick={() => { setDone(null); setStage("setup"); }}>Record again</button></div>
        </div>
      </div>
    </>
  );

  return (
    <>{title}
      <div className="setup">
        <div className="left">
          <div className="preview"><div className="screen" /><span className="pill">{screens.find((s) => s.index === screen)?.name ?? "No screen found"}</span></div>
        </div>
        <div className="right">
          {link.prompts && link.prompts.length > 0 && (<div><div className="eyebrow" style={{ marginBottom: 8 }}>What to cover</div><div className="card prompts">{link.prompts.map((p) => <div key={p}><i />{p}</div>)}</div></div>)}
          <div className="field"><label htmlFor="scr">Screen</label><select id="scr" className="input" value={screen} onChange={(e) => setScreen(e.target.value)}>{screens.map((d) => <option key={d.index} value={d.index}>{d.name}</option>)}</select></div>
          <div className="field"><label htmlFor="mic">Microphone</label><select id="mic" className="input" value={mic} onChange={(e) => setMic(e.target.value)}><option value="">No microphone</option>{mics.map((d) => <option key={d.index} value={d.index}>{d.name}</option>)}</select></div>
          <div className="seg" role="group" aria-label="Quality">{(Object.keys(QUALITY) as Quality[]).map((q) => <button key={q} className={q === quality ? "on" : ""} onClick={() => setQuality(q)}>{LABEL[q]}</button>)}</div>
          <div className="spacer" />
          {msg && <p className="err">{msg}</p>}
          <button className="btn lime big" onClick={start} disabled={!screen}><i className="rec-dot" style={{ width: 14, height: 14 }} />Start recording</button>
          <div className="muted" style={{ textAlign: "center", fontSize: 12 }}>This window hides while you record</div>
        </div>
      </div>
    </>
  );
}
