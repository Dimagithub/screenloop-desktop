import { useEffect } from "react";

/** Colour frame drawn around the screen that will be recorded (click-through window). */
export default function Frame() {
  useEffect(() => { document.documentElement.style.background = "transparent"; document.body.style.background = "transparent"; }, []);
  return (
    <div style={{ position: "fixed", inset: 0, border: "6px solid #b9e84b", boxSizing: "border-box", borderRadius: 8, pointerEvents: "none", boxShadow: "inset 0 0 0 2px rgba(27,31,29,.6)" }}>
      <div style={{ position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)", background: "#b9e84b", color: "#1b1f1d", font: "700 13px 'DM Sans', system-ui, sans-serif", padding: "6px 14px", borderRadius: "0 0 10px 10px" }}>This screen will be recorded</div>
    </div>
  );
}
