import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  // ponytail: webview localStorage; move to OS keychain (tauri store) before shipping
  { auth: { persistSession: true, autoRefreshToken: true } },
);
