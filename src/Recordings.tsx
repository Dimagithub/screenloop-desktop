import { useCallback, useEffect, useState } from "react";
import Markdown from "react-markdown";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "./lib/api";

export interface Rec { id: string; title: string; created_at: string; duration_seconds: number | null; transcript_status: string | null }
export interface Doc { id: string; submission_id: string; parser_name: string; created_at: string }
const SEEN = "sl-seen-docs";
const readSeen = (): Set<string> | null => { try { const v = localStorage.getItem(SEEN); return v ? new Set(JSON.parse(v)) : null; } catch { return null; } };
const writeSeen = (s: Set<string>) => { try { localStorage.setItem(SEEN, JSON.stringify([...s])); } catch { /* storage unavailable */ } };
const when = (d: string) => new Date(d).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/** Recordings + generated documents; polls so new documents show up. "New" = not opened here yet. */
export function useLibrary(signedIn: boolean) {
  const [recs, setRecs] = useState<Rec[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [seen, setSeen] = useState<Set<string>>(() => readSeen() ?? new Set());
  const load = useCallback(async () => {
    try {
      const [r, d] = await Promise.all([api<Rec[]>("my-recordings"), api<Doc[]>("my-documents")]);
      setRecs(r); setDocs(d);
      // first run on this computer: existing documents are not "new"
      if (!readSeen()) { const s = new Set(d.map((x) => x.id)); writeSeen(s); setSeen(s); }
    } catch { /* offline or signed out: keep what we have */ }
  }, []);
  useEffect(() => {
    if (!signedIn) { setRecs([]); setDocs([]); return; }
    load();
    const t = setInterval(load, 60_000);
    addEventListener("focus", load);
    return () => { clearInterval(t); removeEventListener("focus", load); };
  }, [signedIn, load]);
  const markSeen = (id: string) => setSeen((s) => { const n = new Set(s).add(id); writeSeen(n); return n; });
  return { recs, docs, isNew: (id: string) => !seen.has(id), markSeen, reload: load };
}
export type Library = ReturnType<typeof useLibrary>;

function DocView({ doc, onBack }: { doc: Doc; onBack: () => void }) {
  const [md, setMd] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { api<{ content_md: string }>("document", { id: doc.id }).then((d) => setMd(d.content_md)).catch((e) => setErr(String(e.message ?? e))); }, [doc.id]);
  return (
    <div className="page" style={{ alignItems: "stretch", maxWidth: 820, margin: "0 auto", width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <button className="linkbtn" onClick={onBack}>‹ Back</button>
        <button className="btn" style={{ height: 34, fontSize: 13 }} onClick={() => openUrl(`${import.meta.env.VITE_WEB_URL}/documents/${doc.id}`)}>Open on web</button>
      </div>
      <h1 style={{ margin: 0, fontSize: 26 }}>{doc.parser_name}</h1>
      {err ? <p className="err">{err}</p> : md === null ? <p className="muted">Loading…</p> : <div className="md"><Markdown>{md}</Markdown></div>}
    </div>
  );
}

export default function Recordings({ lib, onBack }: { lib: Library; onBack: () => void }) {
  const [open, setOpen] = useState<Doc | null>(null);
  if (open) return <DocView doc={open} onBack={() => setOpen(null)} />;
  return (
    <div className="page" style={{ alignItems: "stretch", maxWidth: 820, margin: "0 auto", width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <button className="linkbtn" onClick={onBack}>‹ Back</button>
        <button className="linkbtn" onClick={lib.reload}>Refresh</button>
      </div>
      <h1 style={{ margin: 0, fontSize: 26 }}>My recordings</h1>
      {lib.recs.length === 0 && <p className="muted">Nothing here yet. Recordings you send appear here with their documents.</p>}
      {lib.recs.map((r) => {
        const rd = lib.docs.filter((d) => d.submission_id === r.id);
        return (
          <div className="card" key={r.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div className="meta" style={{ flex: 1 }}><b>{r.title}</b><span className="muted">{when(r.created_at)}{r.duration_seconds ? ` · ${Math.max(1, Math.round(r.duration_seconds / 60))} min` : ""}</span></div>
              {rd.length === 0 && <span className="chip wait">{r.transcript_status === "done" ? "No documents yet" : "Processing"}</span>}
              <button className="linkbtn" onClick={() => openUrl(`${import.meta.env.VITE_WEB_URL}/submissions/${r.id}`)}>Review on web</button>
            </div>
            {rd.map((d) => (
              <button key={d.id} className="row docrow" onClick={() => { lib.markSeen(d.id); setOpen(d); }}>
                <div className="meta" style={{ flex: 1, textAlign: "left" }}><b>{d.parser_name}</b><span className="muted">{when(d.created_at)}</span></div>
                {lib.isNew(d.id) && <span className="chip ok">New</span>}
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}
