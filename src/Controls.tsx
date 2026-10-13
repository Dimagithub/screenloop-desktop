import { useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface LiveSession { prompts: string[]; screen: string; hasMic: boolean; voiceOnly: boolean; maxSeconds: number }
export const SESSION_KEY = "sl-session";
export type Tool = "pen" | "arrow" | "box" | "highlight";
const COLORS = ["#ff4d4f", "#ffd23f", "#b9e84b", "#4da3ff"];
const TOOLS: { id: Tool; label: string; d: string }[] = [
  { id: "pen", label: "Pen", d: "M12 20h9|M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" },
  { id: "arrow", label: "Arrow", d: "M5 19 19 5|M9 5h10v10" },
  { id: "box", label: "Box", d: "M4 5h16v14H4Z" },
  { id: "highlight", label: "Highlighter", d: "m9 11-6 6v3h9l3-3|m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" },
];
const Ico = ({ d, size = 20 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d.split("|").map((x) => <path key={x} d={x} />)}</svg>
);
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s) % 60).padStart(2, "0")}`;

type Panel = null | "draw" | "comment" | "prompts";

/** Floating recording bar: its own always-on-top window, excluded from the recording. */
export default function Controls() {
  const session: LiveSession = (() => { try { return JSON.parse(localStorage.getItem(SESSION_KEY) ?? ""); } catch { return { prompts: [], screen: "0", hasMic: false, voiceOnly: false, maxSeconds: 0 }; } })();
  const [st, setSt] = useState({ elapsed: 0, paused: false, muted: false });
  const [panel, setPanel] = useState<Panel>(null);
  const [drawOn, setDrawOn] = useState(false);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]!);
  const [shot, setShot] = useState<{ path: string; at: number } | null>(null);
  const [text, setText] = useState("");
  const [stopping, setStopping] = useState(false);
  const pausedForComment = useRef(false);
  const overlayOpen = useRef(false);

  useEffect(() => { document.documentElement.style.background = "transparent"; document.body.style.background = "transparent"; }, []);
  const busy = useRef(false);
  useEffect(() => {
    const t = setInterval(() => { if (!busy.current) invoke<typeof st>("recording_state").then(setSt).catch(() => {}); }, 400);
    return () => clearInterval(t);
  }, []);

  // Time limit from the link: stop automatically, warn in the last minute.
  const left = session.maxSeconds > 0 ? Math.max(0, session.maxSeconds - st.elapsed) : null;
  const stopped = useRef(false);
  useEffect(() => { if (left === 0 && !stopped.current) { stopped.current = true; emit("controls-stop"); } }, [left]);

  // Draw to comment: a finished markup stroke becomes a comment with its own screenshot (debounced).
  const strokeTimer = useRef<number>(0);
  useEffect(() => {
    const un = listen("stroke-done", () => {
      invoke("raise_controls").catch(() => {});
      clearTimeout(strokeTimer.current);
      strokeTimer.current = window.setTimeout(async () => {
        try {
          const at = (await invoke<{ elapsed: number }>("recording_state")).elapsed;
          const path = await invoke<string>("screenshot", { screen: session.screen });
          emit("comment-added", { id: crypto.randomUUID(), at, body: "Marked on screen", shot: path });
        } catch { /* recording may have stopped */ }
      }, 1500);
    });
    return () => { un.then((f) => f()); clearTimeout(strokeTimer.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const heights: Record<string, number> = { draw: 64, comment: 270, prompts: Math.min(60 + session.prompts.length * 34, 260) };
  useEffect(() => { invoke("set_controls_height", { height: 72 + (panel ? heights[panel]! + 8 : 0) }).catch(() => {}); }, [panel]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flip the button at once; the backend (restarting ffmpeg) catches up, then the real state is read back.
  const act = async (patch: Partial<typeof st>, cmd: string, args?: Record<string, unknown>) => {
    busy.current = true; setSt((s) => ({ ...s, ...patch }));
    try { await invoke(cmd, args); } catch { /* state is re-read below */ }
    busy.current = false; invoke<typeof st>("recording_state").then(setSt).catch(() => {});
  };
  const togglePause = () => act({ paused: !st.paused }, st.paused ? "resume_recording" : "pause_recording");
  const toggleMute = () => act({ muted: !st.muted }, "set_mute", { muted: !st.muted });

  const setDraw = async (on: boolean) => {
    if (on && !overlayOpen.current) { await invoke("open_overlay", { screen: session.screen }); overlayOpen.current = true; }
    await invoke("set_overlay_interactive", { on }).catch(() => {});
    setDrawOn(on);
    if (on) { emit("draw-tool", { tool, color }); }
  };
  useEffect(() => {
    const un = listen("draw-exit", () => { setPanel((p) => (p === "draw" ? null : p)); setDraw(false); });
    return () => { un.then((f) => f()); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const openDraw = () => { if (panel === "draw") { setPanel(null); setDraw(false); } else { setPanel("draw"); setDraw(true); } };
  useEffect(() => { if (drawOn) { emit("draw-tool", { tool, color }); invoke("raise_controls").catch(() => {}); } }, [tool, color, drawOn]);

  const openComment = async () => {
    if (panel === "comment") return;
    if (drawOn) await setDraw(false);
    const wasPaused = st.paused;
    if (!wasPaused) { await invoke("pause_recording"); pausedForComment.current = true; }
    try {
      const at = (await invoke<typeof st>("recording_state")).elapsed;
      const path = session.voiceOnly ? "" : await invoke<string>("screenshot", { screen: session.screen });
      setShot({ path, at });
    } catch { setShot(null); }
    setText(""); setPanel("comment");
  };
  const closeComment = async (save: boolean) => {
    if (save && text.trim()) emit("comment-added", { id: crypto.randomUUID(), at: shot?.at ?? st.elapsed, body: text.trim(), shot: shot?.path || null });
    setPanel(null); setShot(null);
    if (pausedForComment.current) { pausedForComment.current = false; await invoke("resume_recording"); }
  };

  const Btn = ({ label, icon, on, onClick, disabled, title }: { label: string; icon: string; on?: boolean; onClick: () => void; disabled?: boolean; title?: string }) => (
    <button className={`cb ${on ? "on" : ""}`} onClick={onClick} disabled={disabled} title={title}><Ico d={icon} /><span>{label}</span></button>
  );

  return (
    <div className="ctl-wrap" onMouseDown={(e) => { if ((e.target as HTMLElement).closest("button,textarea,input")) return; getCurrentWindow().startDragging(); }}>
      {panel === "draw" && (
        <div className="tray" style={{ height: heights.draw }}>
          {TOOLS.map((t) => <button key={t.id} aria-label={t.label} title={t.label} className={`tb ${tool === t.id ? "on" : ""}`} onClick={() => setTool(t.id)}><Ico d={t.d} /></button>)}
          <i className="sep" />
          {COLORS.map((c) => <button key={c} aria-label={`Color ${c}`} className={`sw ${color === c ? "on" : ""}`} style={{ background: c }} onClick={() => setColor(c)} />)}
          <i className="sep" />
          <button className="tb" aria-label="Undo" title="Undo" onClick={() => emit("draw-undo")}><Ico d="M9 14 4 9l5-5|M4 9h10a6 6 0 0 1 0 12h-3" /></button>
          <button className="tb txt" onClick={() => emit("draw-clear")}>Clear</button>
        </div>
      )}
      {panel === "comment" && (
        <div className="tray col" style={{ height: heights.comment }}>
          {shot?.path && <img src={convertFileSrc(shot.path)} alt="Frozen screen" className="shot" />}
          <textarea autoFocus className="cin" placeholder="What do you want to say about this?" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) closeComment(true); }} />
          <div className="crow"><button className="tb txt" onClick={() => closeComment(false)}>Cancel</button><button className="save" onClick={() => closeComment(true)}>Save comment</button></div>
        </div>
      )}
      {panel === "prompts" && (
        <div className="tray col" style={{ height: heights.prompts, alignItems: "stretch" }}>
          <div className="eyebrow">What to cover</div>
          {session.prompts.map((p) => <div key={p} className="pr"><i />{p}</div>)}
        </div>
      )}
      <div className="ctl">
        <div className="time"><i className={`live ${st.paused ? "off" : ""}`} />{mmss(st.elapsed)}{left !== null && left <= 60 && <span className="warn">{Math.ceil(left)}s left</span>}</div>
        <Btn label={st.paused ? "Resume" : "Pause"} icon={st.paused ? "M8 5v14l11-7Z" : "M6 5h4v14H6Z|M14 5h4v14h-4Z"} onClick={togglePause} disabled={panel === "comment"} />
        {!session.voiceOnly && <Btn label="Draw" icon="M12 20h9|M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" on={panel === "draw"} onClick={openDraw} />}
        <Btn label="Comment" icon="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12Z" on={panel === "comment"} onClick={openComment} />
        <Btn label={st.muted ? "Unmute" : "Mute"} icon={st.muted ? "M3 3l18 18|M9 9v3a3 3 0 0 0 5.1 2.1|M15 9.3V6a3 3 0 0 0-5.7-1.3|M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.9 3.4M12 18v3" : "M9 3h6v12H9Z|M5 11a7 7 0 0 0 14 0M12 18v3"} on={st.muted} onClick={toggleMute} disabled={!session.hasMic || panel === "comment"} title={session.hasMic ? "" : "No microphone selected"} />
        {session.prompts.length > 0 && <Btn label="Prompts" icon="M9 6h11M9 12h11M9 18h11|m3.5 6 1 1 2-2" on={panel === "prompts"} onClick={() => setPanel(panel === "prompts" ? null : "prompts")} />}
        <div className="grow" />
        <button className="stop" disabled={stopping} onClick={() => { setStopping(true); emit("controls-stop"); }}><i />{stopping ? "Stopping…" : "Stop"}</button>
      </div>
    </div>
  );
}
