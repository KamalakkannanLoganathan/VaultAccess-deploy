// Vercel serverless function — the ONLY place the service-role key is used.
// It runs on the server, never in the browser. Every call is checked: the
// caller must present a valid Supabase session token AND be an admin before
// any privileged action runs.
import { createClient } from "@supabase/supabase-js";

const initials = (name) =>
  String(name || "").trim().split(/\s+/).map((p) => p[0]).join("").toUpperCase().slice(0, 2);
const emailFor = (username) => `${String(username).trim().toLowerCase()}@vault.local`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return res.status(500).json({ error: "Server not configured" });

  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // 1) Authenticate the caller from their bearer token.
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Missing auth token" });
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return res.status(401).json({ error: "Unauthorized" });

  // 2) Authorize — caller must be an admin.
  const { data: prof } = await admin.from("profiles").select("team").eq("id", userData.user.id).single();
  if (!prof || prof.team !== "admin") return res.status(403).json({ error: "Admin only" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { action } = body;

  try {
    if (action === "create") {
      const { name, username, password, team } = body;
      if (!name || !username || !password || !team) return res.status(400).json({ error: "Missing fields" });
      const { data, error } = await admin.auth.admin.createUser({
        email: emailFor(username), password, email_confirm: true,
        user_metadata: { name, username, team },
      });
      if (error) throw error;
      const { error: pErr } = await admin.from("profiles").insert({
        id: data.user.id, name, username: username.toLowerCase(), team, avatar: initials(name),
      });
      if (pErr) {
        // roll back the auth user if the profile row could not be created
        await admin.auth.admin.deleteUser(data.user.id);
        throw pErr;
      }
      return res.status(200).json({ ok: true, id: data.user.id });
    }

    if (action === "resetPassword") {
      const { id, password } = body;
      if (!id || !password) return res.status(400).json({ error: "Missing fields" });
      const { error } = await admin.auth.admin.updateUserById(id, { password });
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    if (action === "delete") {
      const { id } = body;
      if (!id) return res.status(400).json({ error: "Missing id" });
      if (id === userData.user.id) return res.status(400).json({ error: "Cannot delete yourself" });
      const { error } = await admin.auth.admin.deleteUser(id); // profile row cascades
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(400).json({ error: e.message || String(e) });
  }
}
