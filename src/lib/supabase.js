import { createClient } from "@supabase/supabase-js";

// These come from your Supabase project: Settings → API.
// Put them in a file named  .env.local  at the project root (see .env.example).
// The anon/public key is safe to ship to the browser — Row Level Security
// (see supabase/schema.sql) is what actually protects the data.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase = isSupabaseConfigured
  ? createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

// Admin-managed accounts have no real email. We map a username to a synthetic
// address so Supabase Auth can still issue secure session tokens.
export const usernameToEmail = (username) =>
  `${String(username).trim().toLowerCase()}@vault.local`;
