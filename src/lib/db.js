// Async data-access layer backed by Supabase.
// Row Level Security (see supabase/schema.sql) is what enforces who can read/
// write what — these helpers just map between the database's snake_case rows
// and the camelCase shapes the React components already use.
import { supabase } from "./supabase";

// ─── row <-> app mappers ────────────────────────────────────────────────────
const credFromRow = (r) => ({
  id: r.id, portal: r.portal, url: r.url || "", username: r.username, password: r.password,
  // multi-client; fall back to the legacy single client_id/client_name if present
  clientIds: (Array.isArray(r.client_ids) && r.client_ids.length) ? r.client_ids : (r.client_id ? [String(r.client_id)] : []),
  clientNames: (Array.isArray(r.client_names) && r.client_names.length) ? r.client_names : (r.client_name ? [r.client_name] : []),
  authMethod: r.auth_method || "None", authLocation: r.auth_location || "",
  verifyEmail: r.verify_email || "", verifyText: r.verify_text || "", verifyAuth: r.verify_auth || "",
  timeRestriction: r.time_restriction || null,
  teams: r.all_teams ? "all" : (r.teams || []),
  passwordExpiryDays: r.password_expiry_days || 90,
  inUse: !!r.in_use, inUseBy: r.in_use_by || null, inUseByUserId: r.in_use_by_user_id || null,
  inUseSince: r.in_use_since || null, inUseNote: r.in_use_note || null,
  notWorking: !!r.not_working, notWorkingReportedBy: r.not_working_reported_by || null,
  notWorkingReportedById: r.not_working_reported_by_id || null, notWorkingAt: r.not_working_at || null,
  notWorkingNote: r.not_working_note || null, notWorkingHistory: Array.isArray(r.not_working_history) ? r.not_working_history : [],
  auditOwner: r.audit_owner || null,
  addedBy: r.added_by || "", addedAt: r.added_at, updatedAt: r.updated_at,
});

const credToRow = (c) => {
  const all = c.teams === "all";
  return {
    portal: c.portal, url: c.url || "", username: c.username, password: c.password,
    client_ids: Array.isArray(c.clientIds) ? c.clientIds : [],
    client_names: Array.isArray(c.clientNames) ? c.clientNames : [],
    auth_method: c.authMethod || "None", auth_location: c.authLocation || "",
    verify_email: c.verifyEmail || "", verify_text: c.verifyText || "", verify_auth: c.verifyAuth || "",
    time_restriction: c.timeRestriction || null,
    all_teams: all, teams: all ? [] : (Array.isArray(c.teams) ? c.teams : []),
    password_expiry_days: c.passwordExpiryDays || 90,
    audit_owner: c.auditOwner || null,
  };
};

const clientFromRow = (r) => ({
  id: r.id, name: r.name, code: r.code || "", color: r.color || "#6366f1",
  privilegeLevel: r.privilege_level || "standard", allowedTeams: r.allowed_teams || [],
  description: r.description || "", active: r.active !== false,
  createdAt: r.created_at, createdBy: r.created_by || "",
});
const clientToRow = (c) => ({
  name: c.name, code: c.code || "", color: c.color || "#6366f1",
  privilege_level: c.privilegeLevel || "standard", allowed_teams: Array.isArray(c.allowedTeams) ? c.allowedTeams : [],
  description: c.description || "", active: c.active !== false,
});

const userFromRow = (p) => ({
  id: p.id, name: p.name, username: p.username, team: p.team, avatar: p.avatar || "",
  createdAt: p.created_at, lastLoginAt: p.last_login_at,
  twoFactorEnabled: !!p.two_factor_enabled, twoFactorSecret: p.two_factor_secret || "",
  active: p.active !== false,
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
  if ("passwordExpiryDays" in patch) row.password_expiry_days = patch.passwordExpiryDays;
  if ("timeRestriction" in patch) row.time_restriction = patch.timeRestriction;
  if ("teams" in patch) {
    const all = patch.teams === "all";
    row.all_teams = all;
    row.teams = all ? [] : patch.teams;
  }
  if ("auditOwner" in patch) row.audit_owner = patch.auditOwner || null;
  const { error } = await supabase.from("credentials").update(row).eq("id", id);
  if (error) throw error;
}

// Bulk-assign the audit owner across many credentials in one write (admin).
export async function bulkSetAuditOwner(ids, ownerId) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const { error } = await supabase.from("credentials")
    .update({ audit_owner: ownerId || null, updated_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw error;
}

// Status flags — go through SECURITY DEFINER RPCs so non-admin members can
// set status without being able to edit passwords/teams.
export async function setInUse(credId, inUse, by, byId, note) {
  const { error } = await supabase.rpc("cred_set_in_use", {
    cred_id: credId, p_in_use: inUse, p_by: by || null, p_by_id: byId || null, p_note: note || null,
  });
  if (error) throw error;
}
export async function setNotWorking(credId, notWorking, by, byId, note, history) {
  const { error } = await supabase.rpc("cred_set_not_working", {
    cred_id: credId, p_not_working: notWorking, p_by: by || null, p_by_id: byId || null, p_note: note || null, p_history: history || [],
  });
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

// ─── clients (admin-managed, with privilege levels) ─────────────────────────
export async function listClients() {
  const { data, error } = await supabase.from("clients").select("*").order("name");
  if (error) throw error;
  return data.map(clientFromRow);
}
export async function createClient(c, createdBy) {
  const { data, error } = await supabase.from("clients").insert({ ...clientToRow(c), created_by: createdBy }).select().single();
  if (error) throw error;
  return clientFromRow(data);
}
export async function updateClient(id, c) {
  const { error } = await supabase.from("clients").update(clientToRow(c)).eq("id", id);
  if (error) throw error;
}
export async function archiveClient(id, active) {
  const { error } = await supabase.from("clients").update({ active }).eq("id", id);
  if (error) throw error;
}

// ─── departments (admin-editable) ───────────────────────────────────────────
export async function listDepartments() {
  const { data, error } = await supabase.from("departments").select("*").order("sort").order("label");
  if (error) throw error;
  return data.map((r) => ({ id: r.id, label: r.label, color: r.color || "#60a5fa", sort: r.sort || 0 }));
}
export async function createDepartment({ id, label, color }) {
  const { error } = await supabase.from("departments").insert({ id, label, color: color || "#60a5fa", sort: 99 });
  if (error) throw error;
}
export async function updateDepartment(id, patch) {
  const row = {};
  if ("label" in patch) row.label = patch.label;
  if ("color" in patch) row.color = patch.color;
  if ("sort" in patch) row.sort = patch.sort;
  const { error } = await supabase.from("departments").update(row).eq("id", id);
  if (error) throw error;
}
export async function deleteDepartment(id) {
  const { error } = await supabase.from("departments").delete().eq("id", id);
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

// ─── invite tokens (admin) ───────────────────────────────────────────────────
const inviteFromRow = (r) => ({
  id: r.id, token: r.token, label: r.label || "", createdBy: r.created_by || "", createdAt: r.created_at,
  expiresAt: r.expires_at, allowedTeam: r.allowed_team || null, maxUses: r.max_uses || 1,
  usedCount: r.used_count || 0, active: r.active !== false,
});
export async function createInviteToken({ token, label, allowedTeam, maxUses, expiresAt }, createdBy) {
  const { data, error } = await supabase.from("invite_tokens").insert({
    token, label: label || "", allowed_team: allowedTeam || null, max_uses: maxUses || 1,
    expires_at: expiresAt, created_by: createdBy, used_count: 0, active: true,
  }).select().single();
  if (error) throw error;
  return inviteFromRow(data);
}
export async function listInviteTokens() {
  const { data, error } = await supabase.from("invite_tokens").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data.map(inviteFromRow);
}
export async function revokeInviteToken(id) {
  const { error } = await supabase.from("invite_tokens").update({ active: false }).eq("id", id);
  if (error) throw error;
}

// ─── pending registrations (admin) ───────────────────────────────────────────
const regFromRow = (r) => ({
  id: r.id, tokenId: r.token_id, userId: r.user_id, fullName: r.full_name, username: r.username,
  requestedTeam: r.requested_team || null, submittedAt: r.submitted_at, status: r.status,
  reviewedBy: r.reviewed_by || null, reviewedAt: r.reviewed_at || null, rejectionReason: r.rejection_reason || null,
});
export async function listPendingRegistrations() {
  const { data, error } = await supabase.from("pending_registrations").select("*").order("submitted_at", { ascending: false });
  if (error) throw error;
  return data.map(regFromRow);
}
export async function approveRegistration(reg, team, reviewedBy) {
  if (reg.userId) {
    const { error: pe } = await supabase.from("profiles").update({ active: true, team }).eq("id", reg.userId);
    if (pe) throw pe;
  }
  const { error } = await supabase.from("pending_registrations")
    .update({ status: "approved", reviewed_by: reviewedBy, reviewed_at: new Date().toISOString() }).eq("id", reg.id);
  if (error) throw error;
}
export async function rejectRegistration(reg, reason, reviewedBy) {
  const { error } = await supabase.from("pending_registrations")
    .update({ status: "rejected", reviewed_by: reviewedBy, reviewed_at: new Date().toISOString(), rejection_reason: reason || null }).eq("id", reg.id);
  if (error) throw error;
  if (reg.userId) { try { await adminDeleteUser(reg.userId); } catch { /* leave inactive account if delete fails */ } }
}

// ─── anonymous registration (token-gated serverless endpoint) ────────────────
async function registerApi(body) {
  const res = await fetch("/api/register", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  let json = {};
  try { json = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const hint = res.status === 404 ? "Registration runs on the deployed site (or via `vercel dev`)." : (json.error || `Request failed (${res.status})`);
    throw new Error(hint);
  }
  return json;
}
export const inviteValidate = (token) => registerApi({ action: "validate", token });
export const inviteCheckUsername = (username) => registerApi({ action: "checkUsername", username });
export const inviteSubmit = (payload) => registerApi({ action: "submit", ...payload });
