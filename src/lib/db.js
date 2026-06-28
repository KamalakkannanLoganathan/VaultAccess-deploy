// Async data-access layer backed by Supabase.
// Row Level Security (see supabase/schema.sql) is what enforces who can read/
// write what — these helpers just map between the database's snake_case rows
// and the camelCase shapes the React components already use.
import { supabase } from "./supabase";

// ─── row <-> app mappers ────────────────────────────────────────────────────
const credFromRow = (r) => ({
  id: r.id, portal: r.portal, url: r.url || "", username: r.username, password: r.password,
  category: r.category, client: r.client || "",
  authMethod: r.auth_method || "None", authLocation: r.auth_location || "",
  verifyEmail: r.verify_email || "", verifyText: r.verify_text || "", verifyAuth: r.verify_auth || "",
  timeRestriction: r.time_restriction || null,
  teams: r.all_teams ? "all" : (r.teams || []),
  passwordExpiryDays: r.password_expiry_days || 90,
  needsRotation: !!r.needs_rotation, rotationNote: r.rotation_note || "",
  addedBy: r.added_by || "", addedAt: r.added_at, updatedAt: r.updated_at,
});

const credToRow = (c) => {
  const all = c.teams === "all";
  return {
    portal: c.portal, url: c.url || "", username: c.username, password: c.password,
    category: c.category, client: c.client || "",
    auth_method: c.authMethod || "None", auth_location: c.authLocation || "",
    verify_email: c.verifyEmail || "", verify_text: c.verifyText || "", verify_auth: c.verifyAuth || "",
    time_restriction: c.timeRestriction || null,
    all_teams: all, teams: all ? [] : (Array.isArray(c.teams) ? c.teams : []),
    password_expiry_days: c.passwordExpiryDays || 90,
    needs_rotation: !!c.needsRotation, rotation_note: c.rotationNote || "",
  };
};

const userFromRow = (p) => ({
  id: p.id, name: p.name, username: p.username, team: p.team, avatar: p.avatar || "",
  createdAt: p.created_at, lastLoginAt: p.last_login_at,
  twoFactorEnabled: !!p.two_factor_enabled, twoFactorSecret: p.two_factor_secret || "",
});

const auditFromRow = (a) => ({
  id: a.id, userId: a.user_id, userName: a.user_name, action: a.action,
  credentialId: a.credential_id, credentialName: a.credential_name,
  targetUserId: a.target_user_id, detail: a.detail || "", timestamp: a.ts, ipNote: "session",
});

const reqFromRow = (r) => ({
  id: r.id, requesterId: r.requester_id, requesterName: r.requester_name,
  requesterTeam: r.requester_team, credentialId: r.credential_id,
  credentialName: r.credential_name, message: r.message || "", status: r.status,
  requestedAt: r.requested_at, resolvedAt: r.resolved_at, resolvedBy: r.resolved_by,
});

// ─── auth / profile ─────────────────────────────────────────────────────────
export async function getMyProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  if (error) return null;
  return userFromRow(data);
}

export async function touchLastLogin(id) {
  await supabase.from("profiles").update({ last_login_at: new Date().toISOString() }).eq("id", id);
}

export async function updateProfile(id, patch) {
  const row = {};
  if ("name" in patch) row.name = patch.name;
  if ("team" in patch) row.team = patch.team;
  if ("avatar" in patch) row.avatar = patch.avatar;
  if ("twoFactorEnabled" in patch) row.two_factor_enabled = patch.twoFactorEnabled;
  if ("twoFactorSecret" in patch) row.two_factor_secret = patch.twoFactorSecret;
  const { error } = await supabase.from("profiles").update(row).eq("id", id);
  if (error) throw error;
}

// ─── credentials ────────────────────────────────────────────────────────────
export async function listCredentials() {
  const { data, error } = await supabase.from("credentials").select("*").order("portal");
  if (error) throw error;
  return data.map(credFromRow);
}

export async function createCredential(c, addedBy) {
  const row = { ...credToRow(c), added_by: addedBy };
  const { data, error } = await supabase.from("credentials").insert(row).select().single();
  if (error) throw error;
  return credFromRow(data);
}

export async function updateCredential(id, c) {
  const row = { ...credToRow(c), updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from("credentials").update(row).eq("id", id).select().single();
  if (error) throw error;
  return credFromRow(data);
}

export async function patchCredential(id, patch) {
  const row = { updated_at: new Date().toISOString() };
  if ("needsRotation" in patch) row.needs_rotation = patch.needsRotation;
  if ("passwordExpiryDays" in patch) row.password_expiry_days = patch.passwordExpiryDays;
  if ("timeRestriction" in patch) row.time_restriction = patch.timeRestriction;
  if ("teams" in patch) {
    const all = patch.teams === "all";
    row.all_teams = all;
    row.teams = all ? [] : patch.teams;
  }
  const { error } = await supabase.from("credentials").update(row).eq("id", id);
  if (error) throw error;
}

export async function deleteCredential(id) {
  const { error } = await supabase.from("credentials").delete().eq("id", id);
  if (error) throw error;
}

export async function bulkCreateCredentials(creds, addedBy) {
  const rows = creds.map((c) => ({ ...credToRow(c), added_by: addedBy }));
  const { error } = await supabase.from("credentials").insert(rows);
  if (error) throw error;
}

// ─── users (read) ───────────────────────────────────────────────────────────
export async function listUsers() {
  const { data, error } = await supabase.from("profiles").select("*").order("name");
  if (error) throw error;
  return data.map(userFromRow);
}

// ─── audit ──────────────────────────────────────────────────────────────────
export async function logAudit(entry) {
  try {
    await supabase.from("audit").insert({
      user_id: entry.userId || null, user_name: entry.userName || null, action: entry.action,
      credential_id: entry.credentialId || null, credential_name: entry.credentialName || null,
      target_user_id: entry.targetUserId || null, detail: entry.detail || null,
    });
  } catch { /* audit failures must never block the UI */ }
}

export async function listAudit() {
  const { data, error } = await supabase.from("audit").select("*").order("ts", { ascending: false }).limit(500);
  if (error) throw error;
  return data.map(auditFromRow);
}

// ─── access requests ────────────────────────────────────────────────────────
export async function createRequest({ requesterId, requesterName, requesterTeam, credentialId, credentialName, message }) {
  const { error } = await supabase.from("access_requests").insert({
    requester_id: requesterId, requester_name: requesterName, requester_team: requesterTeam,
    credential_id: credentialId, credential_name: credentialName, message,
  });
  if (error) throw error;
}

export async function listRequests() {
  const { data, error } = await supabase.from("access_requests").select("*").order("requested_at", { ascending: false });
  if (error) throw error;
  return data.map(reqFromRow);
}

export async function resolveRequest(req, status, resolvedBy) {
  // approving grants the requester's team access to the credential
  if (status === "approved") {
    const { data: cred } = await supabase.from("credentials").select("all_teams,teams").eq("id", req.credentialId).single();
    if (cred && !cred.all_teams) {
      const teams = cred.teams || [];
      if (!teams.includes(req.requesterTeam)) {
        await supabase.from("credentials").update({ teams: [...teams, req.requesterTeam], updated_at: new Date().toISOString() }).eq("id", req.credentialId);
      }
    }
  }
  const { error } = await supabase.from("access_requests")
    .update({ status, resolved_at: new Date().toISOString(), resolved_by: resolvedBy })
    .eq("id", req.id);
  if (error) throw error;
}

// ─── favourites ─────────────────────────────────────────────────────────────
export async function listFavourites(userId) {
  const { data, error } = await supabase.from("favourites").select("credential_id").eq("user_id", userId);
  if (error) throw error;
  return data.map((r) => r.credential_id);
}

export async function toggleFavourite(userId, credentialId, on) {
  if (on) {
    const { error } = await supabase.from("favourites").insert({ user_id: userId, credential_id: credentialId });
    if (error && error.code !== "23505") throw error; // ignore "already exists"
  } else {
    const { error } = await supabase.from("favourites").delete().eq("user_id", userId).eq("credential_id", credentialId);
    if (error) throw error;
  }
}

// ─── admin user management (via secure serverless function) ──────────────────
async function adminApi(body) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch("/api/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  let json = {};
  try { json = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const hint = res.status === 404
      ? "User management runs on the deployed site (or via `vercel dev`)."
      : (json.error || `Request failed (${res.status})`);
    throw new Error(hint);
  }
  return json;
}

export const adminCreateUser = (u) => adminApi({ action: "create", ...u });
export const adminResetPassword = (id, password) => adminApi({ action: "resetPassword", id, password });
export const adminDeleteUser = (id) => adminApi({ action: "delete", id });
