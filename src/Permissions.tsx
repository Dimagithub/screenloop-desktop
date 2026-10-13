import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

const MAC = navigator.userAgent.includes("Mac");

async function micGranted(): Promise<boolean> {
  try {
    const s = await navigator.permissions.query({ name: "microphone" as PermissionName });
    if (s.state === "granted") return true;
    if (s.state === "denied") return false;
  } catch { /* not supported: fall through */ }
  // device names are only revealed once the microphone is allowed
  const d = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  return d.some((x) => x.kind === "audioinput" && x.label);
}

/** Screen Recording (macOS only) and microphone status; re-checks when the window regains focus. */
export function usePermissions() {
  const [p, setP] = useState<{ screen: boolean; mic: boolean } | null>(null);
  const check = useCallback(async () => {
    const [screen, mic] = await Promise.all([invoke<boolean>("screen_access").catch(() => true), micGranted().catch(() => false)]);
    setP((o) => (o && o.screen === screen && o.mic === mic ? o : { screen, mic }));
  }, []);
  useEffect(() => {
    check(); addEventListener("focus", check);
    const t = setInterval(check, 2000);
    return () => { removeEventListener("focus", check); clearInterval(t); };
  }, [check]);
  return { p, check };
}

const Row = ({ ok, title, text, children }: { ok: boolean; title: string; text: string; children?: React.ReactNode }) => (
  <div className="card" style={{ display: "flex", gap: 14, alignItems: "center", textAlign: "left" }}>
    <span className={`chip ${ok ? "ok" : "wait"}`} style={{ minWidth: 76, textAlign: "center" }}>{ok ? "Allowed" : "Needed"}</span>
    <div style={{ flex: 1 }}><b>{title}</b><div className="muted" style={{ fontSize: 13 }}>{text}</div></div>
    {!ok && <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>{children}</div>}
  </div>
);

/** First-run / missing-permission gate: everything is set up here before the user can record. */
export default function Permissions({ screen, mic, onContinue }: { screen: boolean; mic: boolean; onContinue: () => void }) {
  const [skipMic, setSkipMic] = useState(false);
  const [err, setErr] = useState("");
  const allowMic = async () => {
    setErr("");
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); }
    catch { setErr("The microphone was blocked. Switch it on in system settings, then come back."); }
  };
  const settings = (mac: string, win: string) => openUrl(MAC ? mac : win);
  const ready = screen && (mic || skipMic);
  return (
    <div className="page" style={{ justifyContent: "center" }}>
      <div style={{ maxWidth: 560, width: "100%", display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="hero"><h1>Let's get you set up</h1><p>ScreenLoop needs a couple of permissions before you can record. This only takes a minute.</p></div>
        {MAC && (
          <Row ok={screen} title="Screen recording" text="Lets ScreenLoop see your windows. Without it you would record only the wallpaper.">
            <button className="btn lime" style={{ height: 34, fontSize: 13 }} onClick={() => invoke("request_screen_access")}>Allow</button>
            <button className="linkbtn" onClick={() => settings("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture", "")}>Open System Settings</button>
          </Row>
        )}
        <Row ok={mic} title="Microphone" text="So your voice is part of the recording.">
          <button className="btn lime" style={{ height: 34, fontSize: 13 }} onClick={allowMic}>Allow</button>
          <button className="linkbtn" onClick={() => settings("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone", "ms-settings:privacy-microphone")}>Open {MAC ? "System Settings" : "Settings"}</button>
        </Row>
        {MAC && <div className="muted" style={{ fontSize: 13 }}>Computer audio: macOS asks the first time you record with "Include computer audio" ticked. Nothing to do now.</div>}
        {err && <p className="err">{err}</p>}
        {MAC && !screen && <div className="muted" style={{ fontSize: 12 }}>After switching Screen Recording on, macOS may ask you to quit and reopen ScreenLoop.</div>}
        <button className="btn lime big" disabled={!ready} onClick={onContinue}>Continue</button>
        {screen && !mic && !skipMic && <button className="linkbtn" onClick={() => setSkipMic(true)}>Continue without a microphone</button>}
      </div>
    </div>
  );
}
