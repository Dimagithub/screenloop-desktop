import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { supabase } from "./lib/supabase";
import { api, tokenFromInput, type ResolvedLink } from "./lib/api";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import Recorder, { type Manifest } from "./Recorder";
import UploadVideo from "./UploadVideo";
import Permissions, { usePermissions } from "./Permissions";
import Recordings, { useLibrary, type Library } from "./Recordings";

type Rec = { token: string; link: ResolvedLink; filesOnly?: boolean; resume?: { dir: string; manifest: Manifest } };
interface Unsent { dir: string; manifest: string }

const Icon = ({ d }: { d: string }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d.split("|").map((x) => <path key={x} d={x} />)}</svg>
);

function SignIn({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [waiting, setWaiting] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setErr(error.message); else onBack();
  };
  // Google (and email on the web page): sign in in the system browser, tokens come back over a loopback port.
  const browser = async () => {
    setErr(""); setWaiting(true);
    try {
      const state = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const un = await listen<string>("auth-callback", async (ev) => {
        un();
        const q = new URLSearchParams(ev.payload);
        if (q.get("state") !== state) { setErr("Sign-in was not recognised. Try again."); return setWaiting(false); }
        const { error } = await supabase.auth.setSession({ access_token: q.get("access_token") ?? "", refresh_token: q.get("refresh_token") ?? "" });
        if (error) setErr(error.message); else onBack();
        setWaiting(false);
      });
      const port = await invoke<number>("start_auth_listener");
      await openUrl(`${import.meta.env.VITE_WEB_URL}/desktop-auth?port=${port}&state=${state}`);
    } catch (e) { setErr(String(e)); setWaiting(false); }
  };
  return (
    <form className="sendbox" onSubmit={submit} style={{ width: 340, textAlign: "left" }}>
      <h1 style={{ fontSize: 28 }}>Sign in</h1>
      <button type="button" className="btn lime big" style={{ height: 48, fontSize: 15 }} onClick={browser} disabled={waiting}>{waiting ? "Finish signing in in your browser…" : "Continue with Google"}</button>
      <div className="muted" style={{ textAlign: "center", width: "100%" }}>or</div>
      <input className="input" style={{ width: "100%" }} aria-label="Email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input className="input" style={{ width: "100%" }} aria-label="Password" placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button className="btn lime big" style={{ height: 48, fontSize: 15 }}>Sign in</button>
      <button type="button" className="linkbtn" onClick={onBack}>Back</button>
      {err && <p className="err">{err}</p>}
    </form>
  );
}

function UpdateLink() {
  const [msg, setMsg] = useState("");
  const run = async () => {
    setMsg("Checking…");
    try {
      const u = await check();
      if (!u) return setMsg("You're up to date");
      setMsg(`Installing ${u.version}…`);
      await u.downloadAndInstall();
      await relaunch();
    } catch (e) { setMsg(String(e)); }
  };
  return <><button className="linkbtn" onClick={run}>Check for updates</button>{msg && <span>{msg}</span>}</>;
}

/** Checks on launch and offers the update right on the first screen, even before permissions are set up. */
function UpdateBanner() {
  const [v, setV] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => { check().then((u) => setV(u?.version ?? null)).catch(() => {}); }, []);
  if (!v) return null;
  const run = async () => {
    setMsg("Downloading…");
    try { const u = await check(); await u?.downloadAndInstall(); await relaunch(); } catch (e) { setMsg(String(e)); }
  };
  return <div className="card" style={{ margin: "8px 20px 0", display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between" }}><span><b>ScreenLoop {v} is available.</b> <span className="muted">{msg || `You have ${__APP_VERSION__}.`}</span></span><button className="btn lime" style={{ height: 34, fontSize: 13 }} onClick={run} disabled={!!msg && msg === "Downloading…"}>Update now</button></div>;
}

function Home({ session, lib, onOpen, onUpload, onSignIn, onAll }: { session: Session | null; lib: Library; onOpen: (r: Rec) => void; onUpload: () => void; onSignIn: () => void; onAll: () => void }) {
  const [input, setInput] = useState("");
  const [err, setErr] = useState("");
  const [unsent, setUnsent] = useState<{ dir: string; m: Manifest }[]>([]);
  useEffect(() => {
    invoke<Unsent[]>("list_unsent").then((l) => setUnsent(l.flatMap((u) => { try { return [{ dir: u.dir, m: JSON.parse(u.manifest) as Manifest }]; } catch { return []; } }))).catch(() => {});
  }, []);
  const resumeOne = async (u: { dir: string; m: Manifest }) => {
    setErr("");
    try {
      const link = await api<ResolvedLink>("resolve-link", { token: u.m.token });
      if (link.state !== "ok") return setErr(`The link for this recording is ${link.state}, so it can no longer be sent.`);
      onOpen({ token: u.m.token, link, resume: { dir: u.dir, manifest: u.m } });
    } catch (e) { setErr((e as Error).message); }
  };
  const discardOne = async (u: { dir: string }) => { await invoke("delete_session", { dir: u.dir }).catch(() => {}); setUnsent((l) => l.filter((x) => x.dir !== u.dir)); };
  const recent = lib.recs.slice(0, 3);
  const newCount = lib.docs.filter((d) => lib.isNew(d.id)).length;

  const openLink = async (raw: string) => {
    setErr("");
    const token = tokenFromInput(raw);
    if (!token) return setErr("That doesn't look like a recording link.");
    try {
      const link = await api<ResolvedLink>("resolve-link", { token });
      if (link.state !== "ok") return setErr(`This link is ${link.state}.`);
      onOpen({ token, link });
    } catch (e) { setErr((e as Error).message); }
  };
  const startSelf = async (filesOnly = false) => {
    if (!session) return onSignIn();
    setErr("");
    try {
      const { token } = await api<{ token: string }>("start-recording", { title: filesOnly ? "Files" : "Screen recording", source: "recorded" });
      const link = await api<ResolvedLink>("resolve-link", { token });
      if (link.state !== "ok") return setErr(`This link is ${link.state}.`);
      onOpen({ token, link, filesOnly });
    } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="page">
      <div className="hero"><h1>What do you want to record?</h1><p>Share your screen and talk it through. We turn it into a document.</p></div>
      <div className="tiles">
        <button className="tile primary" onClick={() => startSelf()}>
          <div className="ico"><i className="rec-dot" /></div><div><b>New recording</b><span>Screen and voice</span></div>
        </button>
        <button className="tile" onClick={() => document.getElementById("link")?.focus()}>
          <div className="ico"><Icon d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1|M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" /></div><div><b>Open a link</b><span>Someone asked for feedback</span></div>
        </button>
        <button className="tile" onClick={() => (session ? onUpload() : onSignIn())}>
          <div className="ico"><Icon d="M12 16V4|m7 9 5-5 5 5|M5 20h14" /></div><div><b>Upload a video</b><span>Use an existing file</span></div>
        </button>
        <button className="tile" onClick={() => startSelf(true)}>
          <div className="ico"><Icon d="M21 12.5 12.5 21a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6l8.5-8.4" /></div><div><b>Send files</b><span>PDFs and images</span></div>
        </button>
      </div>
      <form className="joinbar" onSubmit={(e) => { e.preventDefault(); openLink(input); }}>
        <input id="link" className="input" aria-label="Recording link" placeholder="Paste a recording link" value={input} onChange={(e) => setInput(e.target.value)} />
        <button className="btn">Join</button>
      </form>
      {err && <p className="err">{err}</p>}
      {unsent.length > 0 && (
        <div className="list">
          <div className="eyebrow">Unsent recordings</div>
          {unsent.map((u) => (
            <div className="row" key={u.dir}>
              <div className="thumb" />
              <div className="meta"><b>{u.m.link.title}</b><span className="muted">Interrupted · {new Date(u.m.savedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span></div>
              <button className="btn" style={{ height: 34, fontSize: 13 }} onClick={() => resumeOne(u)}>Review and send</button>
              <button className="linkbtn" onClick={() => discardOne(u)}>Discard</button>
            </div>
          ))}
        </div>
      )}
      {session && recent.length > 0 && (
        <div className="list">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}><div className="eyebrow">Recent{newCount > 0 && <span className="newdot" title="New documents" />}</div><button className="linkbtn" onClick={onAll}>{newCount > 0 ? `${newCount} new document${newCount > 1 ? "s" : ""} · ` : ""}View all</button></div>
          {recent.map((r) => (
            <div className="row" key={r.id} onClick={onAll} style={{ cursor: "pointer" }}>
              <div className="thumb" />
              <div className="meta"><b>{r.title}</b><span className="muted">{new Date(r.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · {Math.max(1, Math.round((r.duration_seconds ?? 0) / 60))} min</span></div>
              {(() => { const n = lib.docs.filter((d) => d.submission_id === r.id && lib.isNew(d.id)).length; return <span className={`chip ${n || r.transcript_status === "done" ? "ok" : "wait"}`}>{n ? `${n} new document${n > 1 ? "s" : ""}` : r.transcript_status === "done" ? "Document ready" : "Processing"}</span>; })()}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [signIn, setSignIn] = useState(false);
  const [rec, setRec] = useState<Rec | null>(null);
  const [upload, setUpload] = useState(false);
  const [all, setAll] = useState(false);
  const [micSkipped, setMicSkipped] = useState(() => { try { return localStorage.getItem("sl-mic-skipped") === "1"; } catch { return false; } });
  const perms = usePermissions();
  const lib = useLibrary(!!session);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  // screenloop://r/<token> (from a browser or a link in an email) opens that recording.
  const openRef = useRef<(raw: string) => void>(() => {});
  openRef.current = async (raw: string) => {
    if (rec) return; // already in the middle of something
    const token = tokenFromInput(raw.replace(/^screenloop:\/\//, ""));
    if (!token) return;
    try {
      const link = await api<ResolvedLink>("resolve-link", { token });
      if (link.state === "ok") { setUpload(false); setRec({ token, link }); }
    } catch { /* ignore a bad link */ }
  };
  useEffect(() => {
    getCurrent().then((urls) => urls?.forEach((u) => openRef.current(u))).catch(() => {});
    const un = onOpenUrl((urls) => urls.forEach((u) => openRef.current(u)));
    return () => { un.then((f) => f()); };
  }, []);
  if (!ready || !perms.p) return null;
  // Everything must be allowed (or the microphone knowingly skipped) before the app is usable.
  if (!rec && !(perms.p.screen && (perms.p.mic || micSkipped))) return <div className="app"><div className="topbar"><div className="brand"><div className="logo"><i /></div>ScreenLoop</div></div><UpdateBanner /><Permissions screen={perms.p.screen} mic={perms.p.mic} onContinue={() => { setMicSkipped(true); try { localStorage.setItem("sl-mic-skipped", "1"); } catch { /* ignore */ } }} /><div className="footer">Version {__APP_VERSION__} · <UpdateLink /></div></div>;
  if (upload) return <div className="app"><div className="topbar"><div className="brand"><div className="logo"><i /></div>ScreenLoop</div></div><UploadVideo onDone={() => setUpload(false)} /></div>;
  if (rec) return <div className="app"><Recorder key={rec.resume?.dir ?? rec.token} token={rec.token} link={rec.link} resume={rec.resume} filesOnly={rec.filesOnly} onDone={() => setRec(null)} /></div>;
  return (
    <div className="app">
      <div className="topbar">
        <div className="brand"><div className="logo"><i /></div>ScreenLoop</div>
        {session
          ? <div style={{ display: "flex", alignItems: "center", gap: 12 }}><span className="muted">{session.user.email}</span><div className="avatar">{(session.user.email ?? "?").slice(0, 2).toUpperCase()}</div><button className="linkbtn" onClick={() => supabase.auth.signOut()}>Sign out</button></div>
          : <button className="linkbtn" onClick={() => setSignIn(true)}>Sign in</button>}
      </div>
      <UpdateBanner />
      {all && session ? <Recordings lib={lib} onBack={() => setAll(false)} /> : signIn && !session ? <div className="page" style={{ justifyContent: "center" }}><SignIn onBack={() => setSignIn(false)} /></div> : <Home session={session} lib={lib} onOpen={setRec} onUpload={() => setUpload(true)} onSignIn={() => setSignIn(true)} onAll={() => setAll(true)} />}
      <div className="footer">Version {__APP_VERSION__} · <UpdateLink /></div>
    </div>
  );
}
