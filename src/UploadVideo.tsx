import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { api } from "./lib/api";

type Upload = { path: string; signedUrl: string };
const MAX = 500 * 1024 * 1024; // same limit as the web uploader

/** Upload an existing video: audio is cut into WAV pieces locally for the transcript, video goes up as one part. */
export default function UploadVideo({ onDone }: { onDone: () => void }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const run = async () => {
    setMsg("");
    const path = await pickFile({ multiple: false, filters: [{ name: "Video", extensions: ["mp4", "mov", "webm", "mkv", "m4v"] }] });
    if (!path || Array.isArray(path)) return;
    setBusy(true);
    try {
      const size = await invoke<number>("file_size", { path });
      if (size > MAX) throw new Error("That video is over 500 MB.");
      setMsg("Preparing audio…");
      const ex = await invoke<{ segments: { path: string; start: number }[]; duration_seconds: number }>("extract_audio_segments", { path });
      const { token } = await api<{ token: string }>("start-recording", { title: path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "").slice(0, 160) || "Uploaded video", source: "upload", chunkMinutes: 90 });
      setMsg("Uploading video…");
      const ext = path.toLowerCase().endsWith(".webm") ? "webm" : "mp4";
      const v = await api<Upload>("create-upload", { token, ext, part: 0 });
      await invoke("upload_file", { path, url: v.signedUrl, contentType: ext === "webm" ? "video/webm" : "video/mp4" });
      setMsg("Uploading audio…");
      const slots = await api<Upload[]>("audio-segment-uploads", { token, count: ex.segments.length });
      for (const [i, s] of slots.entries()) await invoke("upload_file", { path: ex.segments[i]!.path, url: s.signedUrl, contentType: "audio/wav" });
      await api("finalize", {
        token, path: v.path, origin: import.meta.env.VITE_WEB_URL, durationSeconds: ex.duration_seconds, sizeBytes: size,
        trimStartSeconds: 0, trimEndSeconds: ex.duration_seconds, quality: "moderate", source: "upload",
        parts: [{ path: v.path, audioPath: null, audioSegments: slots.map((s, i) => ({ path: s.path, start: ex.segments[i]!.start })), startSeconds: 0, durationSeconds: ex.duration_seconds, sizeBytes: size }],
      });
      setSent(true);
    } catch (e) { setMsg(String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="page" style={{ justifyContent: "center" }}>
      <div className="sendbox">
        <h1>{sent ? "Uploaded" : "Upload a video"}</h1>
        <p className="muted">{sent ? "Your video is being turned into a document." : "Pick a video up to 500 MB. We transcribe it and write the document."}</p>
        {!sent && <button className="btn lime" onClick={run} disabled={busy}>{busy ? "Working…" : "Choose a video"}</button>}
        {msg && <p className={sent ? "muted" : busy ? "muted" : "err"}>{msg}</p>}
        <button className="linkbtn" onClick={onDone} disabled={busy}>{sent ? "Done" : "Back"}</button>
      </div>
    </div>
  );
}
