import { useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Floating recording bar (its own always-on-top window, hidden from the recording). */
export default function Controls() {
  const [secs, setSecs] = useState(0);
  useEffect(() => { const t = setInterval(() => setSecs((s) => s + 1), 1000); return () => clearInterval(t); }, []);
  const mmss = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
  return (
    <div className="ctl" onMouseDown={(e) => { if ((e.target as HTMLElement).closest("button")) return; getCurrentWindow().startDragging(); }}>
      <div className="time"><i className="live" />{mmss}</div>
      <div className="drag" />
      <button className="stop" onClick={() => emit("controls-stop")}><i />Stop</button>
    </div>
  );
}
