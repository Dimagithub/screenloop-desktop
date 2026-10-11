import { supabase } from "./supabase";

const BASE = `${import.meta.env.VITE_WEB_URL}/api/desktop`;

/** POST to the web app's /api/desktop/<action>; sends the Supabase bearer token when signed in. */
export async function api<T = unknown>(action: string, body: object = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(`${BASE}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Request failed (${res.status})`);
  return json as T;
}

export interface ResolvedLink {
  state: "ok" | "used" | "expired" | "invalid";
  title?: string;
  prompts?: string[];
  maxDurationMin?: number;
  chunkMinutes?: number;
  quality?: string;
  sender?: { name: string; avatarUrl: string | null };
}

/** Accepts a full /r/<token> URL, a screenloop://r/<token> link, or a bare token. */
export const tokenFromInput = (s: string) => s.trim().match(/(?:\/r\/)?([A-Za-z0-9_-]{16,})\/?$/)?.[1] ?? "";
