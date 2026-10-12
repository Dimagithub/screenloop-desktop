import { useEffect, useRef } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import type { Tool } from "./Controls";

interface Shape { tool: Tool; color: string; pts: [number, number][] }

/** Transparent full-screen canvas. Unlike the control bar it IS captured, so markup lands in the video. */
export default function Overlay() {
  const ref = useRef<HTMLCanvasElement>(null);
  const shapes = useRef<Shape[]>([]);
  const cur = useRef<Shape | null>(null);
  const tool = useRef<{ tool: Tool; color: string }>({ tool: "pen", color: "#ff4d4f" });

  const draw = () => {
    const c = ref.current!, g = c.getContext("2d")!;
    g.clearRect(0, 0, c.width, c.height);
    for (const s of [...shapes.current, ...(cur.current ? [cur.current] : [])]) paint(g, s, c.width, c.height);
  };

  useEffect(() => {
    document.documentElement.style.background = "transparent"; document.body.style.background = "transparent";
    const c = ref.current!;
    const fit = () => { c.width = innerWidth * devicePixelRatio; c.height = innerHeight * devicePixelRatio; draw(); };
    fit(); addEventListener("resize", fit);
    // Ways out of drawing: Esc, right-click, or the Draw button on the bar.
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") emit("draw-exit"); };
    addEventListener("keydown", key);
    const subs = [
      listen<{ tool: Tool; color: string }>("draw-tool", (e) => { tool.current = e.payload; }),
      listen("draw-undo", () => { shapes.current.pop(); draw(); }),
      listen("draw-clear", () => { shapes.current = []; draw(); }),
    ];
    return () => { removeEventListener("resize", fit); removeEventListener("keydown", key); subs.forEach((s) => s.then((f) => f())); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pt = (e: React.PointerEvent): [number, number] => [e.clientX / innerWidth, e.clientY / innerHeight];
  return (
    <canvas ref={ref} onContextMenu={(e) => { e.preventDefault(); emit("draw-exit"); }} style={{ position: "fixed", inset: 0, width: "100vw", height: "100vh", cursor: "crosshair", touchAction: "none" }}
      onPointerDown={(e) => { (e.target as Element).setPointerCapture(e.pointerId); cur.current = { ...tool.current, pts: [pt(e)] }; }}
      onPointerMove={(e) => { if (!cur.current) return; const s = cur.current; if (s.tool === "pen" || s.tool === "highlight") s.pts.push(pt(e)); else s.pts[1] = pt(e); draw(); }}
      onPointerUp={() => { if (cur.current && cur.current.pts.length > 1) { shapes.current.push(cur.current); emit("stroke-done"); } cur.current = null; draw(); }} />
  );
}

function paint(g: CanvasRenderingContext2D, s: Shape, W: number, H: number) {
  const P = s.pts.map(([x, y]) => [x * W, y * H] as [number, number]);
  if (P.length < 2) return;
  g.lineCap = "round"; g.lineJoin = "round"; g.strokeStyle = s.color; g.lineWidth = (s.tool === "highlight" ? 22 : 5) * devicePixelRatio;
  g.globalAlpha = s.tool === "highlight" ? 0.35 : 1;
  g.beginPath();
  if (s.tool === "box") { const [a, b] = [P[0]!, P[P.length - 1]!]; g.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); }
  else {
    g.moveTo(...P[0]!);
    if (s.tool === "arrow") { const a = P[0]!, b = P[P.length - 1]!; g.lineTo(...b); const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), L = 22 * devicePixelRatio; for (const d of [0.5, -0.5]) { g.moveTo(...b); g.lineTo(b[0] - L * Math.cos(ang - d), b[1] - L * Math.sin(ang - d)); } }
    else for (const p of P.slice(1)) g.lineTo(...p);
    g.stroke();
  }
  g.globalAlpha = 1;
}
