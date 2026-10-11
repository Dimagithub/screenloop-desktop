import { createClient } from "@supabase/supabase-js";
import { invoke } from "@tauri-apps/api/core";

// Session lives in the OS keychain (macOS Keychain / Windows Credential Manager), not in webview storage.
// Credential entries are size-limited (about 2.5 KB on Windows), so a value is split into chunks.
const CHUNK = 1200;
const keychain = {
  async getItem(key: string): Promise<string | null> {
    const n = Number(await invoke<string | null>("secret_get", { key: `${key}#n` }));
    if (!n) return null;
    let out = "";
    for (let i = 0; i < n; i++) out += (await invoke<string | null>("secret_get", { key: `${key}#${i}` })) ?? "";
    return out || null;
  },
  async setItem(key: string, value: string): Promise<void> {
    const parts = value.match(new RegExp(`.{1,${CHUNK}}`, "gs")) ?? [];
    for (const [i, p] of parts.entries()) await invoke("secret_set", { key: `${key}#${i}`, value: p });
    await invoke("secret_set", { key: `${key}#n`, value: String(parts.length) });
  },
  async removeItem(key: string): Promise<void> {
    const n = Number(await invoke<string | null>("secret_get", { key: `${key}#n` }));
    for (let i = 0; i < n; i++) await invoke("secret_remove", { key: `${key}#${i}` });
    await invoke("secret_remove", { key: `${key}#n` });
  },
};

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  { auth: { persistSession: true, autoRefreshToken: true, storage: keychain } },
);
