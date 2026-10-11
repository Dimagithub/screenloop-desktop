import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { supabase } from "./lib/supabase";
import { api, tokenFromInput, type ResolvedLink } from "./lib/api";
import Recorder from "./Recorder";

type Rec = { token: string; link: ResolvedLink };
interface Recent { id: string; title: string; created_at: string; duration_seconds: number; transcript_status: string | null }

const Icon = ({ d }: { d: string }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d.split("|").map((x) => <path key={x} d={x} />)}</svg>
);

function SignIn({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setErr(error.message); else onBack();
  };
  return (
    <form className="sendbox" onSubmit={submit} style={{ width: 340, textAlign: "left" }}>
      <h1 style={{ fontSize: 28 }}>Sign in</h1>
      <input className="input" style={{ width: "100%" }} aria-label="Email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input className="input" style={{ width: "100%" }} aria-label="Password" placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button className="btn lime big">Sign in</button>
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

function Home({ session, onOpen }: { session: Session | null; onOpen: (r: Rec) => void }) {
  const [input, setInput] = useState("");
  const [err, setErr] = useState("");
  const [recent, setRecent] = useState<Recent[]>([]);
  useEffect(() => {
    if (session) api<Recent[]>("my-recordings").then((r) => setRecent(r.slice(0, 3))).catch(() => {});
  }, [session]);

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
  const startSelf = async () => {
    setErr("");
    try {
      const { token } = await api<{ token: string }>("start-recording", { title: "Screen recording", source: "recorded" });
      await openLink(token);
    } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="page">
      <div className="hero"><h1>What do you want to record?</h1><p>Share your screen and talk it through. We turn it into a document.</p></div>
      <div className="tiles">
        <button className="tile primary" onClick={startSelf} disabled={!session} title={session ? "" : "Sign in to record on your own"}>
          <div className="ico"><i className="rec-dot" /></div><div><b>New recording</b><span>Screen and voice</span></div>
        </button>
        <button className="tile" onClick={() => document.getElementById("link")?.focus()}>
          <div className="ico"><Icon d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1|M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" /></div><div><b>Open a link</b><span>Someone asked for feedback</span></div>
        </button>
        <button className="tile" disabled title="Coming soon">
          <div className="ico"><Icon d="M12 16V4|m7 9 5-5 5 5|M5 20h14" /></div><div><b>Upload a video</b><span>Coming soon</span></div>
        </button>
      </div>
      <form className="joinbar" onSubmit={(e) => { e.preventDefault(); openLink(input); }}>
        <input id="link" className="input" aria-label="Recording link" placeholder="Paste a recording link" value={input} onChange={(e) => setInput(e.target.value)} />
        <button className="btn">Join</button>
      </form>
      {err && <p className="err">{err}</p>}
      {session && recent.length > 0 && (
        <div className="list">
          <div className="eyebrow">Recent</div>
          {recent.map((r) => (
            <div className="row" key={r.id}>
              <div className="thumb" />
              <div className="meta"><b>{r.title}</b><span className="muted">{new Date(r.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · {Math.max(1, Math.round(r.duration_seconds / 60))} min</span></div>
              <span className={`chip ${r.transcript_status === "done" ? "ok" : "wait"}`}>{r.transcript_status === "done" ? "Document ready" : "Processing"}</span>
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
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  if (!ready) return null;
  if (rec) return <div className="app"><Recorder token={rec.token} link={rec.link} onDone={() => setRec(null)} /></div>;
  return (
    <div className="app">
      <div className="topbar">
        <div className="brand"><div className="logo"><i /></div>ScreenLoop</div>
        {session
          ? <div style={{ display: "flex", alignItems: "center", gap: 12 }}><span className="muted">{session.user.email}</span><div className="avatar">{(session.user.email ?? "?").slice(0, 2).toUpperCase()}</div><button className="linkbtn" onClick={() => supabase.auth.signOut()}>Sign out</button></div>
          : <button className="linkbtn" onClick={() => setSignIn(true)}>Sign in</button>}
      </div>
      {signIn && !session ? <div className="page" style={{ justifyContent: "center" }}><SignIn onBack={() => setSignIn(false)} /></div> : <Home session={session} onOpen={setRec} />}
      <div className="footer">Version {__APP_VERSION__} · <UpdateLink /></div>
    </div>
  );
}
