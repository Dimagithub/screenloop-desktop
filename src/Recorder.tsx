import { useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as pickFiles } from "@tauri-apps/plugin-dialog";
import { api, type ResolvedLink } from "./lib/api";
import { SESSION_KEY } from "./Controls";
import { fmt, locate, type PartInfo } from "./lib/timeline";

interface Device { index: string; name: string }
type RPart = PartInfo & { n: number };
interface Finished { parts: RPart[]; duration_seconds: number }
export interface Comment { id: string; at: number; body: string; shot: string | null }
interface Attachment { path: string; name: string; type: string; size: number }
interface Sent { path: string; audioPath: string | null }
type Upload = { path: string; signedUrl: string; audioPath: string; audioSignedUrl: string };
export type Quality = "low" | "moderate" | "high";
export interface Manifest { v: 1; token: string; link: ResolvedLink; quality: Quality; voiceOnly: boolean; screen: string; comments: Comment[]; uploaded: Record<number, Sent>; notes: string; savedAt: string }

const QUALITY: Record<Quality, [number, number]> = { low: [540, 8], moderate: [720, 10], high: [1440, 15] }; // same presets as web
const LABEL: Record<Quality, string> = { low: "Save data", moderate: "Standard", high: "Sharp" };
const MIME: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= tries - 1) throw e; await sleep(1000 * 2 ** i); } }
}

/** Live level meter for the chosen microphone (webview audio, only used on the get-ready screen). */
function useMeter(label: string, on: boolean) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!on) { setLevel(0); return; }
    let stop = false, stream: MediaStream | undefined, ctx: AudioContext | undefined, raf = 0;
    (async () => {
      try {
        const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
        const match = devs.find((d) => label && d.label && (d.label.includes(label) || label.includes(d.label)));
        stream = await navigator.mediaDevices.getUserMedia({ audio: match ? { deviceId: { exact: match.deviceId } } : true });
        if (stop) return stream.getTracks().forEach((t) => t.stop());
        ctx = new AudioContext(); const an = ctx.createAnalyser(); an.fftSize = 512; ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Uint8Array(an.fftSize);
        const tick = () => { an.getByteTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v - 128)); setLevel(Math.min(1, m / 60)); raf = requestAnimationFrame(tick); };
        tick();
      } catch { /* no mic access: meter stays empty */ }
    })();
    return () => { stop = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); ctx?.close(); };
  }, [label, on]);
  return level;
}

export default function Recorder({ token, link, onDone, resume }: { token: string; link: ResolvedLink; onDone: () => void; resume?: { dir: string; manifest: Manifest } }) {
  const [screens, setScreens] = useState<Device[]>([]);
  const [mics, setMics] = useState<Device[]>([]);
  const [screen, setScreen] = useState(resume?.manifest.screen ?? "");
  const [mic, setMic] = useState("");
  const [quality, setQuality] = useState<Quality>(resume?.manifest.quality ?? (link.quality as Quality) ?? "moderate");
  const [voiceOnly, setVoiceOnly] = useState(resume?.manifest.voiceOnly ?? false);
  const [stage, setStage] = useState<"setup" | "countdown" | "recording" | "review" | "sending" | "sent">(resume ? "review" : "setup");
  const [count, setCount] = useState(3);
  const [sysAudio, setSysAudio] = useState(true);
  const [done, setDone] = useState<Finished | null>(null);
  const [comments, setComments] = useState<Comment[]>(resume?.manifest.comments ?? []);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [trim, setTrim] = useState<[number, number]>([0, 0]);
  const [notes, setNotes] = useState(resume?.manifest.notes ?? "");
  const [msg, setMsg] = useState("");
  const [previewImg, setPreviewImg] = useState("");
  const [upl, setUpl] = useState(0); // parts uploaded
  const dirRef = useRef(resume?.dir ?? "");
  const uploaded = useRef<Record<number, Sent>>(resume?.manifest.uploaded ?? {});
  const inflight = useRef(new Set<number>());
  const stopping = useRef(false);
  const chunk = Math.max(2, link.chunkMinutes ?? 30) * 60;
  const micName = mics.find((m) => m.index === mic)?.name ?? "";
  const level = useMeter(micName, stage === "setup" && !!mic);
  const noMedia = stage === "review" && !done;

  // Everything needed to finish sending after a crash or quit.
  const persist = (over: Partial<Manifest> = {}) => {
    if (!dirRef.current) return;
    const m: Manifest = { v: 1, token, link, quality, voiceOnly, screen, comments, uploaded: uploaded.current, notes, savedAt: new Date().toISOString(), ...over };
    invoke("save_manifest", { dir: dirRef.current, json: JSON.stringify(m) }).catch(() => {});
  };
  useEffect(() => { if (stage === "recording" || stage === "review") persist(); }, [comments, notes, upl, stage]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    invoke<{ screens: Device[]; mics: Device[] }>("list_devices")
      .then((d) => { setScreens(d.screens); setMics(d.mics); setScreen((s) => s || d.screens[0]?.index || ""); setMic(d.mics[0]?.index ?? ""); })
      .catch((e) => setMsg(String(e)));
  }, []);

  // Interrupted recording: rebuild the parts from the files that survived.
  useEffect(() => {
    if (!resume) return;
    invoke<Finished>("recover_parts", { dir: resume.dir, audioOnly: resume.manifest.voiceOnly })
      .then((res) => { setDone(res); setTrim([0, res.duration_seconds]); })
      .catch((e) => { setMsg(String(e)); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Live-ish preview of the chosen screen.
  useEffect(() => {
    if (stage !== "setup" || !screen || voiceOnly) return;
    let gone = false;
    invoke<string>("screenshot", { screen }).then((p) => { if (!gone) setPreviewImg(convertFileSrc(p)); }).catch(() => setPreviewImg(""));
    return () => { gone = true; };
  }, [screen, stage, voiceOnly]);

  useEffect(() => {
    const un = listen<Comment>("comment-added", (e) => setComments((c) => [...c, e.payload]));
    return () => { un.then((f) => f()); };
  }, []);

  // ---- uploads (parts go up while you keep recording) ----
  const uploadPart = async (p: RPart): Promise<Sent> => {
    const have = uploaded.current[p.n];
    if (have) return have;
    const u = await retry(() => api<Upload>("create-upload", { token, ext: voiceOnly ? "voice" : "mp4", part: p.n - 1 }));
    await retry(() => invoke("upload_file", { path: p.path, url: u.signedUrl, contentType: voiceOnly ? "audio/webm" : "video/mp4" }));
    let audioPath: string | null = null;
    if (voiceOnly) audioPath = u.path;
    else if (p.audio_path) { await retry(() => invoke("upload_file", { path: p.audio_path, url: u.audioSignedUrl, contentType: "audio/webm" })); audioPath = u.audioPath; }
    const r = { path: u.path, audioPath };
    uploaded.current[p.n] = r; setUpl(Object.keys(uploaded.current).length);
    return r;
  };
  useEffect(() => {
    if (stage !== "recording") return;
    let busy = false;
    const t = setInterval(async () => {
      if (busy) return; busy = true;
      try {
        const ready = await invoke<RPart[]>("completed_parts");
        for (const p of ready) if (!uploaded.current[p.n] && !inflight.current.has(p.n)) { inflight.current.add(p.n); try { await uploadPart(p); } catch { /* retried at send */ } finally { inflight.current.delete(p.n); } }
      } catch { /* not recording */ } finally { busy = false; }
    }, 4000);
    return () => clearInterval(t);
  }, [stage]); // eslint-disable-line react-hooks/exhaustive-deps

  const finish = async () => {
    if (stopping.current) return;
    stopping.current = true;
    try {
      const res = await invoke<Finished>("stop_recording");
      await invoke("close_controls");
      const w = getCurrentWindow(); await w.unminimize(); await w.setFocus();
      setDone(res); setTrim([0, res.duration_seconds]); setStage("review");
    } catch (e) {
      await invoke("close_controls");
      await getCurrentWindow().unminimize();
      setMsg(String(e)); setStage("setup");
    } finally { stopping.current = false; }
  };
  useEffect(() => {
    if (stage !== "recording") return;
    const un = listen("controls-stop", finish);
    return () => { un.then((f) => f()); };
  }, [stage]); // eslint-disable-line react-hooks/exhaustive-deps

  // 3-2-1 before the capture starts.
  useEffect(() => {
    if (stage !== "countdown") return;
    if (count <= 0) { begin(); return; }
    const t = setTimeout(() => setCount((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [stage, count]); // eslint-disable-line react-hooks/exhaustive-deps
  const startCountdown = () => { setMsg(""); setComments([]); uploaded.current = {}; setUpl(0); setCount(3); setStage("countdown"); };

  const begin = async () => {
    const [h, fps] = QUALITY[quality];
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ prompts: link.prompts ?? [], screen, hasMic: !!mic, voiceOnly, maxSeconds: (link.maxDurationMin ?? 0) * 60 }));
      dirRef.current = await invoke<string>("start_recording", { screen, mic: mic || null, audioOnly: voiceOnly, systemAudio: sysAudio, height: h, fps, chunkSeconds: chunk });
      persist();
      await invoke("open_controls");
      setStage("recording");
      await getCurrentWindow().minimize(); // get out of the way; the floating bar takes over
    } catch (e) { setMsg(String(e)); setStage("setup"); }
  };

  const addFiles = async () => {
    const picked = await pickFiles({ multiple: true, filters: [{ name: "PDF or image", extensions: Object.keys(MIME) }] });
    if (!picked) return;
    const list: Attachment[] = [];
    for (const path of Array.isArray(picked) ? picked : [picked]) {
      const ext = path.split(".").pop()!.toLowerCase();
      const size = await invoke<number>("file_size", { path });
      if (size > 20 * 1024 * 1024) { setMsg(`${path.split(/[\\/]/).pop()} is over 20 MB`); continue; }
      list.push({ path, name: path.split(/[\\/]/).pop()!, type: MIME[ext] ?? "", size });
    }
    setAttachments((a) => [...a, ...list].slice(0, 20));
  };

  const send = async () => {
    if (!done && !notes.trim() && !attachments.length && !comments.length) { setMsg("Add a note, a comment or an attachment first."); return; }
    setStage("sending");
    try {
      const parts: { path: string; audioPath: string | null; startSeconds: number; durationSeconds: number; sizeBytes: number }[] = [];
      for (const [i, p] of (done?.parts ?? []).entries()) {
        setMsg(`Uploading part ${i + 1} of ${done!.parts.length}…`);
        const r = await uploadPart(p);
        parts.push({ path: r.path, audioPath: r.audioPath, startSeconds: p.start_seconds, durationSeconds: p.duration_seconds, sizeBytes: p.size_bytes });
      }
      const kept = done ? comments.filter((c) => c.at >= trim[0] && c.at <= trim[1]) : comments.map((c) => ({ ...c, at: 0 }));
      const commentOut: { atSeconds: number; body: string; screenshotPath: string | null }[] = kept.map((c) => ({ atSeconds: c.at, body: c.body, screenshotPath: null }));
      const withShots = kept.filter((c) => c.shot);
      if (withShots.length) {
        setMsg("Uploading comment screenshots…");
        const slots = await retry(() => api<{ id: string; path: string; signedUrl: string }[]>("comment-uploads", { token, ids: withShots.map((c) => c.id) }));
        for (const s of slots) {
          const c = kept.find((k) => k.id === s.id)!;
          await retry(() => invoke("upload_file", { path: c.shot, url: s.signedUrl, contentType: "image/jpeg" }));
          commentOut[kept.indexOf(c)]!.screenshotPath = s.path;
        }
      }
      const attOut: { path: string; name: string; type: string; size: number }[] = [];
      if (attachments.length) {
        setMsg("Uploading attachments…");
        const slots = await retry(() => api<{ path: string; signedUrl: string }[]>("attachment-uploads", { token, files: attachments.map((a) => ({ type: a.type, size: a.size })) }));
        for (const [i, s] of slots.entries()) {
          const a = attachments[i]!;
          await retry(() => invoke("upload_file", { path: a.path, url: s.signedUrl, contentType: a.type }));
          attOut.push({ path: s.path, name: a.name, type: a.type, size: a.size });
        }
      }
      setMsg("Finishing…");
      await api("finalize", {
        token, path: parts[0]?.path ?? "", audioPath: parts[0]?.audioPath ?? null, parts, notes, origin: import.meta.env.VITE_WEB_URL,
        durationSeconds: done?.duration_seconds ?? 0, sizeBytes: parts.reduce((a, p) => a + p.sizeBytes, 0),
        trimStartSeconds: Math.round(trim[0]), trimEndSeconds: Math.round(trim[1]), quality, source: "recorded",
        comments: commentOut, attachments: attOut,
      });
      if (dirRef.current) await invoke("delete_session", { dir: dirRef.current }).catch(() => {});
      setMsg(""); setStage("sent");
    } catch (e) { setMsg(String(e)); setStage("review"); }
  };

  const discard = async () => {
    if (dirRef.current) await invoke("delete_session", { dir: dirRef.current }).catch(() => {});
    onDone();
  };

  const title = (
    <div className="topbar">
      <div className="brand">{stage === "setup" && <button className="linkbtn" onClick={onDone}>‹ Back</button>}<span>{link.title}</span>{link.sender && <span className="muted">from {link.sender.name}</span>}</div>
      {done && stage === "review" && <span className="chip">Recorded {fmt(done.duration_seconds)} · {comments.length} comment{comments.length === 1 ? "" : "s"}</span>}
    </div>
  );
  const centered = (c: React.ReactNode) => <>{title}<div className="page" style={{ justifyContent: "center" }}><div className="sendbox">{c}</div></div></>;

  if (stage === "sent") return centered(<><h1>Sent</h1><p className="muted">Thank you. Your recording is being turned into a document.</p><button className="btn lime" onClick={onDone}>Done</button></>);
  if (stage === "sending") return centered(<><h1>Sending…</h1><p className="muted">{msg || "Working…"}</p></>);
  if (stage === "countdown") return centered(<><div className="count" aria-live="assertive">{count || "●"}</div><p className="muted">Recording starts in {Math.max(count, 0)}…</p><button className="linkbtn" onClick={() => setStage("setup")}>Cancel</button></>);
  if (stage === "recording") return centered(<><h1>Recording</h1><p className="muted">Use the floating bar to pause, draw, comment or stop. It is never part of your recording.{upl > 0 ? ` ${upl} part${upl > 1 ? "s" : ""} already uploaded.` : ""}</p><button className="btn danger" onClick={finish}>Stop recording</button></>);

  if (stage === "review") return (
    <>{title}
      <div className="setup">
        <div className="left">
          {done ? <Player parts={done.parts} duration={done.duration_seconds} trim={trim} setTrim={setTrim} comments={comments} audioOnly={voiceOnly} />
            : <div className="preview"><span className="muted">{resume ? "Recovering your recording…" : "No recording. Add notes, comments or files to send."}</span></div>}
        </div>
        <div className="right">
          {resume && <div className="card muted" style={{ fontSize: 13 }}>This recording was interrupted before it was sent. Review it and send, or discard it.</div>}
          <div className="eyebrow">Your comments</div>
          {comments.length === 0 && <span className="muted">None. Use Comment on the floating bar while recording.</span>}
          {comments.map((c) => (
            <div className="row" key={c.id}>
              {c.shot ? <img className="thumb" style={{ objectFit: "cover" }} src={convertFileSrc(c.shot)} alt="" /> : <div className="thumb" />}
              <div className="meta"><b style={{ fontSize: 13 }}>{done && <span style={{ color: "var(--amber)" }}>{fmt(c.at)} </span>}{c.body}</b></div>
              <button className="linkbtn" aria-label="Remove comment" onClick={() => setComments((l) => l.filter((x) => x.id !== c.id))}>✕</button>
            </div>
          ))}
          <div className="field"><label htmlFor="notes" className="eyebrow">Notes</label><textarea id="notes" className="input" placeholder="Anything you want to add" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button className="btn" style={{ height: 36, fontSize: 13 }} onClick={addFiles}>+ Attach PDF or image</button>
            {attachments.map((a) => <span key={a.path} className="chip">{a.name} <button className="linkbtn" aria-label={`Remove ${a.name}`} onClick={() => setAttachments((l) => l.filter((x) => x !== a))}>✕</button></span>)}
          </div>
          <div className="spacer" />
          {msg && <p className="err">{msg}</p>}
          <button className="btn lime big" onClick={send} disabled={resume && !done}>Send{link.sender ? ` to ${link.sender.name.split(" ")[0]}` : ""}</button>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            {resume || noMedia ? <button className="linkbtn" onClick={discard}>{resume ? "Discard recording" : "Back"}</button>
              : <button className="linkbtn" onClick={() => { setDone(null); setComments([]); setAttachments([]); setStage("setup"); }}>Record again</button>}
          </div>
        </div>
      </div>
    </>
  );

  return (
    <>{title}
      <div className="setup">
        <div className="left">
          <div className="preview">
            {voiceOnly ? <span className="muted">Voice only: your screen is not recorded.</span>
              : previewImg ? <img src={previewImg} alt="Selected screen" style={{ width: "78%", borderRadius: 10, border: "1px solid #3d4541" }} /> : <div className="screen" />}
            {!voiceOnly && <span className="pill">{screens.find((s) => s.index === screen)?.name ?? "No screen found"}</span>}
          </div>
          <div className="card" style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span aria-hidden>🎙</span>
            <div style={{ flex: 1, display: "flex", gap: 3 }}>{Array.from({ length: 10 }, (_, i) => <i key={i} style={{ flex: 1, height: 8, borderRadius: 4, background: level * 10 > i ? "var(--lime)" : "var(--border)" }} />)}</div>
            <span className="muted">{mic ? (level > 0.05 ? "Mic is picking you up" : "Say something to test your mic") : "No microphone selected"}</span>
          </div>
        </div>
        <div className="right">
          {link.prompts && link.prompts.length > 0 && (<div><div className="eyebrow" style={{ marginBottom: 8 }}>What to cover</div><div className="card prompts">{link.prompts.map((p) => <div key={p}><i />{p}</div>)}</div></div>)}
          <div className="seg" role="group" aria-label="Mode"><button className={!voiceOnly ? "on" : ""} onClick={() => setVoiceOnly(false)}>Screen and voice</button><button className={voiceOnly ? "on" : ""} onClick={() => setVoiceOnly(true)}>Voice only</button></div>
          {!voiceOnly && <div className="field"><label htmlFor="scr">Screen</label><select id="scr" className="input" value={screen} onChange={(e) => setScreen(e.target.value)}>{screens.map((d) => <option key={d.index} value={d.index}>{d.name}</option>)}</select></div>}
          <div className="field"><label htmlFor="mic">Microphone</label><select id="mic" className="input" value={mic} onChange={(e) => setMic(e.target.value)}>{!voiceOnly && <option value="">No microphone</option>}{mics.map((d) => <option key={d.index} value={d.index}>{d.name}</option>)}</select></div>
          <label className="check"><input type="checkbox" checked={sysAudio} onChange={(e) => setSysAudio(e.target.checked)} />Include computer audio <span className="muted">(what you hear, e.g. a video you play)</span></label>
          {!voiceOnly && <div className="seg" role="group" aria-label="Quality">{(Object.keys(QUALITY) as Quality[]).map((q) => <button key={q} className={q === quality ? "on" : ""} onClick={() => setQuality(q)}>{LABEL[q]}</button>)}</div>}
          <div className="spacer" />
          {msg && <p className="err">{msg}</p>}
          <button className="btn lime big" onClick={startCountdown} disabled={voiceOnly ? !mic : !screen}><i className="rec-dot" style={{ width: 14, height: 14 }} />Start recording</button>
          <div style={{ textAlign: "center" }}><button className="linkbtn" onClick={() => { setDone(null); setStage("review"); }}>Send without recording</button></div>
          <div className="muted" style={{ textAlign: "center", fontSize: 12 }}>{link.maxDurationMin ? `Up to ${link.maxDurationMin} min · ` : ""}This window hides while you record</div>
        </div>
      </div>
    </>
  );
}

/** Plays the recorded parts back to back, with trim handles and comment markers on one session timeline. */
function Player({ parts, duration, trim, setTrim, comments, audioOnly }: { parts: PartInfo[]; duration: number; trim: [number, number]; setTrim: (t: [number, number]) => void; comments: Comment[]; audioOnly: boolean }) {
  const vid = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [idx, setIdx] = useState(0);
  const [t, setT] = useState(0);
  const pending = useRef<number | null>(null);
  const seek = (s: number) => {
    const loc = locate(parts, s); if (!loc) return;
    if (loc.index === idx) { if (vid.current) vid.current.currentTime = loc.offset; }
    else { pending.current = loc.offset; setIdx(loc.index); }
    setT(s);
  };
  const pct = (s: number) => `${(s / Math.max(1, duration)) * 100}%`;
  return (
    <>
      <div className="preview" style={{ overflow: "hidden" }}>
        {audioOnly && <div className="muted" style={{ position: "absolute", top: 16 }}>Voice-only recording</div>}
        <video ref={vid} key={idx} src={convertFileSrc(parts[idx]!.path)} controls style={audioOnly ? { width: "80%", height: 54 } : { maxWidth: "100%", maxHeight: "100%", borderRadius: 10 }}
          onLoadedMetadata={() => { if (pending.current != null && vid.current) { vid.current.currentTime = pending.current; pending.current = null; } }}
          onTimeUpdate={() => setT(parts[idx]!.start_seconds + (vid.current?.currentTime ?? 0))}
          onEnded={() => { if (idx < parts.length - 1) { pending.current = 0; setIdx(idx + 1); setTimeout(() => vid.current?.play(), 50); } }} />
      </div>
      <div className="card">
        <div style={{ position: "relative", height: 40 }}>
          <div className="track" />
          <div className="track keep" style={{ left: pct(trim[0]), right: `calc(100% - ${pct(trim[1])})` }} />
          {comments.map((c) => <button key={c.id} className="dot" aria-label={`Comment at ${fmt(c.at)}`} style={{ left: pct(c.at) }} onClick={() => seek(c.at)} />)}
          <input className="rng" type="range" aria-label="Trim start" min={0} max={duration} step={1} value={trim[0]} onChange={(e) => { const v = Math.min(+e.target.value, trim[1] - 1); setTrim([v, trim[1]]); seek(v); }} />
          <input className="rng" type="range" aria-label="Trim end" min={0} max={duration} step={1} value={trim[1]} onChange={(e) => { const v = Math.max(+e.target.value, trim[0] + 1); setTrim([trim[0], v]); seek(Math.max(0, v - 1)); }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
          <span>Start {fmt(trim[0])}</span><b style={{ color: "var(--fg)" }}>Sending {fmt(trim[1] - trim[0])} of {fmt(duration)} · now {fmt(t)}</b><span>End {fmt(trim[1])}</span>
        </div>
      </div>
    </>
  );
}
