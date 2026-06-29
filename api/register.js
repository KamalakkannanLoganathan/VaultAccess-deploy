// Vercel serverless function — anonymous self-registration via invite token.
// No login is required: the invite token IS the authorization. All privileged
// work runs server-side with the service-role key. Created accounts are
// inactive (profiles.active = false) until an admin approves them.
import { createClient } from "@supabase/supabase-js";

const initials = (name) =>
  String(name || "").trim().split(/\s+/).map((p) => p[0]).join("").toUpperCase().slice(0, 2);
const emailFor = (username) => `${String(username).trim().toLowerCase()}@vault.local`;

function checkToken(tok) {
  if (!tok) return "Invalid invite link.";
  if (!tok.active) return "This invite link has been revoked.";
  if (tok.expires_at && new Date(tok.expires_at) < new Date()) return "This invite link has expired. Contact your admin.";
  if (tok.used_count >= tok.max_uses) return "This invite link has already been used.";
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { action } = body;

  try {
    if (action === "checkUsername") {
      const uname = String(body.username || "").trim().toLowerCase();
      if (!uname) return res.status(200).json({ available: false });
      const { data } = await admin.from("profiles").select("id").eq("username", uname).maybeSingle();
      return res.status(200).json({ available: !data });
    }

    if (action === "validate") {
      const { data: tok } = await admin.from("invite_tokens").select("*").eq("token", body.token).maybeSingle();
      const err = checkToken(tok);
      if (err) return res.status(200).json({ valid: false, reason: err });
      const { data: depts } = await admin.from("departments").select("id,label").order("sort");
      return res.status(200).json({
        valid: true, label: tok.label || "", allowedTeam: tok.allowed_team || null,
        teams: (depts || []).map((d) => ({ id: d.id, label: d.label })),
      });
    }

    if (action === "submit") {
      const { token, fullName, username, password, requestedTeam } = body;
      const { data: tok } = await admin.from("invite_tokens").select("*").eq("token", token).maybeSingle();
      const err = checkToken(tok);
      if (err) return res.status(400).json({ error: err });
      if (!fullName || !username || !password) return res.status(400).json({ error: "Missing required fields" });

      const uname = String(username).trim().toLowerCase();
      const { data: existing } = await admin.from("profiles").select("id").eq("username", uname).maybeSingle();
      if (existing) return res.status(400).json({ error: "That username is already taken." });

      let team = tok.allowed_team || requestedTeam || "engineering";
      if (team === "admin") team = "engineering"; // users cannot self-register as admin

      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email: emailFor(uname), password, email_confirm: true,
        user_metadata: { name: fullName, username: uname, team },
      });
      if (cErr) return res.status(400).json({ error: cErr.message });

      const { error: pErr } = await admin.from("profiles").insert({
        id: created.user.id, name: fullName, username: uname, team, avatar: initials(fullName), active: false,
      });
      if (pErr) { await admin.auth.admin.deleteUser(created.user.id); return res.status(400).json({ error: pErr.message }); }

      await admin.from("pending_registrations").insert({
        token_id: tok.id, user_id: created.user.id, full_name: fullName, username: uname, requested_team: team, status: "pending",
      });

      const nextUsed = tok.used_count + 1;
      await admin.from("invite_tokens").update({ used_count: nextUsed, active: nextUsed < tok.max_uses }).eq("id", tok.id);

      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(400).json({ error: e.message || String(e) });
  }
}
