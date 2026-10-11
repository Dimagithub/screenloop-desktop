import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { api, tokenFromInput, type ResolvedLink } from "./lib/api";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import Recorder from "./Recorder";
import "./App.css";

type Session_ = { token: string; link: ResolvedLink } | null;

function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setErr(error.message);
  };
  return (
    <form className="col" onSubmit={submit}>
      <h1>Sign in</h1>
      <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button>Sign in</button>
      {err && <p className="err">{err}</p>}
      {/* Google: pending spike (Lovable broker + deep-link redirect) */}
    </form>
  );
}

function Home({ session }: { session: Session | null }) {
  const [input, setInput] = useState("");
  const [rec, setRec] = useState<Session_>(null);
  const [err, setErr] = useState("");

  const openLink = async (raw: string) => {
    setErr("");
    const token = tokenFromInput(raw);
    if (!token) return setErr("That doesn't look like a recording link.");
    try {
      const link = await api<ResolvedLink>("resolve-link", { token });
      if (link.state !== "ok") return setErr(`This link is ${link.state}.`);
      setRec({ token, link });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const startSelf = async () => {
    setErr("");
    try {
      const { token } = await api<{ token: string }>("start-recording", { title: "Desktop recording", source: "recorded" });
      await openLink(token);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (rec) return <Recorder token={rec.token} link={rec.link} onDone={() => setRec(null)} />;

  return (
    <div className="col">
      <h1>ScreenLoop</h1>
      <input placeholder="Paste a recording link" value={input} onChange={(e) => setInput(e.target.value)} />
      <button onClick={() => openLink(input)}>Open link</button>
      {session && <button onClick={startSelf}>Start recording</button>}
      {err && <p className="err">{err}</p>}
      {session ? <button onClick={() => supabase.auth.signOut()}>Sign out ({session.user.email})</button> : null}
    </div>
  );
}

function UpdateButton() {
  const [msg, setMsg] = useState("");
  const run = async () => {
    setMsg("Checking…");
    try {
      const u = await check();
      if (!u) return setMsg("You're up to date.");
      setMsg(`Installing ${u.version}…`);
      await u.downloadAndInstall();
      await relaunch();
    } catch (e) { setMsg(String(e)); }
  };
  return <p className="upd"><button onClick={run}>Check for updates</button> {msg}</p>;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  if (!ready) return null;
  if (!session && showSignIn) return <SignIn />;
  return (
    <main className="container">
      <Home session={session} />
      <UpdateButton />
      {!session && <button onClick={() => setShowSignIn(true)}>Sign in</button>}
    </main>
  );
}
