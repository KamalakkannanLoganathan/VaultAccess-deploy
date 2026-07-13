import React, { useState, useEffect, useRef, useCallback, useContext, useMemo } from "react";
import * as XLSX from "xlsx";
import ExcelJS from "exceljs";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { supabase, isSupabaseConfigured, usernameToEmail } from "./lib/supabase";
import {
  getMyProfile, touchLastLogin, updateProfile,
  listCredentials, createCredential, updateCredential, patchCredential, deleteCredential, bulkCreateCredentials,
  setInUse, setNotWorking,
  listUsers, logAudit, listAudit, createRequest, listRequests, resolveRequest,
  listFavourites, toggleFavourite, adminCreateUser, adminResetPassword, adminDeleteUser,
  listDepartments, createDepartment, updateDepartment, deleteDepartment,
  listClients, createClient, updateClient, archiveClient,
  createInviteToken, listInviteTokens, revokeInviteToken,
  listPendingRegistrations, approveRegistration, rejectRegistration,
  inviteValidate, inviteCheckUsername, inviteSubmit,
} from "./lib/db";

// ─── Constants ───────────────────────────────────────────────────────────────
const SS_KEY = "vault_session";
const TEAMS = ["admin","engineering","marketing","design","ops"];
const TEAM_STYLES = {
  admin:       { bg:"rgba(251,191,36,0.12)", color:"#fbbf24", border:"rgba(251,191,36,0.35)" },
  engineering: { bg:"rgba(96,165,250,0.12)", color:"#60a5fa", border:"rgba(96,165,250,0.35)" },
  marketing:   { bg:"rgba(244,114,182,0.12)", color:"#f472b6", border:"rgba(244,114,182,0.35)" },
  design:      { bg:"rgba(167,139,250,0.12)", color:"#a78bfa", border:"rgba(167,139,250,0.35)" },
  ops:         { bg:"rgba(52,211,153,0.12)", color:"#34d399", border:"rgba(52,211,153,0.35)" },
};
const CAT_ICONS = {
  Development:"💻", Infrastructure:"🔧", Design:"🎨", Marketing:"📣",
  Communication:"💬", Default:"🔑",
};

// ─── Departments (admin-editable "teams") ────────────────────────────────────
const DEFAULT_DEPTS = [
  { id:"engineering", label:"Engineering", color:"#60a5fa" },
  { id:"marketing",   label:"Marketing",   color:"#f472b6" },
  { id:"design",      label:"Design",      color:"#a78bfa" },
  { id:"ops",         label:"Ops",         color:"#34d399" },
];
const DEPT_PALETTE = ["#60a5fa","#f472b6","#a78bfa","#34d399","#f59e0b","#22d3ee","#fb7185","#4ade80","#e879f9","#facc15"];

// ─── Clients (managed entities with privilege levels) ────────────────────────
const CLIENT_PALETTE = ["#6366f1","#f59e0b","#10b981","#ef4444","#8b5cf6","#ec4899","#14b8a6","#f97316","#06b6d4","#84cc16","#a855f7","#64748b"];
const PRIVILEGE_META = {
  standard:     { label:"Standard",     color:"#60a5fa", desc:"All allowed team members can view passwords" },
  restricted:   { label:"Restricted",   color:"#f59e0b", desc:"Team members see credentials but not passwords" },
  confidential: { label:"Confidential", color:"#ef4444", desc:"Admin eyes only" },
};
const autoCode = (name) => String(name||"").replace(/[^A-Za-z]/g,"").toUpperCase().slice(0,3) || "CLT";
const PRIV_RANK = { standard:0, restricted:1, confidential:2 };
const PRIV_ORDER = ["standard","restricted","confidential"];
const highestPrivilege = (clientList) => {
  let best = 0;
  for (const c of clientList) { if (c && PRIV_RANK[c.privilegeLevel] > best) best = PRIV_RANK[c.privilegeLevel]; }
  return PRIV_ORDER[best];
};
// Resolve the clients assigned to a credential (handles the "all" sentinel).
const resolveClients = (cred, clientsById) => {
  if ((cred.clientIds||[]).includes("all")) return Object.values(clientsById||{});
  return (cred.clientIds||[]).map(id => clientsById && clientsById[id]).filter(Boolean);
};
const ADMIN_STYLE = { bg:"rgba(251,191,36,0.12)", color:"#fbbf24", border:"rgba(251,191,36,0.35)" };
const FALLBACK_STYLE = { bg:"rgba(255,255,255,0.06)", color:"var(--text-secondary)", border:"var(--border-default)" };
const hexA = (hex, a) => {
  const h = String(hex||"#60a5fa").replace("#","");
  const full = h.length===3 ? h.split("").map(c=>c+c).join("") : h;
  const n = parseInt(full, 16); const r=(n>>16)&255, g=(n>>8)&255, b=n&255;
  return `rgba(${r},${g},${b},${a})`;
};
const styleForColor = (color) => ({ bg:hexA(color,0.12), color, border:hexA(color,0.35) });
const slugify = (s) => String(s||"").trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");
const DeptContext = React.createContext(null);
const useDepts = () => useContext(DeptContext);

// ── User preferences: theme (dark/light/grey) + layout density (compact/comfortable/list) ──
const THEMES = ["dark", "light", "grey"];
const DENSITIES = ["compact", "comfortable", "list"];
const readPref = (key, allowed, fallback) => {
  try { const v = localStorage.getItem(key); return allowed.includes(v) ? v : fallback; } catch { return fallback; }
};
const PrefsContext = React.createContext({ theme:"dark", density:"compact", setTheme:()=>{}, setDensity:()=>{} });
const usePrefs = () => useContext(PrefsContext);
const CAT_TINT = {
  Development:"rgba(96,165,250,0.15)", Infrastructure:"rgba(52,211,153,0.15)", Design:"rgba(167,139,250,0.15)",
  Marketing:"rgba(244,114,182,0.15)", Communication:"rgba(245,184,0,0.15)", Default:"rgba(255,255,255,0.08)",
};
const AUTH_METHODS = ["None","Text","Auth","Email"];
const AUTH_META = {
  Text:  { icon:"💬", label:"Text (SMS)" },
  Auth:  { icon:"🔑", label:"Auth (App)" },
  Email: { icon:"✉️", label:"Email (Code)" },
};

// ─── Session cache (sessionStorage) ─────────────────────────────────────────
const getSession   = () => { try { const v = sessionStorage.getItem(SS_KEY); return v ? JSON.parse(v) : null; } catch { return null; } };
const setSession   = (v) => sessionStorage.setItem(SS_KEY, JSON.stringify(v));
const clearSession = () => sessionStorage.removeItem(SS_KEY);

// ─── Helpers ─────────────────────────────────────────────────────────────────
const getInitials = (name) => String(name||"").trim().split(/\s+/).map((p)=>p[0]).join("").toUpperCase().slice(0,2);
const timeAgo = (ts) => {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - new Date(ts)) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s/60) + "m ago";
  if (s < 86400) return Math.floor(s/3600) + "h ago";
  return Math.floor(s/86400) + "d ago";
};
const fmtDate = (ts) => ts ? new Date(ts).toLocaleString() : "Never";
const daysSince = (ts) => ts ? Math.floor((Date.now() - new Date(ts)) / 86400000) : 0;
const hoursSince = (ts) => ts ? (Date.now() - new Date(ts)) / 3600000 : 0;
const fmtSmartTime = (ts) => {
  if (!ts) return "";
  const d = new Date(ts), now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour:"numeric", minute:"2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today at ${time}`;
  const yd = new Date(now); yd.setDate(now.getDate()-1);
  if (d.toDateString() === yd.toDateString()) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString(undefined,{ month:"short", day:"numeric" })} at ${time}`;
};
const canAccess = (cred, team) => {
  if (team === "admin") return true;
  if (cred.teams === "all") return true;
  return Array.isArray(cred.teams) && cred.teams.includes(team);
};
const pwStrength = (pw) => {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return s;
};

// ─── Time-restriction helpers ────────────────────────────────────────────────
const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const ALL_DAYS = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const toMin = (s) => { const [h,m] = String(s||"0:0").split(":").map(Number); return (h||0)*60 + (m||0); };
const fmtHm = (s) => {
  const [h,m] = String(s||"0:0").split(":").map(Number);
  const ap = h >= 12 ? "pm" : "am"; const h12 = (h % 12) || 12;
  return m ? `${h12}:${String(m).padStart(2,"0")}${ap}` : `${h12}${ap}`;
};
const fmtNiceDate = (d) => d.toLocaleDateString(undefined, { month:"short", day:"numeric", year:"numeric" });
const fmtNiceTime = (d) => d.toLocaleTimeString(undefined, { hour:"numeric", minute:"2-digit" });
const summarizeDays = (days) => {
  if (!days || !days.length) return "any day";
  const wk = ["Mon","Tue","Wed","Thu","Fri"];
  if (days.length === 5 && wk.every(d=>days.includes(d))) return "Mon–Fri";
  if (days.length === 7) return "every day";
  return ALL_DAYS.filter(d=>days.includes(d)).join(", ");
};
function evalTimeRestriction(tr, now = new Date()) {
  if (!tr || !tr.enabled) return { state: "none" };
  if (tr.type === "schedule") return { state: "schedule", note: tr.note || "" };
  if (tr.type === "expiry") {
    if (!tr.expiryDate) return { state: "none" };
    const expiry = new Date(`${tr.expiryDate}T${tr.expiresAt || "23:59"}`);
    if (isNaN(expiry)) return { state: "none" };
    const diff = expiry - now;
    if (diff <= 0) return { state: "expired", label: `Expired · This access expired on ${fmtNiceDate(expiry)}` };
    if (diff <= 48*3600*1000) return { state: "expiring", label: `Expiring soon · Access expires ${fmtNiceDate(expiry)} at ${fmtNiceTime(expiry)}` };
    return { state: "active", label: "Active now" };
  }
  if (tr.type === "window") {
    const days = tr.windowDays || [];
    const utc = tr.timezone === "UTC";
    const todayIdx = utc ? now.getUTCDay() : now.getDay();
    const today = DOW[todayIdx];
    const daysLabel = summarizeDays(days);
    if (days.length && !days.includes(today)) {
      return { state: "wrongday", label: `Not scheduled today · Available ${daysLabel}` };
    }
    const cur = utc ? now.getUTCHours()*60 + now.getUTCMinutes() : now.getHours()*60 + now.getMinutes();
    const startM = toMin(tr.windowStart || "00:00"), endM = toMin(tr.windowEnd || "23:59");
    const inWindow = startM <= endM ? (cur >= startM && cur <= endM) : (cur >= startM || cur <= endM);
    if (!inWindow) {
      return { state: "outside", label: `Outside access hours · Available ${daysLabel} ${fmtHm(tr.windowStart||"00:00")}–${fmtHm(tr.windowEnd||"23:59")}` };
    }
    return { state: "active", label: "Active now" };
  }
  return { state: "none" };
}
const isRestrictedState = (s) => ["outside","wrongday","expired","expiring"].includes(s);

// ─── Count-up hook ───────────────────────────────────────────────────────────
function useCountUp(target, duration = 600) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    const t0 = performance.now(); let raf;
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = p >= 1 ? 1 : 1 - Math.pow(2, -10 * p); // easeOutExpo
      setVal(Math.round((Number(target)||0) * eased));
      if (p < 1) raf = requestAnimationFrame(tick); else setVal(Number(target)||0);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

// ─── Design tokens / shared style fragments ──────────────────────────────────
const glass = {
  background:"linear-gradient(135deg, var(--surface-grad-1) 0%, var(--surface-grad-2) 100%)",
  backdropFilter:"blur(20px)", WebkitBackdropFilter:"blur(20px)",
  border:"1px solid var(--surface-border)", borderRadius:16,
  boxShadow:"var(--surface-shadow)",
};
const fieldBox = { background:"var(--field-bg)", border:"1px solid var(--border-subtle)", borderRadius:8, padding:"8px 12px" };
const microLabel = { fontSize:10, fontWeight:600, letterSpacing:1.5, textTransform:"uppercase", color:"var(--text-muted)" };
const monoVal = (muted) => ({ fontFamily:"var(--font-mono)", fontSize:13, color: muted?"var(--text-muted)":"var(--text-primary)", wordBreak:"break-all", flex:1 });
const iconBtn = (active, disabled) => ({
  width:32, height:32, display:"inline-flex", alignItems:"center", justifyContent:"center", flexShrink:0,
  background: active?"var(--success-bg)":"var(--hover-bg)",
  border:"1px solid "+(active?"rgba(16,185,129,0.4)":"var(--border-subtle)"),
  borderRadius:8, cursor: disabled?"not-allowed":"pointer", color: active?"var(--success)":"var(--text-secondary)",
  fontSize:13, transition:"all 0.15s ease", opacity: disabled?0.4:1,
});

const S = {
  btn: (variant, extra) => {
    const base = { padding:"10px 18px", borderRadius:10, border:"none", cursor:"pointer",
      fontWeight:600, fontSize:14, transition:"all 0.15s ease", display:"inline-flex",
      alignItems:"center", gap:6, fontFamily:"var(--font-ui)" };
    const variants = {
      primary:   { background:"linear-gradient(135deg,var(--gold-bright) 0%,var(--gold-mid) 100%)", color:"var(--btn-ink)", fontWeight:700, boxShadow:"0 4px 16px var(--gold-glow)" },
      danger:    { background:"var(--danger-bg)", color:"var(--danger)", border:"1px solid rgba(239,68,68,0.3)" },
      ghost:     { background:"var(--hover-bg)", color:"var(--text-secondary)", border:"1px solid var(--chip-border)" },
      secondary: { background:"var(--hover-bg)", color:"var(--text-secondary)", border:"1px solid var(--chip-border)" },
    };
    return { ...base, ...(variants[variant || "secondary"] || variants.secondary), ...(extra||{}) };
  },
  card: (extra) => ({ ...glass, padding:"var(--card-pad)", transition:"all 0.2s cubic-bezier(0.4,0,0.2,1)", ...(extra||{}) }),
  input: (extra) => ({ width:"100%", padding:"10px 14px", borderRadius:10,
    border:"1px solid var(--border-default)", fontSize:14, color:"var(--text-primary)", background:"var(--input-bg)",
    outline:"none", fontFamily:"var(--font-ui)", boxSizing:"border-box", ...(extra||{}) }),
  label: { fontSize:11, fontWeight:600, color:"var(--text-muted)", marginBottom:6, display:"block", textTransform:"uppercase", letterSpacing:1 },
  overlay: { position:"fixed", inset:0, background:"var(--overlay-bg)", backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)",
    zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center", padding:16 },
  modal: (extra) => ({ background:"var(--bg-elevated)", border:"1px solid var(--border-default)", borderTop:"2px solid var(--gold-bright)",
    borderRadius:20, boxShadow:"var(--modal-shadow)", animation:"ercModalIn 0.2s cubic-bezier(0.34,1.56,0.64,1)", ...(extra||{}) }),
};

// ─── Global styles (CSS variables, keyframes, polish) ────────────────────────
function GlobalStyles() {
  return (
    <style>{`
      /* ── Obsidian Premium — token system (Bloomberg / Linear / Vercel) ── */
      :root {
        --bg-void:#000000; --bg-base:#070a10; --bg-surface:#0c111b; --bg-elevated:#111826; --bg-highlight:#18222f;
        --border-subtle:rgba(255,255,255,0.05); --border-default:rgba(255,255,255,0.09); --border-strong:rgba(255,255,255,0.16);
        --gold-bright:#f5c451; --gold-mid:#d4960a; --gold-deep:#a9760a; --gold-dim:rgba(245,196,81,0.13); --gold-glow:rgba(245,196,81,0.22);
        --text-primary:#eef2f8; --text-secondary:#9aa6bd; --text-muted:#586273; --text-gold:#f5c451;
        --success:#10b981; --success-bg:rgba(16,185,129,0.12); --warning:#f59e0b; --warning-bg:rgba(245,158,11,0.12);
        --danger:#ef4444; --danger-bg:rgba(239,68,68,0.12); --info:#60a5fa; --info-bg:rgba(96,165,250,0.12);
        --inuse:#f97316; --inuse-bg:rgba(249,115,22,0.10); --notworking:#ef4444; --notworking-bg:rgba(239,68,68,0.10);
        --font-ui:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; --font-mono:'JetBrains Mono',monospace;
        --ring:0 0 0 3px var(--gold-dim); --shadow-card:0 1px 2px rgba(0,0,0,0.6),0 8px 32px rgba(0,0,0,0.45);
        /* Surface tokens — dark values equal the previous hardcodes (zero visual change) */
        --surface-grad-1:rgba(13,24,41,0.9); --surface-grad-2:rgba(19,32,53,0.85);
        --surface-border:rgba(255,255,255,0.08); --surface-shadow:0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.06);
        --input-bg:rgba(0,0,0,0.3); --field-bg:rgba(0,0,0,0.25); --track-bg:rgba(0,0,0,0.3);
        --overlay-bg:rgba(0,0,0,0.7); --modal-shadow:0 24px 80px rgba(0,0,0,0.6);
        --hover-bg:rgba(255,255,255,0.05); --hover-bg-strong:rgba(255,255,255,0.10); --chip-border:rgba(255,255,255,0.12);
        --header-bg:rgba(7,10,16,0.92); --page-dot:rgba(255,255,255,0.022); --btn-ink:#03070f; --tab-shadow:0 2px 8px rgba(0,0,0,0.4);
        /* Density tokens — Compact = current defaults */
        --card-pad:20px; --card-gap:12px; --grid-gap:16px; --font-scale:1;
      }
      /* ── Grey theme — neutral slate ── */
      html[data-theme="grey"] {
        --bg-void:#1b2027; --bg-base:#22272e; --bg-surface:#2a2f37; --bg-elevated:#2f353d; --bg-highlight:#373d47;
        --border-subtle:rgba(255,255,255,0.07); --border-default:rgba(255,255,255,0.12); --border-strong:rgba(255,255,255,0.2);
        --text-primary:#eaeef4; --text-secondary:#b3bcc9; --text-muted:#828c99; --text-gold:#f0b542;
        --gold-bright:#f0b542; --surface-grad-1:#2a2f37; --surface-grad-2:#282d34;
        --surface-border:rgba(255,255,255,0.09); --surface-shadow:0 4px 20px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.05);
        --input-bg:rgba(0,0,0,0.22); --field-bg:rgba(0,0,0,0.2); --track-bg:rgba(0,0,0,0.25);
        --overlay-bg:rgba(0,0,0,0.6); --modal-shadow:0 24px 60px rgba(0,0,0,0.5);
        --hover-bg:rgba(255,255,255,0.06); --hover-bg-strong:rgba(255,255,255,0.11); --chip-border:rgba(255,255,255,0.14);
        --header-bg:rgba(27,32,39,0.92); --page-dot:rgba(255,255,255,0.03); --btn-ink:#1c1205; --tab-shadow:0 2px 8px rgba(0,0,0,0.4);
      }
      /* ── Light theme — neutral paper, same amber accent ── */
      html[data-theme="light"] {
        --bg-void:#eef1f6; --bg-base:#f4f6fa; --bg-surface:#ffffff; --bg-elevated:#ffffff; --bg-highlight:#eef2f8;
        --border-subtle:rgba(15,23,42,0.08); --border-default:rgba(15,23,42,0.13); --border-strong:rgba(15,23,42,0.22);
        --gold-bright:#b7791f; --gold-mid:#a9760a; --gold-deep:#8a6111; --gold-dim:rgba(183,121,31,0.15); --gold-glow:rgba(183,121,31,0.2);
        --text-primary:#0f172a; --text-secondary:#475569; --text-muted:#7c889b; --text-gold:#b7791f;
        --success-bg:rgba(16,185,129,0.14); --warning-bg:rgba(217,119,6,0.16); --danger-bg:rgba(220,38,38,0.12); --info-bg:rgba(37,99,235,0.12);
        --surface-grad-1:#ffffff; --surface-grad-2:#ffffff;
        --surface-border:rgba(15,23,42,0.10); --surface-shadow:0 1px 2px rgba(15,23,42,0.06), 0 8px 24px rgba(15,23,42,0.08);
        --input-bg:rgba(15,23,42,0.03); --field-bg:rgba(15,23,42,0.035); --track-bg:rgba(15,23,42,0.05);
        --overlay-bg:rgba(15,23,42,0.35); --modal-shadow:0 24px 70px rgba(15,23,42,0.18);
        --hover-bg:rgba(15,23,42,0.04); --hover-bg-strong:rgba(15,23,42,0.08); --chip-border:rgba(15,23,42,0.15);
        --header-bg:rgba(255,255,255,0.9); --page-dot:rgba(15,23,42,0.05); --btn-ink:#2a1c05; --tab-shadow:0 2px 8px rgba(15,23,42,0.12);
      }
      html[data-theme="light"] body { background-image:none; }
      /* ── Density: Comfortable ── */
      html[data-density="comfortable"] { --card-pad:26px; --card-gap:16px; --grid-gap:22px; --font-scale:1.06; }
      * { box-sizing:border-box; }
      body { font-family:var(--font-ui); color:var(--text-primary); background:var(--bg-void);
        background-image:
          radial-gradient(900px 600px at 12% -8%, rgba(245,196,81,0.06), transparent 60%),
          radial-gradient(1100px 700px at 100% 0%, rgba(96,165,250,0.05), transparent 55%),
          radial-gradient(800px 800px at 50% 120%, rgba(245,196,81,0.04), transparent 60%);
        background-attachment:fixed; }
      ::-webkit-scrollbar { width:8px; height:8px; }
      ::-webkit-scrollbar-track { background:transparent; }
      ::-webkit-scrollbar-thumb { background:linear-gradient(var(--gold-deep),var(--gold-mid)); border-radius:8px; border:2px solid transparent; background-clip:padding-box; }
      ::-webkit-scrollbar-thumb:hover { background:linear-gradient(var(--gold-mid),var(--gold-bright)); background-clip:padding-box; }
      ::selection { background:rgba(245,196,81,0.28); color:#fff; }
      button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
        outline:2px solid rgba(245,184,0,0.5); outline-offset:2px;
      }
      input::placeholder, textarea::placeholder { color:var(--text-muted); }
      input, select, textarea { transition:border-color .15s ease, box-shadow .15s ease; }
      input:focus, select:focus, textarea:focus { border-color:var(--gold-bright) !important; box-shadow:0 0 0 3px var(--gold-dim); }
      select option { background:var(--bg-elevated); color:var(--text-primary); }
      .erc-card { transition:all 0.2s cubic-bezier(0.4,0,0.2,1); }
      .erc-card:hover { border-color:var(--gold-glow); transform:translateY(-2px);
        box-shadow:0 8px 40px rgba(0,0,0,0.5), 0 0 0 1px var(--gold-dim), inset 0 1px 0 rgba(255,255,255,0.08); }
      html[data-theme="light"] .erc-card:hover { box-shadow:0 10px 30px rgba(15,23,42,0.14), 0 0 0 1px var(--gold-dim); }
      .erc-prim:hover { filter:brightness(1.08); box-shadow:0 6px 24px var(--gold-glow); }
      .erc-prim:active { transform:scale(0.98); }
      .erc-ghost:hover { background:var(--hover-bg-strong) !important; color:var(--text-primary) !important; }
      .erc-pill:hover { border-color:var(--border-strong); color:var(--text-primary); }
      @keyframes ercFloat { 0%{transform:translate(0,0)} 50%{transform:translate(20px,-16px)} 100%{transform:translate(0,0)} }
      @keyframes ercShake { 0%{transform:translateX(0)} 25%{transform:translateX(-8px)} 75%{transform:translateX(8px)} 100%{transform:translateX(0)} }
      @keyframes ercFade { from{opacity:0} to{opacity:1} }
      @keyframes ercCardIn { from{opacity:0; transform:translateY(12px)} to{opacity:1; transform:translateY(0)} }
      @keyframes ercToastIn { from{opacity:0; transform:translateX(120%)} to{opacity:1; transform:translateX(0)} }
      @keyframes ercDrawerIn { from{transform:translateX(100%)} to{transform:translateX(0)} }
      @keyframes ercPulse { 0%{transform:scale(1)} 50%{transform:scale(1.15)} 100%{transform:scale(1)} }
      @keyframes ercSlideDown { from{opacity:0; transform:translateY(20px)} to{opacity:1; transform:translateY(0)} }
      @keyframes ercDotPulse { 0%{opacity:0.6} 50%{opacity:1} 100%{opacity:0.6} }
      @keyframes ercReveal { from{letter-spacing:-8px; opacity:0} to{letter-spacing:normal; opacity:1} }
      @keyframes ercBounce { 0%{transform:scale(0.85)} 50%{transform:scale(1.05)} 100%{transform:scale(1)} }
      @keyframes ercModalIn { from{transform:scale(0.95); opacity:0} to{transform:scale(1); opacity:1} }
      @keyframes ercFloatY { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-8px)} }
      @keyframes ercShimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
      .erc-page { animation:ercFade 0.15s ease; }
      .erc-card { position:relative; }
      .erc-card::before { content:''; position:absolute; top:0; left:0; right:0; height:2px; border-radius:16px 16px 0 0;
        background:linear-gradient(90deg, transparent 0%, var(--gold-bright) 50%, transparent 100%); opacity:0; transition:opacity .3s ease; pointer-events:none; }
      .erc-card:hover::before { opacity:1; }
      .erc-skel { background:linear-gradient(90deg, var(--bg-surface) 25%, var(--bg-elevated) 50%, var(--bg-surface) 75%);
        background-size:200% 100%; animation:ercShimmer 1.5s infinite; }
      .erc-modalcard { animation:ercModalIn 0.2s cubic-bezier(0.34,1.56,0.64,1); }
      @keyframes ercDot3 { 0%,100%{transform:scale(0.6); opacity:0.3} 50%{transform:scale(1.2); opacity:1} }
      @keyframes ercSpin { to{transform:rotate(360deg)} }
      @keyframes ercTabIn { from{opacity:0; transform:translateY(6px)} to{opacity:1; transform:translateY(0)} }
      .erc-tabin { animation:ercTabIn 0.2s ease-out; }
      @keyframes ercMesh { 0%{transform:translate(0,0) scale(1)} 50%{transform:translate(-3%,2%) scale(1.05)} 100%{transform:translate(0,0) scale(1)} }
      @keyframes ercGlow { 0%,100%{opacity:0.5} 50%{opacity:1} }
      @keyframes ercSheen { 0%{background-position:-150% 0} 100%{background-position:250% 0} }
      .erc-logo-gold { background:linear-gradient(110deg,var(--gold-deep) 0%,var(--gold-bright) 40%,#fff7e0 50%,var(--gold-bright) 60%,var(--gold-deep) 100%);
        background-size:250% 100%; -webkit-background-clip:text; background-clip:text; color:transparent; animation:ercSheen 6s linear infinite; }
      /* Accessibility — honour reduced-motion across the whole app */
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          animation-duration:0.001ms !important; animation-iteration-count:1 !important;
          transition-duration:0.001ms !important; scroll-behavior:auto !important;
        }
        .erc-card:hover { transform:none; }
      }
    `}</style>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function ToastContainer({ toasts }) {
  const meta = {
    success:{ c:"var(--success)", icon:"✓" }, error:{ c:"var(--danger)", icon:"✕" }, info:{ c:"var(--gold-bright)", icon:"ℹ" },
  };
  return (
    <div style={{ position:"fixed", top:72, right:24, zIndex:9999, display:"flex", flexDirection:"column", gap:10 }}>
      {toasts.slice(0,3).map(t => {
        const m = meta[t.type] || meta.info;
        return (
          <div key={t.id} style={{ background:"var(--bg-elevated)", border:"1px solid var(--border-default)",
            borderLeft:"3px solid "+m.c, borderRadius:12, padding:"12px 16px", minWidth:280, color:"var(--text-primary)",
            boxShadow:"0 8px 32px rgba(0,0,0,0.4)", display:"flex", alignItems:"center", gap:12, fontSize:14, fontWeight:500,
            animation:"ercToastIn 0.3s cubic-bezier(0.2,0.9,0.3,1.2)" }}>
            <span style={{ width:22, height:22, borderRadius:"50%", background:m.c, color:"#03070f", display:"inline-flex",
              alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:800, flexShrink:0 }}>{m.icon}</span>
            <span style={{ flex:1 }}>{t.msg}</span>
          </div>
        );
      })}
    </div>
  );
}
function useToast() {
  const [toasts, setToasts] = useState([]);
  const toast = useCallback((msg, type) => {
    const id = Math.random().toString(36).slice(2);
    setToasts(p => [...p, { id, msg, type:type||"info" }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3000);
  }, []);
  return [toasts, toast];
}

// ─── Password Strength Bar ────────────────────────────────────────────────────
function StrengthBar({ password }) {
  const s = pwStrength(password || "");
  const colors = ["var(--danger)","var(--danger)","var(--warning)","var(--warning)","var(--success)"];
  const labels = ["","Weak","Weak","Fair","Good","Strong"];
  if (!password) return null;
  return (
    <div style={{ marginTop:8 }}>
      <div style={{ display:"flex", gap:4, marginBottom:4 }}>
        {[1,2,3,4,5].map(i => (
          <div key={i} style={{ flex:1, height:4, borderRadius:2, transition:"all .2s ease",
            background: i<=s ? colors[s-1] : "var(--bg-highlight)" }} />
        ))}
      </div>
      <div style={{ fontSize:12, color:colors[s-1]||"var(--text-muted)" }}>{labels[s]||""}</div>
    </div>
  );
}

// ─── Team Badge ───────────────────────────────────────────────────────────────
function TeamBadge({ team, small }) {
  const ctx = useContext(DeptContext);
  const st = ctx ? ctx.teamStyle(team) : (TEAM_STYLES[team] || FALLBACK_STYLE);
  const label = ctx ? ctx.teamLabel(team) : team;
  return (
    <span style={{ background:st.bg, color:st.color, border:"1px solid "+st.border,
      borderRadius:20, padding:small?"2px 8px":"3px 10px",
      fontSize:small?11:12, fontWeight:600, display:"inline-block", textTransform:"capitalize" }}>{label}</span>
  );
}

// ─── Aurora background (login) ───────────────────────────────────────────────
function Aurora() {
  const blobs = [
    { top:"-10%", left:"-5%", size:520, color:"rgba(245,184,0,0.07)", dur:"62s" },
    { top:"20%", right:"-10%", size:480, color:"rgba(96,165,250,0.06)", dur:"74s" },
    { bottom:"-15%", left:"15%", size:560, color:"rgba(245,184,0,0.05)", dur:"68s" },
    { top:"40%", left:"30%", size:420, color:"rgba(167,139,250,0.05)", dur:"80s" },
    { bottom:"5%", right:"10%", size:440, color:"rgba(96,165,250,0.05)", dur:"58s" },
    { top:"-5%", right:"25%", size:380, color:"rgba(245,184,0,0.04)", dur:"70s" },
  ];
  return (
    <div style={{ position:"fixed", inset:0, overflow:"hidden", pointerEvents:"none", zIndex:0 }}>
      {blobs.map((b,i)=>(
        <div key={i} style={{ position:"absolute", top:b.top, left:b.left, right:b.right, bottom:b.bottom,
          width:b.size, height:b.size, borderRadius:"50%", filter:"blur(80px)",
          background:`radial-gradient(circle, ${b.color} 0%, transparent 70%)`,
          animation:`ercFloat ${b.dur} ease-in-out infinite` }} />
      ))}
    </div>
  );
}

// Subtle film-grain noise overlay (SVG fractal noise, fixed, non-interactive).
function NoiseOverlay() {
  const svg = encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>"
  );
  return (
    <div aria-hidden style={{ position:"fixed", inset:0, zIndex:0, pointerEvents:"none",
      backgroundImage:`url("data:image/svg+xml,${svg}")`, opacity:0.035, mixBlendMode:"overlay" }} />
  );
}

// ─── Login Screen ─────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [shakeKey, setShakeKey] = useState(0);

  const isLocalhost = ["localhost","127.0.0.1"].includes(window.location.hostname);
  const DEMO = [
    { role:"admin", username:"alex", password:"Admin@123!" },
    { role:"engineering", username:"sam", password:"Eng@123!" },
    { role:"marketing", username:"morgan", password:"Mkt@123!" },
    { role:"design", username:"jordan", password:"Des@123!" },
    { role:"ops", username:"casey", password:"Ops@123!" },
  ];

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      const { error: authErr } = await supabase.auth.signInWithPassword({
        email: usernameToEmail(username), password,
      });
      if (authErr) {
        const n = attempts + 1; setAttempts(n); setShakeKey(k=>k+1);
        setError(n >= 5 ? "Too many failed attempts. Please wait a moment and try again." :
          `Invalid username or password. ${5 - n} attempt(s) before a cooldown.`);
        return;
      }
      const user = await getMyProfile();
      if (!user) { setError("Your account has no profile. Contact an admin."); await supabase.auth.signOut(); return; }
      if (user.active === false) { setError("Your account is awaiting admin approval."); await supabase.auth.signOut(); return; }
      await touchLastLogin(user.id);
      if (user.twoFactorEnabled) {
        onLogin({ stage:"totp", user });
      } else {
        setSession({ userId:user.id, userName:user.name, team:user.team,
          loginAt:new Date().toISOString(), lastActivityAt:new Date().toISOString() });
        logAudit({ userId:user.id, userName:user.name, action:"login" });
        onLogin({ stage:"dashboard", user });
      }
    } catch (err) {
      setError(err.message || "Login failed.");
    } finally {
      setBusy(false);
    }
  };

  const fieldErr = !!error;
  const dInput = { ...S.input(), background:"var(--input-bg)", borderColor: fieldErr ? "rgba(239,68,68,0.5)" : "var(--border-default)" };

  return (
    <div style={{ minHeight:"100vh", background:"var(--bg-void)", display:"flex", alignItems:"center",
      justifyContent:"center", flexDirection:"column", padding:20, position:"relative" }}>
      <Aurora />
      <NoiseOverlay />
      <div style={{ position:"relative", zIndex:1, width:"100%", maxWidth:440, display:"flex", flexDirection:"column", alignItems:"center" }}>
        <div style={{ textAlign:"center", marginBottom:28 }}>
          <div style={{ display:"inline-flex", alignItems:"center", gap:12, animation:"ercFade 0.6s ease" }}>
            <span className="erc-logo-gold" style={{ fontSize:34, fontWeight:900, letterSpacing:2, fontFamily:"var(--font-ui)" }}>EAGLE</span>
            <span style={{ width:1, height:26, background:"var(--border-strong)" }} />
            <span style={{ fontSize:34, fontWeight:200, letterSpacing:6, color:"var(--text-primary)" }}>RCM</span>
          </div>
          <p style={{ color:"var(--text-secondary)", fontSize:12, marginTop:10, letterSpacing:0.5, textTransform:"uppercase", fontWeight:500 }}>Credential intelligence for high-performing teams</p>
        </div>

        <form key={shakeKey} onSubmit={handleSubmit} style={{ width:"100%", ...glass, borderTop:"1px solid rgba(245,184,0,0.3)",
          padding:32, animation: fieldErr ? "ercShake 0.3s ease" : "none" }}>
          <div style={{ marginBottom:16 }}>
            <label style={S.label}>Username</label>
            <input value={username} onChange={e=>{setUsername(e.target.value); setError("");}} style={dInput} placeholder="Enter username" autoFocus />
          </div>
          <div style={{ marginBottom:18, position:"relative" }}>
            <label style={S.label}>Password</label>
            <input type={showPw?"text":"password"} value={password} onChange={e=>{setPassword(e.target.value); setError("");}}
              style={{ ...dInput, paddingRight:44 }} placeholder="Enter password" />
            <button type="button" onClick={()=>setShowPw(p=>!p)}
              style={{ position:"absolute", right:12, top:30, background:"none", border:"none", cursor:"pointer", color:"var(--text-muted)", fontSize:16, padding:0 }}>{showPw?"🙈":"👁"}</button>
          </div>
          {error && <div style={{ background:"var(--danger-bg)", border:"1px solid rgba(239,68,68,0.3)",
            color:"#fca5a5", borderRadius:10, padding:"10px 14px", fontSize:13, marginBottom:16 }}>{error}</div>}
          <button type="submit" disabled={busy} className="erc-prim" style={{ ...S.btn("primary"), width:"100%", height:48,
            fontSize:14, justifyContent:"center", gap:10, opacity:busy?0.85:1 }}>
            {busy && <span style={{ width:16, height:16, borderRadius:"50%", border:"2px solid rgba(0,0,0,0.35)",
              borderTopColor:"rgba(0,0,0,0.85)", display:"inline-block", animation:"ercSpin 0.8s linear infinite" }} />}
            {busy?"Signing in…":"Sign In"}
          </button>
        </form>

        {isLocalhost && (
          <div style={{ marginTop:24, width:"100%" }}>
            <div style={{ ...microLabel, color:"var(--text-muted)", marginBottom:10 }}>Demo accounts</div>
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {DEMO.map(d=>{
                const st = TEAM_STYLES[d.role];
                return (
                  <button key={d.username} type="button" className="erc-card"
                    onClick={()=>{ setUsername(d.username); setPassword(d.password); setError(""); }}
                    style={{ ...glass, padding:"10px 14px", display:"flex", alignItems:"center", gap:12, cursor:"pointer", textAlign:"left" }}>
                    <span style={{ width:32, height:32, borderRadius:"50%", background:st.bg, color:st.color, border:"1px solid "+st.border,
                      display:"inline-flex", alignItems:"center", justifyContent:"center", fontWeight:700, fontSize:12 }}>{getInitials(d.username)}</span>
                    <span style={{ fontFamily:"var(--font-mono)", fontSize:13, color:"var(--text-primary)", flex:1 }}>{d.username}</span>
                    <TeamBadge team={d.role} small />
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Registration (invite link) ──────────────────────────────────────────────
const genToken = () => { const a=new Uint8Array(16); crypto.getRandomValues(a); return [...a].map(b=>b.toString(16).padStart(2,"0")).join(""); };

function RegistrationScreen({ token, onBackToLogin }) {
  const [phase, setPhase] = useState("loading"); // loading | invalid | form | success
  const [reason, setReason] = useState("");
  const [info, setInfo] = useState({ allowedTeam:null, teams:[], label:"" });
  const [form, setForm] = useState({ fullName:"", username:"", password:"", confirm:"", team:"" });
  const [unameState, setUnameState] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k,v)=>setForm(p=>({...p,[k]:v}));

  useEffect(() => {
    inviteValidate(token).then(r => {
      if (!r.valid) { setReason(r.reason || "Invalid invite link."); setPhase("invalid"); return; }
      setInfo({ allowedTeam:r.allowedTeam, teams:r.teams||[], label:r.label||"" });
      setForm(f => ({ ...f, team: r.allowedTeam || (r.teams&&r.teams[0]?r.teams[0].id:"") }));
      setPhase("form");
    }).catch(e => { setReason(e.message); setPhase("invalid"); });
  }, [token]);

  useEffect(() => {
    const u = form.username.trim();
    if (!u) { setUnameState(null); return; }
    setUnameState("checking");
    const t = setTimeout(() => { inviteCheckUsername(u).then(r => setUnameState(r.available?"available":"taken")).catch(()=>setUnameState(null)); }, 400);
    return () => clearTimeout(t);
  }, [form.username]);

  const submit = async (e) => {
    e.preventDefault(); setError("");
    if (!form.fullName.trim()||!form.username.trim()||!form.password) { setError("Fill in all required fields."); return; }
    if (unameState==="taken") { setError("That username is already taken."); return; }
    if (form.password!==form.confirm) { setError("Passwords don't match."); return; }
    if (pwStrength(form.password)<3) { setError("Password is too weak."); return; }
    setBusy(true);
    try {
      await inviteSubmit({ token, fullName:form.fullName.trim(), username:form.username.trim(), password:form.password, requestedTeam: info.allowedTeam || form.team });
      setPhase("success");
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const dInput = { ...S.input(), background:"var(--input-bg)" };
  const wrap = (children) => (
    <div style={{ minHeight:"100vh", background:"var(--bg-void)", display:"flex", alignItems:"center", justifyContent:"center", padding:20, position:"relative" }}>
      <Aurora /><div style={{ position:"relative", zIndex:1, width:"100%", maxWidth:440, display:"flex", flexDirection:"column", alignItems:"center" }}>{children}</div>
    </div>
  );
  const logo = (
    <div style={{ textAlign:"center", marginBottom:24 }}>
      <div style={{ display:"inline-flex", alignItems:"center", gap:11, marginBottom:8 }}>
        <span className="erc-logo-gold" style={{ fontSize:30, fontWeight:900, letterSpacing:2 }}>EAGLE</span>
        <span style={{ width:1, height:22, background:"var(--border-strong)" }} />
        <span style={{ fontSize:30, fontWeight:200, letterSpacing:5, color:"var(--text-primary)" }}>RCM</span>
      </div>
      <p style={{ color:"var(--text-secondary)", fontSize:13, marginTop:6 }}>You've been invited to join</p>
    </div>
  );

  if (phase==="loading") return wrap(<div style={{ color:"var(--text-secondary)" }}>Checking invite…</div>);
  if (phase==="invalid") return wrap(<>{logo}
    <div style={{ ...glass, padding:32, width:"100%", textAlign:"center" }}>
      <div style={{ fontSize:34, marginBottom:10 }}>⚠️</div>
      <div style={{ color:"var(--text-primary)", fontWeight:600, marginBottom:12 }}>{reason}</div>
      <button onClick={onBackToLogin} style={{ background:"none", border:"none", color:"var(--gold-bright)", cursor:"pointer", fontSize:13 }}>← Back to login</button>
    </div></>);
  if (phase==="success") return wrap(<>{logo}
    <div style={{ ...glass, padding:32, width:"100%", textAlign:"center" }}>
      <div style={{ width:64, height:64, borderRadius:"50%", background:"var(--gold-dim)", color:"var(--gold-bright)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:32, margin:"0 auto 14px" }}>✓</div>
      <h3 style={{ color:"var(--text-primary)", fontWeight:700, fontSize:18, marginBottom:8 }}>Request submitted!</h3>
      <p style={{ color:"var(--text-secondary)", fontSize:14, marginBottom:16 }}>Your admin has been notified. You'll be able to log in once your account is approved.</p>
      <button onClick={onBackToLogin} style={{ background:"none", border:"none", color:"var(--gold-bright)", cursor:"pointer", fontSize:13 }}>← Back to login</button>
    </div></>);

  const teamLocked = !!info.allowedTeam;
  return wrap(<>{logo}
    <form onSubmit={submit} style={{ width:"100%", ...glass, borderTop:"1px solid rgba(245,184,0,0.3)", padding:32 }}>
      <div style={{ marginBottom:14 }}><label style={S.label}>Full Name</label>
        <input value={form.fullName} onChange={e=>set("fullName",e.target.value)} style={dInput} required /></div>
      <div style={{ marginBottom:14 }}><label style={S.label}>Username</label>
        <input value={form.username} onChange={e=>set("username",e.target.value.toLowerCase())} style={dInput} required />
        {form.username && unameState==="available" && <p style={{ color:"var(--success)", fontSize:12, marginTop:4 }}>✓ Available</p>}
        {form.username && unameState==="taken" && <p style={{ color:"#fca5a5", fontSize:12, marginTop:4 }}>✗ Already taken</p>}
        {form.username && unameState==="checking" && <p style={{ color:"var(--text-muted)", fontSize:12, marginTop:4 }}>Checking…</p>}
      </div>
      <div style={{ marginBottom:14 }}><label style={S.label}>Password</label>
        <input type="password" value={form.password} onChange={e=>set("password",e.target.value)} style={dInput} required />
        <StrengthBar password={form.password} /></div>
      <div style={{ marginBottom:14 }}><label style={S.label}>Confirm Password</label>
        <input type="password" value={form.confirm} onChange={e=>set("confirm",e.target.value)} style={dInput} required /></div>
      <div style={{ marginBottom:18 }}><label style={S.label}>Team</label>
        {teamLocked
          ? <input value={(info.teams.find(t=>t.id===info.allowedTeam)||{}).label || info.allowedTeam} disabled style={{ ...dInput, opacity:0.6 }} />
          : <select value={form.team} onChange={e=>set("team",e.target.value)} style={dInput}>
              {info.teams.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}
            </select>}
      </div>
      {error && <div style={{ background:"var(--danger-bg)", border:"1px solid rgba(239,68,68,0.3)", color:"#fca5a5", borderRadius:10, padding:"10px 14px", fontSize:13, marginBottom:14 }}>{error}</div>}
      <button type="submit" disabled={busy} className="erc-prim" style={{ ...S.btn("primary"), width:"100%", height:48, justifyContent:"center", opacity:busy?0.7:1 }}>{busy?"Submitting…":"Request Access"}</button>
      <p style={{ color:"var(--text-muted)", fontSize:12, textAlign:"center", marginTop:12 }}>Your account will be active once approved by an admin.</p>
    </form>
  </>);
}

// ─── Generate Invite Link Modal ───────────────────────────────────────────────
function GenerateInviteModal({ createdBy, onClose, onCreated, toast }) {
  const ctx = useDepts();
  const deptList = ctx ? ctx.list : DEFAULT_DEPTS;
  const [label, setLabel] = useState("");
  const [team, setTeam] = useState("");
  const [maxUses, setMaxUses] = useState(1);
  const [expiry, setExpiry] = useState(72);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState(false);
  const link = created ? `${window.location.origin}?invite=${created.token}` : "";

  const generate = async () => {
    setBusy(true);
    try {
      const token = genToken();
      const expiresAt = new Date(Date.now() + expiry*3600*1000).toISOString();
      const rec = await createInviteToken({ token, label, allowedTeam:team||null, maxUses:Math.max(1,Math.min(10,+maxUses||1)), expiresAt }, createdBy);
      setCreated(rec); onCreated && onCreated(); toast("Invite link generated","success");
    } catch (e) { toast(e.message && e.message.includes("does not exist") ? "Run migration_5_registration.sql in Supabase first." : e.message, "error"); }
    finally { setBusy(false); }
  };
  const copy = () => { navigator.clipboard.writeText(link).then(()=>{ setCopied(true); setTimeout(()=>setCopied(false),2000); }); };

  return (
    <div style={S.overlay} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ ...S.modal(), padding:28, width:"90%", maxWidth:460 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
          <h3 style={{ fontWeight:700, fontSize:18, color:"var(--text-primary)" }}>Generate Invite Link</h3>
          <button onClick={onClose} className="erc-ghost" style={{ ...S.btn("ghost"), padding:"6px 10px" }}>✕</button>
        </div>
        {!created ? (<>
          <div style={{ marginBottom:14 }}><label style={S.label}>Label / note</label>
            <input value={label} onChange={e=>setLabel(e.target.value)} style={S.input()} placeholder="e.g. For new marketing hire" /></div>
          <div style={{ marginBottom:14 }}><label style={S.label}>Pre-assign team (optional)</label>
            <select value={team} onChange={e=>setTeam(e.target.value)} style={S.input()}>
              <option value="">Admin picks on approval</option>
              {deptList.map(d=><option key={d.id} value={d.id}>{d.label}</option>)}
            </select></div>
          <div style={{ display:"flex", gap:12, marginBottom:20 }}>
            <div style={{ flex:1 }}><label style={S.label}>Max uses</label>
              <input type="number" min={1} max={10} value={maxUses} onChange={e=>setMaxUses(e.target.value)} style={S.input()} /></div>
            <div style={{ flex:1 }}><label style={S.label}>Expiry</label>
              <select value={expiry} onChange={e=>setExpiry(+e.target.value)} style={S.input()}>
                <option value={24}>24 hours</option><option value={48}>48 hours</option><option value={72}>72 hours</option><option value={168}>7 days</option>
              </select></div>
          </div>
          <button onClick={generate} disabled={busy} className="erc-prim" style={{ ...S.btn("primary"), width:"100%", justifyContent:"center", opacity:busy?0.7:1 }}>{busy?"Generating…":"Generate Link"}</button>
        </>) : (<>
          <p style={{ color:"var(--text-secondary)", fontSize:13, marginBottom:10 }}>Share this link with the person you want to invite.</p>
          <div style={{ display:"flex", gap:8, marginBottom:14 }}>
            <input readOnly value={link} style={{ ...S.input(), fontFamily:"var(--font-mono)", fontSize:12 }} onFocus={e=>e.target.select()} />
            <button onClick={copy} className="erc-prim" style={{ ...S.btn("primary"), flexShrink:0 }}>{copied?"✓ Copied":"Copy"}</button>
          </div>
          <p style={{ color:"var(--text-muted)", fontSize:12, marginBottom:18 }}>
            {created.maxUses>1?`Usable up to ${created.maxUses} times.`:"Single-use link."} Expires {fmtDate(created.expiresAt)}.
          </p>
          <button onClick={onClose} className="erc-ghost" style={{ ...S.btn("ghost"), width:"100%", justifyContent:"center" }}>Done</button>
        </>)}
      </div>
    </div>
  );
}

// ─── Reject Registration Modal ────────────────────────────────────────────────
function RejectModal({ reg, onClose, onSubmit }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); try { await onSubmit(reason); onClose(); } finally { setBusy(false); } };
  return (
    <div style={S.overlay} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ ...S.modal(), padding:28, width:"90%", maxWidth:420 }}>
        <h3 style={{ fontWeight:700, fontSize:18, color:"var(--text-primary)", marginBottom:8 }}>Reject {reg.fullName}?</h3>
        <p style={{ color:"var(--text-secondary)", fontSize:13, marginBottom:14 }}>Their pending account will be removed.</p>
        <label style={S.label}>Reason (optional)</label>
        <textarea value={reason} onChange={e=>setReason(e.target.value)} style={{ ...S.input(), resize:"vertical", minHeight:70, marginBottom:16 }} placeholder="Shared internally only" />
        <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
          <button onClick={onClose} className="erc-ghost" style={S.btn("ghost")}>Cancel</button>
          <button onClick={go} disabled={busy} style={{ ...S.btn("danger"), opacity:busy?0.7:1 }}>Reject</button>
        </div>
      </div>
    </div>
  );
}

// ─── Approve Registration Modal ───────────────────────────────────────────────
function ApproveRegModal({ reg, onClose, onConfirm }) {
  const ctx = useDepts();
  const deptList = ctx ? ctx.list : DEFAULT_DEPTS;
  const [team, setTeam] = useState(reg.requestedTeam || (deptList[0]&&deptList[0].id) || "engineering");
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); try { await onConfirm(team); } finally { setBusy(false); } };
  return (
    <div style={S.overlay} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ ...S.modal(), padding:28, width:"90%", maxWidth:420 }}>
        <h3 style={{ fontWeight:700, fontSize:18, color:"var(--text-primary)", marginBottom:8 }}>Approve {reg.fullName}?</h3>
        <p style={{ color:"var(--text-secondary)", fontSize:13, marginBottom:16 }}>@{reg.username} will be able to log in immediately.</p>
        <label style={S.label}>Assign department</label>
        <select value={team} onChange={e=>setTeam(e.target.value)} style={{ ...S.input(), marginBottom:20 }}>
          {deptList.map(d=><option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
        <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
          <button onClick={onClose} className="erc-ghost" style={S.btn("ghost")}>Cancel</button>
          <button onClick={go} disabled={busy} className="erc-prim" style={{ ...S.btn("primary"), opacity:busy?0.7:1 }}>Approve</button>
        </div>
      </div>
    </div>
  );
}

// ─── TOTP Screen ──────────────────────────────────────────────────────────────
function TOTPScreen({ user, onVerify, onBack }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  const handleVerify = () => {
    setError("");
    const secret = OTPAuth.Secret.fromBase32(user.twoFactorSecret);
    const totp = new OTPAuth.TOTP({ issuer:"Eagle RCM", label:user.username,
      algorithm:"SHA1", digits:6, period:30, secret });
    if (totp.validate({ token:code.trim(), window:1 }) === null) { setError("Invalid code. Please try again."); return; }
    setSession({ userId:user.id, userName:user.name, team:user.team,
      loginAt:new Date().toISOString(), lastActivityAt:new Date().toISOString() });
    logAudit({ userId:user.id, userName:user.name, action:"login" });
    onVerify(user);
  };
  const back = async () => { await supabase.auth.signOut(); onBack(); };

  return (
    <div style={{ minHeight:"100vh", background:"var(--bg-void)", display:"flex", alignItems:"center", justifyContent:"center", padding:20, position:"relative" }}>
      <Aurora />
      <div style={{ position:"relative", zIndex:1, ...glass, borderTop:"1px solid rgba(245,184,0,0.3)", padding:36, width:"100%", maxWidth:380 }}>
        <div style={{ textAlign:"center", marginBottom:24 }}>
          <div style={{ fontSize:30, marginBottom:8 }}>🔒</div>
          <h2 style={{ color:"var(--text-primary)", fontSize:20, fontWeight:700 }}>Two-Factor Authentication</h2>
          <p style={{ color:"var(--text-secondary)", fontSize:13, marginTop:6 }}>Enter the 6-digit code from your authenticator app</p>
        </div>
        <input value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,"").slice(0,6))}
          style={{ ...S.input(), textAlign:"center", fontSize:24, letterSpacing:8, marginBottom:12, fontFamily:"var(--font-mono)" }}
          placeholder="000000" maxLength={6} />
        {error && <div style={{ color:"#fca5a5", fontSize:13, marginBottom:12, textAlign:"center" }}>{error}</div>}
        <button onClick={handleVerify} className="erc-prim" style={{ ...S.btn("primary"), width:"100%", height:46, fontSize:15, marginBottom:12, justifyContent:"center" }}>Verify</button>
        <button onClick={back} style={{ background:"none", border:"none", cursor:"pointer", color:"var(--text-secondary)", fontSize:13, width:"100%", textAlign:"center" }}>← Back to login</button>
      </div>
    </div>
  );
}

// ─── Inactivity Modal ─────────────────────────────────────────────────────────
function InactivityModal({ countdown, onStay, onLogout }) {
  const R = 54, CIRC = 2 * Math.PI * R;
  const pct = Math.max(0, Math.min(1, countdown / 60));
  const ringColor = countdown > 30 ? "var(--success)" : countdown > 10 ? "var(--warning)" : "var(--danger)";
  return (
    <div style={{ ...S.overlay, background:"rgba(3,7,15,0.92)" }}>
      <div style={{ ...glass, padding:36, maxWidth:400, width:"90%", textAlign:"center" }}>
        <div style={{ position:"relative", width:140, height:140, margin:"0 auto 20px" }}>
          <svg width="140" height="140" style={{ transform:"rotate(-90deg)" }}>
            <circle cx="70" cy="70" r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="8" />
            <circle cx="70" cy="70" r={R} fill="none" stroke={ringColor} strokeWidth="8" strokeLinecap="round"
              strokeDasharray={CIRC} strokeDashoffset={CIRC*(1-pct)} style={{ transition:"stroke-dashoffset 1s linear, stroke .3s" }} />
          </svg>
          <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:48, fontWeight:800, fontFamily:"var(--font-mono)", color:"var(--gold-bright)" }}>{countdown}</div>
        </div>
        <h3 style={{ fontSize:20, fontWeight:700, color:"var(--text-primary)", marginBottom:8 }}>Session expiring</h3>
        <p style={{ color:"var(--text-secondary)", marginBottom:22, fontSize:14 }}>You'll be signed out due to inactivity.</p>
        <button onClick={onStay} className="erc-prim" style={{ ...S.btn("primary"), width:"100%", height:46, justifyContent:"center" }}>Stay Logged In</button>
      </div>
    </div>
  );
}

// ─── Credential Card ──────────────────────────────────────────────────────────
// ─── Client badges (multi-client, with +X more tooltip) ──────────────────────
function ClientBadges({ cred, clientsById, pulse }) {
  const [hover, setHover] = useState(false);
  const ids = cred.clientIds || [];
  const items = ids.map((id,i) => { const c = clientsById && clientsById[id];
    return { name: c ? c.name : ((cred.clientNames && cred.clientNames[i]) || id), color: c ? c.color : "#64748b" }; });
  if (items.length === 0) return null;
  const dot = (color) => <span style={{ width:7, height:7, borderRadius:"50%", background:color, animation: pulse?"ercDotPulse 3s ease-in-out infinite":"none" }} />;
  const pill = (it, key) => (
    <span key={key} style={{ background:hexA(it.color,0.15), color:it.color, border:"1px solid "+hexA(it.color,0.4),
      borderRadius:20, padding:"2px 9px", fontSize:11, fontWeight:600, display:"inline-flex", alignItems:"center", gap:5 }}>{dot(it.color)}{it.name}</span>
  );
  if (items.length === 1) return pill(items[0], 0);
  const shown = items.slice(0,2), rest = items.slice(2);
  return (
    <>
      {shown.map((it,i)=>pill(it,i))}
      {rest.length>0 && (
        <span style={{ position:"relative", display:"inline-flex" }} onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)}>
          <span style={{ background:"rgba(255,255,255,0.05)", color:"var(--text-secondary)", border:"1px solid var(--border-default)",
            borderRadius:20, padding:"2px 9px", fontSize:11, fontWeight:600, cursor:"default" }}>+{rest.length} more</span>
          {hover && (
            <span style={{ position:"absolute", top:"calc(100% + 4px)", left:0, zIndex:50, background:"var(--bg-elevated)",
              border:"1px solid var(--border-default)", borderRadius:8, padding:"6px 10px", fontSize:12, whiteSpace:"nowrap", boxShadow:"0 8px 24px rgba(0,0,0,0.4)" }}>
              {items.map((it,i)=>(<span key={i} style={{ display:"flex", alignItems:"center", gap:6, padding:"2px 0", color:"var(--text-primary)" }}>{dot(it.color)}{it.name}</span>))}
            </span>
          )}
        </span>
      )}
    </>
  );
}

// ─── Status popover (Mark In Use / Report Issue / Resolve) ───────────────────
function StatusPopover({ kind, note, setNote, onConfirm, onClose, anchorStyle }) {
  const [busy, setBusy] = useState(false);
  const cfg = {
    inuse:   { title:"Add a note (optional)",   ph:"e.g. Running payroll batch", max:80,  btn:"Confirm",          variant:"primary", required:false },
    report:  { title:"Describe the issue",      ph:"e.g. Password incorrect, login page changed, account locked, MFA not matching", max:200, btn:"Submit Report", variant:"danger", required:true },
    resolve: { title:"Resolution note (optional)", ph:"e.g. Password updated, issue fixed", max:160, btn:"Confirm Resolved", variant:"primary", required:false },
  }[kind];
  const go = async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } };
  return (
    <div style={{ position:"absolute", top:"calc(100% + 8px)", left:0, zIndex:60, width:260, background:"var(--bg-elevated)",
      border:"1px solid var(--border-default)", borderRadius:12, padding:14, boxShadow:"var(--modal-shadow)", animation:"ercSlideDown 0.2s ease", ...(anchorStyle||{}) }}>
      <label style={S.label}>{cfg.title}{cfg.required?" *":""}</label>
      <textarea value={note} onChange={e=>setNote(e.target.value.slice(0,cfg.max))} placeholder={cfg.ph} autoFocus
        style={{ ...S.input(), minHeight:60, resize:"vertical", fontSize:13 }} />
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:8 }}>
        <span style={{ fontSize:11, color:"var(--text-muted)" }}>{note.length}/{cfg.max}</span>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          <button onClick={onClose} style={{ background:"none", border:"none", color:"var(--text-muted)", cursor:"pointer", fontSize:12 }}>Cancel</button>
          <button onClick={go} disabled={busy || (cfg.required && !note.trim())}
            style={{ ...S.btn(cfg.variant), padding:"6px 12px", fontSize:12, opacity:(busy||(cfg.required && !note.trim()))?0.5:1 }}>{cfg.btn}</button>
        </div>
      </div>
    </div>
  );
}

function CredentialCard({ cred, session, clientsById, onEdit, onDelete, onCopy, onCopyVerify, onFavToggle, isFav,
  requests, onRequestAccess, toast, onPatch, onMarkInUse, onReleaseInUse, onReportIssue, onResolveIssue, index }) {
  const [showPw, setShowPw] = useState(false);
  const [copied, setCopied] = useState(null);
  const [popover, setPopover] = useState(null); // 'inuse' | 'report' | 'resolve' | null
  const [note, setNote] = useState("");
  const hasAccess = canAccess(cred, session.team);
  const isAdmin = session.team === "admin";
  const age = daysSince(cred.updatedAt);
  const ageColor = age < 30 ? "var(--success)" : age < 60 ? "var(--warning)" : "var(--danger)";
  const isAllClients = (cred.clientIds||[]).includes("all");
  const myClients = resolveClients(cred, clientsById);
  const privilege = highestPrivilege(myClients);
  const confidentialBlock = privilege === "confidential" && !isAdmin;
  const restrictedPw = privilege === "restricted" && !isAdmin;
  const clientColor = isAllClients ? "#f5b800" : (myClients[0] ? myClients[0].color : "#64748b");
  const headTint = hexA(clientColor, 0.15);
  const pendingReq = requests.find(r => r.credentialId===cred.id && r.requesterId===session.userId && r.status==="pending");
  const expiryDays = cred.passwordExpiryDays || 90;
  const daysLeft = expiryDays - age;

  const tr = evalTimeRestriction(cred.timeRestriction);
  const lockedByTime = tr.state === "expired";
  const cardExtra =
    tr.state === "expired" ? { borderLeft:"4px solid var(--danger)", background:"linear-gradient(135deg, rgba(239,68,68,0.06), var(--surface-grad-2))" } :
    (tr.state === "outside" || tr.state === "wrongday" || tr.state === "expiring") ? { borderLeft:"4px solid var(--warning)" } :
    isFav ? { borderTop:"2px solid rgba(245,184,0,0.4)" } : {};

  // In Use / Not Working status
  const inUse = !!cred.inUse;
  const notWorking = !!cred.notWorking;
  const inUseStale = inUse && hoursSince(cred.inUseSince) >= 8;
  const iTagged = inUse && cred.inUseByUserId === session.userId;
  const iReported = notWorking && cred.notWorkingReportedById === session.userId;
  let statusExtra = {}, leftBorderEl = null;
  if (notWorking && inUse) {
    statusExtra = { borderLeft:"3px solid transparent", background:"linear-gradient(135deg, rgba(239,68,68,0.07) 0%, var(--bg-surface) 60%)" };
    leftBorderEl = <div style={{ position:"absolute", left:0, top:0, bottom:0, width:3, background:"linear-gradient(180deg,#f97316 0%,#ef4444 100%)" }} />;
  } else if (notWorking) {
    statusExtra = { borderLeft:"3px solid #ef4444", background:"linear-gradient(135deg, rgba(239,68,68,0.07) 0%, var(--bg-surface) 60%)" };
  } else if (inUse) {
    statusExtra = inUseStale
      ? { borderLeft:"3px solid #f59e0b", background:"linear-gradient(135deg, rgba(245,158,11,0.06) 0%, var(--bg-surface) 60%)" }
      : { borderLeft:"3px solid #f97316", background:"linear-gradient(135deg, rgba(249,115,22,0.06) 0%, var(--bg-surface) 60%)" };
  }
  const finalExtra = (inUse || notWorking) ? { ...cardExtra, ...statusExtra } : cardExtra;

  const hasVerify = !!(cred.verifyEmail || cred.verifyText || cred.verifyAuth);
  const flash = (key) => { setCopied(key); setTimeout(()=>setCopied(c=>c===key?null:c), 2000); };

  const handleCopyField = (value, field, key) => {
    if (!hasAccess || lockedByTime) return;
    navigator.clipboard.writeText(value).then(() => { onCopy && onCopy(cred, field); flash(key); toast && toast(field + " copied!", "success"); });
  };
  const handleCopyVerify = (value, field, key) => {
    if (!hasAccess || lockedByTime) return;
    navigator.clipboard.writeText(value).then(() => { onCopyVerify && onCopyVerify(cred, field); flash(key); toast && toast(field + " copied!", "success"); });
  };

  const FieldRow = ({ label, value, masked, copyKey, field, extraBg, showToggle }) => (
    <div style={{ ...fieldBox, ...(extraBg?{ background:extraBg }:{}) }}>
      <div style={{ ...microLabel, marginBottom:4 }}>{label}</div>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8 }}>
        {hasAccess
          ? <code key={masked?(showPw?"r":"m"):"v"} style={{ ...monoVal(masked && !showPw), ...(masked&&showPw?{ animation:"ercReveal 0.2s ease" }:{}) }}>{value}</code>
          : <span style={{ fontSize:13, color:"var(--text-muted)", flex:1 }}>No access</span>}
        {hasAccess && (
          <div style={{ display:"flex", gap:6, flexShrink:0 }}>
            {showToggle && <button onClick={()=>setShowPw(p=>!p)} disabled={lockedByTime} style={iconBtn(false, lockedByTime)}>{showPw?"🙈":"👁"}</button>}
            <button onClick={()=>handleCopyField(field, label, copyKey)} disabled={lockedByTime}
              style={{ ...iconBtn(copied===copyKey, lockedByTime), ...(copied===copyKey?{ animation:"ercBounce 0.3s" }:{}) }}>{copied===copyKey?"✓":"📋"}</button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="erc-card" style={{ ...S.card(), ...finalExtra, display:"flex", flexDirection:"column", gap:"var(--card-gap)",
      height:"100%", position:"relative", zIndex: popover ? 50 : undefined,
      animation:`ercCardIn 0.3s ease-out both`, animationDelay:`${(index||0)*40}ms` }}>
      {leftBorderEl}
      {/* Header */}
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:8 }}>
        <div style={{ display:"flex", gap:10, flex:1, minWidth:0 }}>
          <span style={{ width:36, height:36, borderRadius:"50%", background:headTint, border:"1px solid "+hexA(clientColor,0.3),
            display:"inline-flex", alignItems:"center", justifyContent:"center", fontSize:18, flexShrink:0 }}>🔑</span>
          <div style={{ minWidth:0 }}>
            <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
              <span style={{ fontWeight:700, fontSize:15, color:"var(--text-primary)" }}>{cred.portal}</span>
              {inUse && (
                <span style={{ background:"rgba(249,115,22,0.15)", color:"#f97316", border:"1px solid rgba(249,115,22,0.4)",
                  borderRadius:20, padding:"2px 8px", fontSize:10, fontWeight:700 }}>🟠 In Use</span>
              )}
              {notWorking && (
                <span style={{ background:"rgba(239,68,68,0.15)", color:"#f87171", border:"1px solid rgba(239,68,68,0.4)",
                  borderRadius:20, padding:"2px 8px", fontSize:10, fontWeight:700 }}>❌ Not Working</span>
              )}
            </div>
            {cred.url && <a href={"https://"+cred.url} target="_blank" rel="noreferrer" style={{ color:"var(--text-secondary)", fontSize:12, textDecoration:"none" }}>🔗 {cred.url}</a>}
            <div style={{ marginTop:4, display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
              {isAllClients ? (
                <span style={{ background:"rgba(245,184,0,0.12)", color:"#f5b800", border:"1px solid rgba(245,184,0,0.3)",
                  borderRadius:20, padding:"2px 9px", fontSize:11, fontWeight:600, display:"inline-flex", alignItems:"center", gap:5 }}>
                  <span style={{ width:7, height:7, borderRadius:"50%", background:"#f5b800",
                    animation: privilege==="confidential"?"ercDotPulse 3s ease-in-out infinite":"none" }} />🌐 All Clients
                </span>
              ) : (cred.clientIds||[]).length>0 ? (
                <ClientBadges cred={cred} clientsById={clientsById} pulse={privilege==="confidential"} />
              ) : null}
              {privilege==="restricted" && (
                <span style={{ background:"var(--warning-bg)", color:"#fcd34d", border:"1px solid rgba(245,158,11,0.3)",
                  borderRadius:20, padding:"2px 8px", fontSize:10, fontWeight:700 }}>🔒 Restricted</span>
              )}
              {privilege==="confidential" && (
                <span style={{ background:"var(--danger-bg)", color:"#fca5a5", border:"1px solid rgba(239,68,68,0.3)",
                  borderRadius:20, padding:"2px 8px", fontSize:10, fontWeight:700 }}>🔒 Confidential</span>
              )}
            </div>
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
          <button onClick={()=>onFavToggle(cred.id)} style={{ background:"none", border:"none", cursor:"pointer", fontSize:20,
            color:isFav?"var(--gold-bright)":"var(--text-muted)", padding:0 }}>★</button>
        </div>
      </div>

      <div style={{ height:1, background:"var(--border-subtle)" }} />

      {/* In Use banner */}
      {inUse && (
        <div style={{ background:inUseStale?"rgba(245,158,11,0.12)":"rgba(249,115,22,0.12)", border:"1px solid "+(inUseStale?"rgba(245,158,11,0.3)":"rgba(249,115,22,0.25)"),
          borderRadius:8, padding:"8px 12px", display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
          <span style={{ flex:1, fontSize:12, color:inUseStale?"#fcd34d":"#fdba74" }}>
            🟠 <strong>In Use by {cred.inUseBy}</strong> · {timeAgo(cred.inUseSince)}
            {cred.inUseNote && <span style={{ fontStyle:"italic", color:"var(--text-muted)" }}> · {cred.inUseNote}</span>}
            {inUseStale && <span style={{ display:"block", color:"#fcd34d", fontWeight:600, marginTop:2 }}>⚠️ Tagged 8h+ ago — may have been forgotten</span>}
          </span>
          {(iTagged || isAdmin) && (
            <button onClick={()=>onReleaseInUse(cred)} style={{ ...S.btn("ghost"), padding:"4px 10px", fontSize:11, color:"#fb923c", borderColor:"rgba(249,115,22,0.4)" }}>{(inUseStale&&isAdmin&&!iTagged)?"Force Release":"Release"}</button>
          )}
        </div>
      )}
      {/* Not Working banner */}
      {notWorking && (
        <div style={{ background:"rgba(239,68,68,0.12)", border:"1px solid rgba(239,68,68,0.3)", borderRadius:8, padding:"10px 14px", display:"flex", alignItems:"flex-start", gap:10, flexWrap:"wrap" }}>
          <span style={{ fontSize:14 }}>❌</span>
          <span style={{ flex:1, minWidth:0 }}>
            <span style={{ fontSize:13, fontWeight:700, color:"#f87171" }}>Not Working</span>
            <span style={{ display:"block", fontSize:12, color:"var(--text-secondary)" }}>Reported by {cred.notWorkingReportedBy} · {fmtSmartTime(cred.notWorkingAt)}</span>
            {cred.notWorkingNote && <span style={{ display:"block", fontSize:12, color:"var(--text-muted)", fontStyle:"italic", marginTop:2 }}>{cred.notWorkingNote}</span>}
          </span>
          {isAdmin
            ? <button onClick={()=>{ setNote(""); setPopover("resolve"); }} className="erc-prim" style={{ ...S.btn("primary"), padding:"5px 12px", fontSize:11 }}>Mark Resolved</button>
            : iReported ? <button onClick={()=>{ setNote(cred.notWorkingNote||""); setPopover("report"); }} style={{ ...S.btn("ghost"), padding:"5px 12px", fontSize:11 }}>Update Note</button> : null}
        </div>
      )}

      {/* Time status badges/banners */}
      {tr.state==="active" && (
        <span style={{ alignSelf:"flex-start", background:"var(--success-bg)", color:"var(--success)", border:"1px solid rgba(16,185,129,0.3)",
          borderRadius:20, padding:"2px 10px", fontSize:11, fontWeight:700 }}>🟢 Active now</span>
      )}
      {tr.state==="schedule" && tr.note && (
        <span style={{ alignSelf:"flex-start", background:"var(--info-bg)", color:"var(--info)", border:"1px solid rgba(96,165,250,0.3)",
          borderRadius:20, padding:"3px 10px", fontSize:11, fontWeight:600 }}>ℹ️ {tr.note}</span>
      )}
      {(tr.state==="outside" || tr.state==="wrongday" || tr.state==="expiring") && (
        <div style={{ background:"var(--warning-bg)", border:"1px solid rgba(245,158,11,0.3)", color:"#fcd34d",
          borderRadius:10, padding:"8px 12px", fontSize:12, fontWeight:600 }}>{tr.state==="expiring" ? "⚠️" : "⏰"} {tr.label}</div>
      )}
      {tr.state==="expired" && (
        <div style={{ background:"var(--danger-bg)", border:"1px solid rgba(239,68,68,0.3)", color:"#fca5a5",
          borderRadius:10, padding:"8px 12px", fontSize:12, fontWeight:600 }}>🔴 {tr.label}</div>
      )}

      {confidentialBlock ? (
        <div style={{ ...fieldBox, display:"flex", alignItems:"center", gap:10, color:"var(--text-secondary)", fontSize:13, padding:"14px 12px" }}>
          🔒 This credential is confidential. Contact your admin.
        </div>
      ) : (<>
        <FieldRow label="USERNAME" value={cred.username} field={cred.username} copyKey="user" />
        {restrictedPw ? (
          <div style={fieldBox}>
            <div style={{ ...microLabel, marginBottom:4 }}>PASSWORD</div>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <code style={monoVal(true)}>••••••• Restricted</code>
              <span style={{ fontSize:11, color:"var(--warning)", fontWeight:600, flexShrink:0 }}>admin only</span>
            </div>
          </div>
        ) : (
          <FieldRow label="PASSWORD" value={showPw ? cred.password : "•".repeat(Math.min((cred.password||"").length, 16))}
            masked field={cred.password} copyKey="pass" showToggle />
        )}

        {hasVerify && (
          <div style={{ background:"var(--info-bg)", border:"1px solid rgba(96,165,250,0.12)", borderRadius:10, padding:"10px 12px", display:"flex", flexDirection:"column", gap:8 }}>
            <div style={{ ...microLabel, color:"var(--info)" }}>VERIFICATION</div>
            {[["📧","Email verification",cred.verifyEmail,"vEmail"],["💬","Text verification",cred.verifyText,"vText"],["🔐","Auth verification",cred.verifyAuth,"vAuth"]]
              .filter(([,,v])=>v).map(([icon,field,value,key])=>(
              <div key={key} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8 }}>
                <code style={monoVal(false)}>{icon} {value}</code>
                {hasAccess && (
                  <button onClick={()=>handleCopyVerify(value, field, key)} disabled={lockedByTime} style={{ ...iconBtn(copied===key, lockedByTime), ...(copied===key?{ animation:"ercBounce 0.3s" }:{}) }}>{copied===key?"✓":"📋"}</button>
                )}
              </div>
            ))}
          </div>
        )}
      </>)}

      {/* Flexible spacer — absorbs slack so the footer cluster always pins to the bottom
          and action buttons line up across every card in a row, regardless of field count. */}
      <div style={{ flex:"1 1 auto" }} />

      {/* Footer */}
      <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
        {cred.teams==="all"
          ? <span style={{ background:"var(--success-bg)", color:"var(--success)", border:"1px solid rgba(16,185,129,0.3)", borderRadius:20, padding:"2px 8px", fontSize:11, fontWeight:600 }}>All Teams</span>
          : (cred.teams||[]).map(t=><TeamBadge key={t} team={t} small />)}
      </div>

      <div style={{ display:"flex", alignItems:"center", gap:6, fontSize:12, flexWrap:"wrap" }}>
        <span style={{ width:8, height:8, borderRadius:"50%", background:ageColor, display:"inline-block" }}/>
        <span style={{ color:ageColor, fontWeight:600 }}>{age}d old</span>
        <span style={{ color:"var(--text-muted)" }}>·</span>
        <span style={{ color:daysLeft<=0?"var(--danger)":daysLeft<=7?"var(--warning)":"var(--text-muted)" }}>{daysLeft<=0 ? "Expired" : daysLeft+"d until expiry"}</span>
      </div>

      <div style={{ fontSize:11, color:"var(--text-muted)", borderTop:"1px solid var(--border-subtle)", paddingTop:8 }}>
        Added {timeAgo(cred.addedAt)} by {cred.addedBy}
      </div>

      {/* Status actions (any user with access) */}
      {hasAccess && (
        <div style={{ position:"relative", display:"flex", gap:6, flexWrap:"wrap", borderTop:"1px solid var(--border-subtle)", paddingTop:8 }}>
          {!inUse ? (
            <button onClick={()=>{ setNote(""); setPopover(p=>p==="inuse"?null:"inuse"); }} className="erc-ghost" style={{ ...S.btn("ghost"), padding:"5px 10px", fontSize:12 }}>🟠 Mark In Use</button>
          ) : (iTagged || isAdmin) ? (
            <button onClick={()=>onReleaseInUse(cred)} style={{ ...S.btn("ghost"), padding:"5px 10px", fontSize:12, color:"#fb923c", borderColor:"rgba(249,115,22,0.4)" }}>{(inUseStale&&isAdmin&&!iTagged)?"Force Release":"Release"}</button>
          ) : (
            <span title={`${cred.inUseBy} has marked this as in use since ${timeAgo(cred.inUseSince)}`} style={{ ...S.btn("ghost"), padding:"5px 10px", fontSize:12, opacity:0.55, cursor:"not-allowed" }}>⚠️ In Use</span>
          )}
          {!notWorking ? (
            <button onClick={()=>{ setNote(""); setPopover(p=>p==="report"?null:"report"); }} className="erc-ghost" style={{ ...S.btn("ghost"), padding:"5px 10px", fontSize:12 }}>⚠️ Report Issue</button>
          ) : isAdmin ? (
            <button onClick={()=>{ setNote(""); setPopover(p=>p==="resolve"?null:"resolve"); }} className="erc-prim" style={{ ...S.btn("primary"), padding:"5px 10px", fontSize:12 }}>✓ Resolved</button>
          ) : iReported ? (
            <button onClick={()=>{ setNote(cred.notWorkingNote||""); setPopover(p=>p==="report"?null:"report"); }} style={{ ...S.btn("ghost"), padding:"5px 10px", fontSize:12 }}>View Report</button>
          ) : (
            <span style={{ background:"var(--danger-bg)", color:"#fca5a5", border:"1px solid rgba(239,68,68,0.3)", borderRadius:8, padding:"5px 10px", fontSize:12, fontWeight:600 }}>⚠️ Issue Reported</span>
          )}
          {popover && (
            <StatusPopover kind={popover} note={note} setNote={setNote} onClose={()=>setPopover(null)}
              onConfirm={async ()=>{
                if (popover==="inuse") await onMarkInUse(cred, note);
                else if (popover==="report") await onReportIssue(cred, note);
                else if (popover==="resolve") await onResolveIssue(cred, note);
                setPopover(null);
              }} />
          )}
        </div>
      )}
      {/* Admin controls */}
      {isAdmin && (
        <div style={{ display:"flex", gap:6, flexWrap:"wrap", borderTop:"1px solid var(--border-subtle)", paddingTop:8 }}>
          <button onClick={()=>onEdit(cred)} className="erc-ghost" style={{ ...S.btn("ghost"), padding:"5px 10px", fontSize:12 }}>✏️ Edit</button>
          <button onClick={()=>onDelete(cred)} style={{ ...S.btn("danger"), padding:"5px 10px", fontSize:12 }}>🗑️ Delete</button>
          {cred.timeRestriction && cred.timeRestriction.enabled && (
            <button onClick={()=>onPatch(cred.id,{ timeRestriction:null })} className="erc-ghost"
              style={{ ...S.btn("ghost"), padding:"5px 10px", fontSize:12, color:"#fca5a5" }}>⏱️ Clear restriction</button>
          )}
        </div>
      )}

      {!hasAccess && session.team!=="admin" && (
        <div style={{ borderTop:"1px solid var(--border-subtle)", paddingTop:8 }}>
          {pendingReq
            ? <span style={{ background:"var(--warning-bg)", color:"#fcd34d", border:"1px solid rgba(245,158,11,0.3)", borderRadius:20, padding:"4px 12px", fontSize:12, fontWeight:600 }}>Request Pending</span>
            : <button onClick={()=>onRequestAccess(cred)} className="erc-ghost" style={{ ...S.btn("ghost"), fontSize:12, color:"var(--info)", borderColor:"rgba(96,165,250,0.3)" }}>🔑 Request Access</button>}
        </div>
      )}
    </div>
  );
}

// ─── Credential row (List density) — one credential per row, aligned columns ──
const LIST_COLS = "minmax(170px,1.5fr) minmax(120px,1fr) minmax(130px,1.1fr) minmax(90px,auto) auto";
function CredentialRow({ cred, session, clientsById, onEdit, onDelete, onCopy, onFavToggle, isFav,
  requests, onRequestAccess, toast, onMarkInUse, onReleaseInUse, onReportIssue, onResolveIssue }) {
  const [showPw, setShowPw] = useState(false);
  const [copied, setCopied] = useState(null);
  const [popover, setPopover] = useState(null);
  const [note, setNote] = useState("");
  const hasAccess = canAccess(cred, session.team);
  const isAdmin = session.team === "admin";
  const myClients = resolveClients(cred, clientsById);
  const privilege = highestPrivilege(myClients);
  const confidentialBlock = privilege === "confidential" && !isAdmin;
  const restrictedPw = privilege === "restricted" && !isAdmin;
  const isAllClients = (cred.clientIds||[]).includes("all");
  const inUse = !!cred.inUse, notWorking = !!cred.notWorking;
  const inUseStale = inUse && hoursSince(cred.inUseSince) >= 8;
  const iTagged = inUse && cred.inUseByUserId === session.userId;
  const iReported = notWorking && cred.notWorkingReportedById === session.userId;
  const tr = evalTimeRestriction(cred.timeRestriction);
  const lockedByTime = tr.state === "expired";
  const age = daysSince(cred.updatedAt);
  const pendingReq = requests.find(r => r.credentialId===cred.id && r.requesterId===session.userId && r.status==="pending");
  const flash = (k)=>{ setCopied(k); setTimeout(()=>setCopied(c=>c===k?null:c),1500); };
  const copy = (val,label,key)=>{ if(!hasAccess||lockedByTime) return; navigator.clipboard.writeText(val).then(()=>{ onCopy&&onCopy(cred,label); flash(key); toast&&toast(label+" copied!","success"); }); };
  const leftAccent = notWorking ? "#ef4444" : inUseStale ? "#f59e0b" : inUse ? "#f97316" : lockedByTime ? "var(--danger)" : "transparent";
  const ghost = { ...S.btn("ghost"), padding:"5px 9px", fontSize:12 };
  return (
    <div className="erc-card" style={{ ...glass, borderRadius:12, padding:"0", position:"relative", zIndex: popover?50:undefined,
      display:"grid", gridTemplateColumns:LIST_COLS, alignItems:"center", gap:12, minHeight:56,
      paddingLeft:14, paddingRight:14, borderLeft:"3px solid "+leftAccent,
      background: (inUse||notWorking) ? "linear-gradient(135deg, "+(notWorking?"rgba(239,68,68,0.06)":"rgba(249,115,22,0.05)")+" 0%, var(--surface-grad-2) 60%)" : undefined }}>
      {/* Col 1 — portal + client + status dots + fav */}
      <div style={{ display:"flex", alignItems:"center", gap:8, minWidth:0, padding:"10px 0" }}>
        <button onClick={()=>onFavToggle(cred.id)} style={{ background:"none", border:"none", cursor:"pointer", fontSize:16, color:isFav?"var(--gold-bright)":"var(--text-muted)", padding:0, flexShrink:0 }}>★</button>
        <span style={{ minWidth:0 }}>
          <span style={{ display:"flex", alignItems:"center", gap:6 }}>
            <span style={{ fontWeight:700, fontSize:14, color:"var(--text-primary)", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{cred.portal}</span>
            {inUse && <span title="In use" style={{ width:8, height:8, borderRadius:"50%", background:"#f97316", flexShrink:0 }} />}
            {notWorking && <span title="Not working" style={{ width:8, height:8, borderRadius:"50%", background:"#ef4444", flexShrink:0 }} />}
          </span>
          <span style={{ fontSize:11, color:"var(--text-muted)", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", display:"block" }}>
            {isAllClients ? "🌐 All Clients" : (cred.clientNames||[]).join(", ") || "—"}
          </span>
        </span>
      </div>
      {/* Col 2 — username */}
      <div style={{ display:"flex", alignItems:"center", gap:6, minWidth:0 }}>
        {hasAccess ? (<>
          <code style={{ fontFamily:"var(--font-mono)", fontSize:12, color:"var(--text-secondary)", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{cred.username}</code>
          <button onClick={()=>copy(cred.username,"Username","u")} disabled={lockedByTime} style={{ ...iconBtn(copied==="u",lockedByTime), width:26, height:26, fontSize:11 }}>{copied==="u"?"✓":"📋"}</button>
        </>) : <span style={{ fontSize:12, color:"var(--text-muted)" }}>No access</span>}
      </div>
      {/* Col 3 — password */}
      <div style={{ display:"flex", alignItems:"center", gap:6, minWidth:0 }}>
        {confidentialBlock ? <span style={{ fontSize:12, color:"var(--text-muted)" }}>🔒 Confidential</span>
          : restrictedPw ? <span style={{ fontSize:12, color:"var(--warning)" }}>••••• admin only</span>
          : hasAccess ? (<>
            <code style={{ fontFamily:"var(--font-mono)", fontSize:12, color:"var(--text-secondary)", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{showPw?cred.password:"•".repeat(Math.min((cred.password||"").length,12))}</code>
            <button onClick={()=>setShowPw(p=>!p)} disabled={lockedByTime} style={{ ...iconBtn(false,lockedByTime), width:26, height:26, fontSize:11 }}>{showPw?"🙈":"👁"}</button>
            <button onClick={()=>copy(cred.password,"Password","p")} disabled={lockedByTime} style={{ ...iconBtn(copied==="p",lockedByTime), width:26, height:26, fontSize:11 }}>{copied==="p"?"✓":"📋"}</button>
          </>) : <span style={{ fontSize:12, color:"var(--text-muted)" }}>—</span>}
      </div>
      {/* Col 4 — status */}
      <div style={{ fontSize:11, color:"var(--text-muted)", whiteSpace:"nowrap" }}>
        {notWorking ? <span style={{ color:"#f87171", fontWeight:600 }}>❌ Not working</span>
          : inUse ? <span style={{ color:inUseStale?"#fcd34d":"#fdba74", fontWeight:600 }}>🟠 {cred.inUseBy}</span>
          : tr.state==="active" ? <span style={{ color:"var(--success)", fontWeight:600 }}>🟢 Active</span>
          : lockedByTime ? <span style={{ color:"var(--danger)", fontWeight:600 }}>🔴 Restricted</span>
          : <span>{age}d old</span>}
      </div>
      {/* Col 5 — actions */}
      <div style={{ position:"relative", display:"flex", alignItems:"center", gap:6, justifyContent:"flex-end", flexWrap:"wrap", padding:"8px 0" }}>
        {hasAccess && (!inUse
          ? <button onClick={()=>{ setNote(""); setPopover(p=>p==="inuse"?null:"inuse"); }} className="erc-ghost" style={ghost} title="Mark In Use">🟠</button>
          : (iTagged||isAdmin)
            ? <button onClick={()=>onReleaseInUse(cred)} style={{ ...ghost, color:"#fb923c", borderColor:"rgba(249,115,22,0.4)" }} title="Release">Release</button>
            : null)}
        {hasAccess && (!notWorking
          ? <button onClick={()=>{ setNote(""); setPopover(p=>p==="report"?null:"report"); }} className="erc-ghost" style={ghost} title="Report Issue">⚠️</button>
          : isAdmin
            ? <button onClick={()=>{ setNote(""); setPopover(p=>p==="resolve"?null:"resolve"); }} className="erc-prim" style={{ ...S.btn("primary"), padding:"5px 9px", fontSize:12 }} title="Mark Resolved">✓</button>
            : iReported
              ? <button onClick={()=>{ setNote(cred.notWorkingNote||""); setPopover(p=>p==="report"?null:"report"); }} style={ghost} title="Update note">Note</button>
              : null)}
        {isAdmin && <button onClick={()=>onEdit(cred)} className="erc-ghost" style={ghost} title="Edit">✏️</button>}
        {isAdmin && <button onClick={()=>onDelete(cred)} style={{ ...S.btn("danger"), padding:"5px 9px", fontSize:12 }} title="Delete">🗑️</button>}
        {!hasAccess && !isAdmin && (pendingReq
          ? <span style={{ fontSize:11, color:"#fcd34d" }}>Pending</span>
          : <button onClick={()=>onRequestAccess(cred)} className="erc-ghost" style={{ ...ghost, color:"var(--info)", borderColor:"rgba(96,165,250,0.3)" }}>🔑 Request</button>)}
        {popover && (
          <StatusPopover kind={popover} note={note} setNote={setNote} onClose={()=>setPopover(null)} anchorStyle={{ left:"auto", right:0 }}
            onConfirm={async ()=>{ if(popover==="inuse") await onMarkInUse(cred,note); else if(popover==="report") await onReportIssue(cred,note); else if(popover==="resolve") await onResolveIssue(cred,note); setPopover(null); }} />
        )}
      </div>
    </div>
  );
}

// ─── Collapsible section header (modal) ──────────────────────────────────────
function CollapseHead({ open, onClick, children }) {
  return (
    <button type="button" onClick={onClick} className="erc-pill"
      style={{ width:"100%", display:"flex", alignItems:"center", justifyContent:"space-between",
        background:"transparent", border:"1px dashed var(--border-default)", borderRadius:10, padding:"12px",
        cursor:"pointer", fontSize:13, fontWeight:600, color:"var(--text-secondary)" }}>
      <span>{children}</span>
      <span style={{ transform:open?"rotate(180deg)":"none", transition:"transform .2s" }}>⌄</span>
    </button>
  );
}

// ─── Searchable client select ────────────────────────────────────────────────
const dropdownPanel = { position:"absolute", top:"calc(100% + 6px)", left:0, zIndex:50, background:"var(--bg-elevated)",
  border:"1px solid var(--border-default)", borderRadius:12, boxShadow:"0 8px 32px rgba(0,0,0,0.4)", padding:8, minWidth:240, maxHeight:280, overflowY:"auto" };

function ClientSelect({ clients, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, []);
  const sel = clients.find(c=>c.id===value);
  const filtered = clients.filter(c=>!q || c.name.toLowerCase().includes(q.toLowerCase()) || (c.code||"").toLowerCase().includes(q.toLowerCase()));
  return (
    <div ref={ref} style={{ position:"relative" }}>
      <button type="button" onClick={()=>setOpen(o=>!o)}
        style={{ ...S.input(), display:"flex", alignItems:"center", justifyContent:"space-between", cursor:"pointer", textAlign:"left" }}>
        {sel
          ? <span style={{ display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ width:10, height:10, borderRadius:"50%", background:sel.color, flexShrink:0 }} />
              <span style={{ color:"var(--text-primary)" }}>{sel.name} <span style={{ color:"var(--text-muted)" }}>({sel.code})</span></span>
            </span>
          : <span style={{ color:"var(--text-muted)" }}>Select a client…</span>}
        <span style={{ color:"var(--text-muted)" }}>▾</span>
      </button>
      {open && (
        <div style={{ ...dropdownPanel, right:0 }}>
          <input autoFocus value={q} onChange={e=>setQ(e.target.value)} placeholder="Search clients..." style={{ ...S.input(), marginBottom:6, padding:"8px 10px" }} />
          <div style={{ maxHeight:220, overflowY:"auto" }}>
            {filtered.length===0
              ? <div style={{ padding:10, color:"var(--text-muted)", fontSize:13 }}>No active clients — create one in the Clients tab.</div>
              : filtered.map(c=>(
                <button key={c.id} type="button" onClick={()=>{ onChange(c.id); setOpen(false); setQ(""); }}
                  style={{ width:"100%", display:"flex", alignItems:"center", gap:8, padding:"8px 10px", borderRadius:8, cursor:"pointer",
                    border:"none", textAlign:"left", color:"var(--text-primary)", fontSize:13, background:c.id===value?"var(--bg-highlight)":"transparent" }}>
                  <span style={{ width:10, height:10, borderRadius:"50%", background:c.color, flexShrink:0 }} />
                  <span style={{ flex:1 }}>{c.name} <span style={{ color:"var(--text-muted)" }}>({c.code})</span></span>
                  <span style={{ fontSize:10, color:PRIVILEGE_META[c.privilegeLevel].color, fontWeight:700 }}>{PRIVILEGE_META[c.privilegeLevel].label}</span>
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Dark checkbox ────────────────────────────────────────────────────────────
function DarkCheck({ on }) {
  return (
    <span style={{ width:16, height:16, borderRadius:4, flexShrink:0, display:"inline-flex", alignItems:"center", justifyContent:"center",
      border:"1px solid "+(on?"var(--gold-bright)":"var(--border-strong)"), background:on?"var(--gold-bright)":"transparent", transition:"all .15s ease" }}>
      {on && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#03070f" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7"/></svg>}
    </span>
  );
}

// ─── Portal multi-select filter ───────────────────────────────────────────────
function PortalFilter({ portals, creds, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, []);
  const count = (p) => creds.filter(c=>c.portal===p).length;
  const filtered = portals.filter(p=>!q||p.toLowerCase().includes(q.toLowerCase()));
  const active = selected.length>0;
  const toggle = (p) => onChange(selected.includes(p)?selected.filter(x=>x!==p):[...selected,p]);
  const label = !active ? "Portal" : (selected.length<=2 ? "Portal: "+selected.join(", ") : `Portal: ${selected.slice(0,2).join(", ")} +${selected.length-2}`);
  return (
    <div ref={ref} style={{ position:"relative" }}>
      <button type="button" onClick={()=>setOpen(o=>!o)}
        style={{ display:"inline-flex", alignItems:"center", gap:8, padding:"8px 14px", fontSize:13, borderRadius:10, cursor:"pointer", fontWeight:600,
          border:"1px solid "+(active?"var(--gold-bright)":"var(--border-default)"), background:active?"var(--gold-dim)":"rgba(255,255,255,0.05)",
          color:active?"var(--gold-bright)":"var(--text-secondary)", maxWidth:260, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
        <span style={{ overflow:"hidden", textOverflow:"ellipsis" }}>{label}</span>
        {active && <span onClick={(e)=>{ e.stopPropagation(); onChange([]); }} style={{ cursor:"pointer" }}>×</span>}
        <span>▾</span>
      </button>
      {open && (
        <div style={dropdownPanel}>
          <input autoFocus value={q} onChange={e=>setQ(e.target.value)} placeholder="Search portals..." style={{ ...S.input(), marginBottom:6, padding:"8px 10px" }} />
          <div style={{ display:"flex", gap:10, padding:"2px 6px 8px", fontSize:12 }}>
            <button type="button" onClick={()=>onChange([...new Set([...selected,...filtered])])} style={{ background:"none", border:"none", color:"var(--gold-bright)", cursor:"pointer" }}>Select all</button>
            <button type="button" onClick={()=>onChange([])} style={{ background:"none", border:"none", color:"var(--text-muted)", cursor:"pointer" }}>Clear</button>
          </div>
          <div style={{ maxHeight:200, overflowY:"auto" }}>
            {filtered.length===0 ? <div style={{ padding:10, color:"var(--text-muted)", fontSize:13 }}>No portals</div>
              : filtered.map(p=>{ const on=selected.includes(p);
                return (
                  <button key={p} type="button" onClick={()=>toggle(p)}
                    style={{ width:"100%", display:"flex", alignItems:"center", gap:10, padding:"7px 10px", borderRadius:8, cursor:"pointer", border:"none",
                      textAlign:"left", color:"var(--text-primary)", fontSize:13, background: on?"var(--bg-highlight)":"transparent" }}>
                    <DarkCheck on={on} />
                    <span style={{ flex:1 }}>{p}</span>
                    <span style={{ fontSize:11, color:"var(--text-muted)", background:"rgba(255,255,255,0.05)", borderRadius:20, padding:"1px 7px" }}>{count(p)}</span>
                  </button>
                ); })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Credential Modal ─────────────────────────────────────────────────────────
function CredModal({ cred, onSave, onClose, session, clients }) {
  const [form, setForm] = useState(cred
    ? { verifyEmail:"", verifyText:"", verifyAuth:"", timeRestriction:null, ...cred }
    : { portal:"", url:"", username:"", password:"", clientIds:[], clientNames:[],
        teams:[], passwordExpiryDays:90, needsRotation:false, rotationNote:"",
        authMethod:"None", authLocation:"",
        verifyEmail:"", verifyText:"", verifyAuth:"", timeRestriction:null });
  const [teamsAll, setTeamsAll] = useState(!!(cred && cred.teams==="all"));
  const [selTeams, setSelTeams] = useState(cred && Array.isArray(cred.teams) ? cred.teams : []);
  const [clientsAll, setClientsAll] = useState(!!(cred && Array.isArray(cred.clientIds) && cred.clientIds.includes("all")));
  const [selClients, setSelClients] = useState(cred && Array.isArray(cred.clientIds) && !cred.clientIds.includes("all") ? cred.clientIds : []);
  const [triedSave, setTriedSave] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const isAdmin = session && session.team === "admin";
  const history = (cred && cred.notWorkingHistory) || [];
  const [busy, setBusy] = useState(false);
  const [showVerify, setShowVerify] = useState(!!(cred && (cred.verifyEmail || cred.verifyText || cred.verifyAuth)));
  const [showTime, setShowTime] = useState(!!(cred && cred.timeRestriction && cred.timeRestriction.enabled));
  const set = (k,v) => setForm(p=>({...p,[k]:v}));
  const toggleTeam = t => setSelTeams(p => p.includes(t)?p.filter(x=>x!==t):[...p,t]);
  const ctx = useDepts();
  const deptIds = ctx ? ctx.deptIds : DEFAULT_DEPTS.map(d=>d.id);
  const activeClients = (clients||[]).filter(c=>c.active);

  const tr = form.timeRestriction;
  const trEnabled = !!(tr && tr.enabled);
  const setTR = (patch) => setForm(p => ({ ...p, timeRestriction: { ...(p.timeRestriction||{}), ...patch } }));
  const enableTR = (on) => setForm(p => {
    if (!on) return { ...p, timeRestriction: p.timeRestriction ? { ...p.timeRestriction, enabled:false } : null };
    const e = p.timeRestriction || {};
    return { ...p, timeRestriction: {
      enabled:true, type:e.type||"window",
      windowDays:e.windowDays||["Mon","Tue","Wed","Thu","Fri"],
      windowStart:e.windowStart||"09:00", windowEnd:e.windowEnd||"18:00", timezone:e.timezone||"local",
      expiryDate:e.expiryDate||"", expiresAt:e.expiresAt||"", note:e.note||"",
    }};
  });
  const toggleTRDay = (d) => setForm(p => {
    const cur = (p.timeRestriction&&p.timeRestriction.windowDays)||[];
    return { ...p, timeRestriction:{ ...(p.timeRestriction||{}), windowDays: cur.includes(d)?cur.filter(x=>x!==d):[...cur,d] } };
  });

  const noClient = !clientsAll && selClients.length===0;
  const onClientPill = (id) => {
    if (clientsAll) { setClientsAll(false); setSelClients([id]); }
    else setSelClients(p => p.includes(id) ? p.filter(x=>x!==id) : [...p, id]);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setTriedSave(true);
    if (!form.portal.trim()||!form.username.trim()||!form.password.trim()||noClient) return;
    setBusy(true);
    try {
      const timeRestriction = (form.timeRestriction && form.timeRestriction.enabled) ? form.timeRestriction : null;
      const clientIds = clientsAll ? ["all"] : selClients;
      const clientNames = clientsAll ? ["All Clients"] : selClients.map(id => { const c=activeClients.find(x=>x.id===id); return c?c.name:id; });
      await onSave({ ...form, clientIds, clientNames, teams: teamsAll ? "all" : selTeams, timeRestriction });
    } finally { setBusy(false); }
  };

  const dayBtn = (on) => ({ padding:"5px 10px", borderRadius:8, fontSize:12, cursor:"pointer", fontWeight:600,
    border:"1px solid "+(on?"var(--info)":"var(--border-default)"), background:on?"var(--info-bg)":"rgba(0,0,0,0.3)", color:on?"var(--info)":"var(--text-secondary)" });

  return (
    <div style={S.overlay} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ ...S.modal(), padding:28, width:"90%", maxWidth:540, maxHeight:"85vh", overflowY:"auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <h3 style={{ fontWeight:700, fontSize:18, color:"var(--text-primary)" }}>{cred?"Edit Credential":"Add Credential"}</h3>
          <button onClick={onClose} className="erc-ghost" style={{ ...S.btn("ghost"), padding:"6px 10px" }}>✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          {[["Portal Name","portal",true],["URL","url",false],["Username","username",true]].map(([lbl,key,req])=>(
            <div key={key} style={{ marginBottom:14 }}>
              <label style={S.label}>{lbl}</label>
              <input value={form[key]||""} onChange={e=>set(key,e.target.value)} style={S.input()} required={req} />
            </div>
          ))}
          <div style={{ marginBottom:14 }}>
            <label style={S.label}>Password</label>
            <input value={form.password||""} onChange={e=>set("password",e.target.value)} style={S.input()} required />
            <StrengthBar password={form.password} />
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={S.label}>Client</label>
            <label style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8, cursor:"pointer", fontSize:13, color:"var(--text-secondary)" }}>
              <input type="checkbox" checked={clientsAll} onChange={e=>{ setClientsAll(e.target.checked); if(e.target.checked) setSelClients([]); }} /> 🌐 All Clients
            </label>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
              {activeClients.map(c=>{ const on = clientsAll || selClients.includes(c.id);
                return (
                  <button key={c.id} type="button" onClick={()=>onClientPill(c.id)}
                    style={{ display:"inline-flex", alignItems:"center", gap:6, padding:"5px 12px", borderRadius:20, fontSize:12, cursor:"pointer", fontWeight:600,
                      border:"1px solid "+(on?c.color:"var(--border-default)"), background:on?hexA(c.color,0.15):"rgba(0,0,0,0.3)", color:on?c.color:"var(--text-secondary)", opacity:clientsAll?0.7:1 }}>
                    <span style={{ width:8, height:8, borderRadius:"50%", background:c.color }} />{c.name} <span style={{ opacity:0.7, fontFamily:"var(--font-mono)", fontSize:11 }}>({c.code})</span>
                  </button>
                ); })}
            </div>
            {activeClients.length===0 && <p style={{ fontSize:12, color:"var(--text-muted)", margin:"6px 0 0" }}>No active clients — create one in the Clients tab.</p>}
            {triedSave && noClient && <p style={{ fontSize:12, color:"var(--warning)", margin:"6px 0 0" }}>⚠️ Select at least one client</p>}
          </div>

          <div style={{ marginBottom:14 }}>
            <CollapseHead open={showVerify} onClick={()=>setShowVerify(v=>!v)}>＋ Add verification info</CollapseHead>
            {showVerify && (
              <div style={{ padding:"14px 2px 2px", display:"flex", flexDirection:"column", gap:12, animation:"ercSlideDown 0.2s ease" }}>
                {[["📧 Email verification","verifyEmail","e.g. admin@company.com inbox"],
                  ["💬 Text verification","verifyText","e.g. +1 (555) 000-0000"],
                  ["🔐 Auth verification","verifyAuth","e.g. Google Authenticator – Work profile"]].map(([lbl,key,ph])=>(
                  <div key={key}>
                    <label style={S.label}>{lbl}</label>
                    <input value={form[key]||""} onChange={e=>set(key,e.target.value)} style={S.input()} placeholder={ph} />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ marginBottom:14 }}>
            <CollapseHead open={showTime} onClick={()=>setShowTime(v=>!v)}>⏰ Time Restriction</CollapseHead>
            {showTime && (
              <div style={{ padding:"14px 2px 2px", animation:"ercSlideDown 0.2s ease" }}>
                <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", fontSize:13, color:"var(--text-secondary)", marginBottom:trEnabled?12:0 }}>
                  <input type="checkbox" checked={trEnabled} onChange={e=>enableTR(e.target.checked)} /> Restrict usage to specific times
                </label>
                {trEnabled && (<>
                  <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:12 }}>
                    {[["window","Time Window"],["expiry","Expiry Date"],["schedule","Schedule Note"]].map(([val,lbl])=>(
                      <button key={val} type="button" onClick={()=>setTR({ type:val })}
                        style={{ ...S.btn(tr.type===val?"primary":"ghost"), padding:"6px 12px", fontSize:12 }}>{tr.type===val?"● ":"○ "}{lbl}</button>
                    ))}
                  </div>
                  {tr.type==="window" && (
                    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                      <div>
                        <label style={S.label}>Days</label>
                        <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                          {ALL_DAYS.map(d=>{ const on=(tr.windowDays||[]).includes(d);
                            return <button key={d} type="button" onClick={()=>toggleTRDay(d)} style={dayBtn(on)}>{d}</button>; })}
                        </div>
                      </div>
                      <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
                        <div style={{ flex:1, minWidth:120 }}><label style={S.label}>Start</label>
                          <input type="time" value={tr.windowStart||"09:00"} onChange={e=>setTR({ windowStart:e.target.value })} style={S.input()} /></div>
                        <div style={{ flex:1, minWidth:120 }}><label style={S.label}>End</label>
                          <input type="time" value={tr.windowEnd||"18:00"} onChange={e=>setTR({ windowEnd:e.target.value })} style={S.input()} /></div>
                      </div>
                      <div>
                        <label style={S.label}>Timezone</label>
                        <div style={{ display:"flex", gap:6 }}>
                          {["local","UTC"].map(tz=>(
                            <button key={tz} type="button" onClick={()=>setTR({ timezone:tz })}
                              style={{ ...S.btn(tr.timezone===tz?"primary":"ghost"), padding:"6px 14px", fontSize:12 }}>{tz==="local"?"Local":"UTC"}</button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                  {tr.type==="expiry" && (
                    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                      <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
                        <div style={{ flex:1, minWidth:140 }}><label style={S.label}>Expiry date</label>
                          <input type="date" value={tr.expiryDate||""} onChange={e=>setTR({ expiryDate:e.target.value })} style={S.input()} /></div>
                        <div style={{ flex:1, minWidth:120 }}><label style={S.label}>Time (optional)</label>
                          <input type="time" value={tr.expiresAt||""} onChange={e=>setTR({ expiresAt:e.target.value })} style={S.input()} /></div>
                      </div>
                      <p style={{ fontSize:12, color:"var(--text-muted)", margin:0 }}>Card will appear locked after this date/time.</p>
                    </div>
                  )}
                  {tr.type==="schedule" && (
                    <div>
                      <label style={S.label}>Describe when this credential should be used</label>
                      <textarea value={tr.note||""} onChange={e=>setTR({ note:e.target.value })}
                        style={{ ...S.input(), resize:"vertical", minHeight:70 }} placeholder="Only during Q4 campaign — Oct to Dec" />
                    </div>
                  )}
                </>)}
              </div>
            )}
          </div>

          <div style={{ marginBottom:14 }}>
            <label style={S.label}>Team Access</label>
            <label style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8, cursor:"pointer", fontSize:13, color:"var(--text-secondary)" }}>
              <input type="checkbox" checked={teamsAll} onChange={e=>setTeamsAll(e.target.checked)} /> All Teams
            </label>
            {!teamsAll && (
              <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                {deptIds.map(t=>{ const on=selTeams.includes(t);
                  return (
                    <label key={t} style={{ display:"flex", alignItems:"center", gap:4, cursor:"pointer", padding:"5px 12px",
                      border:"1px solid "+(on?"var(--info)":"var(--border-default)"), borderRadius:20, fontSize:12, textTransform:"capitalize",
                      background:on?"var(--info-bg)":"rgba(0,0,0,0.3)", color:on?"var(--info)":"var(--text-secondary)" }}>
                      <input type="checkbox" checked={on} onChange={()=>toggleTeam(t)} style={{ display:"none" }} />{ctx?ctx.teamLabel(t):t}
                    </label>
                  ); })}
              </div>
            )}
          </div>
          <div style={{ marginBottom:20 }}>
            <label style={S.label}>Expiry Days</label>
            <select value={form.passwordExpiryDays||90} onChange={e=>set("passwordExpiryDays",+e.target.value)} style={S.input()}>
              {[30,60,90,180].map(d=><option key={d} value={d}>{d} days</option>)}
            </select>
          </div>

          {cred && isAdmin && (
            <div style={{ marginBottom:14 }}>
              <CollapseHead open={showHistory} onClick={()=>setShowHistory(v=>!v)}>🗂️ Issue History {history.length>0?`(${history.length})`:""}</CollapseHead>
              {showHistory && (
                <div style={{ padding:"14px 2px 2px", animation:"ercSlideDown 0.2s ease" }}>
                  {history.length===0
                    ? <p style={{ color:"var(--text-muted)", fontSize:13 }}>No issues reported for this credential.</p>
                    : <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                        {history.slice().reverse().map((h,i)=>(
                          <div key={i} style={{ display:"flex", gap:10 }}>
                            <span style={{ width:8, height:8, borderRadius:"50%", flexShrink:0, marginTop:5, background:h.resolved?"#10b981":"#ef4444" }} />
                            <div style={{ fontSize:12 }}>
                              <div style={{ color:"#fca5a5" }}>Reported by {h.reportedBy} · {fmtSmartTime(h.reportedAt)}</div>
                              {h.note && <div style={{ color:"var(--text-muted)", fontStyle:"italic" }}>{h.note}</div>}
                              {h.resolved && <div style={{ color:"#34d399", marginTop:2 }}>Resolved by {h.resolvedBy} · {fmtSmartTime(h.resolvedAt)}{h.resolveNote?` · ${h.resolveNote}`:""}</div>}
                            </div>
                          </div>
                        ))}
                      </div>}
                </div>
              )}
            </div>
          )}

          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <button type="button" onClick={onClose} className="erc-ghost" style={S.btn("ghost")}>Cancel</button>
            <button type="submit" disabled={busy} className="erc-prim" style={{ ...S.btn("primary"), opacity:busy?0.7:1 }}>{cred?"Save Changes":"Add Credential"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── User Modal ───────────────────────────────────────────────────────────────
function UserModal({ user, onSave, onClose }) {
  const ctx = useDepts();
  const deptList = ctx ? ctx.list : DEFAULT_DEPTS;
  const [form, setForm] = useState(user
    ? { name:user.name, username:user.username, team:user.team, password:"" }
    : { name:"", username:"", password:"", team:(deptList[0]&&deptList[0].id)||"engineering" });
  const [busy, setBusy] = useState(false);
  const [pulse, setPulse] = useState(0);
  const set = (k,v) => setForm(p=>({...p,[k]:v}));
  useEffect(()=>{ setPulse(p=>p+1); }, [form.name, form.team]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name||!form.username||(!user&&!form.password)) return;
    setBusy(true);
    try { await onSave(form); } finally { setBusy(false); }
  };
  const st = ctx ? ctx.teamStyle(form.team) : (TEAM_STYLES[form.team] || TEAM_STYLES.engineering);

  return (
    <div style={S.overlay} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ ...S.modal(), padding:28, width:"90%", maxWidth:460, maxHeight:"85vh", overflowY:"auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <h3 style={{ fontWeight:700, fontSize:18, color:"var(--text-primary)" }}>{user?"Edit User":"Add User"}</h3>
          <button onClick={onClose} className="erc-ghost" style={{ ...S.btn("ghost"), padding:"6px 10px" }}>✕</button>
        </div>
        <div style={{ display:"flex", justifyContent:"center", marginBottom:18 }}>
          <div key={pulse} style={{ width:56, height:56, borderRadius:"50%", background:st.bg, color:st.color, border:"2px solid "+st.border,
            display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, fontSize:18, animation:"ercPulse 0.2s ease" }}>
            {getInitials(form.name)||"?"}
          </div>
        </div>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom:14 }}>
            <label style={S.label}>Full Name</label>
            <input value={form.name} onChange={e=>set("name",e.target.value)} style={S.input()} required />
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={S.label}>Username {user && <span style={{ color:"var(--text-muted)", fontWeight:400, textTransform:"none", letterSpacing:0 }}>(can't change)</span>}</label>
            <input value={form.username} onChange={e=>set("username",e.target.value)} style={S.input({ opacity:user?0.6:1 })} required disabled={!!user} />
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={S.label}>{user?"New Password (blank = keep current)":"Password"}</label>
            <input type="password" value={form.password} onChange={e=>set("password",e.target.value)} style={S.input()} required={!user} />
            {form.password && <StrengthBar password={form.password} />}
          </div>
          <div style={{ marginBottom:20 }}>
            <label style={S.label}>Department</label>
            <select value={form.team} onChange={e=>set("team",e.target.value)} style={S.input()}>
              <option value="admin">Admin</option>
              {deptList.map(d=><option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
          </div>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <button type="button" onClick={onClose} className="erc-ghost" style={S.btn("ghost")}>Cancel</button>
            <button type="submit" disabled={busy} className="erc-prim" style={{ ...S.btn("primary"), opacity:busy?0.7:1 }}>{user?"Save Changes":"Add User"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Reset Password Modal ─────────────────────────────────────────────────────
function ResetPasswordModal({ user, onSubmit, onClose }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const handleSave = async () => {
    if (!pw) return;
    setBusy(true);
    try { await onSubmit(pw); onClose(); } finally { setBusy(false); }
  };
  return (
    <div style={S.overlay} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ ...S.modal(), padding:28, width:"90%", maxWidth:400 }}>
        <h3 style={{ fontWeight:700, marginBottom:16, color:"var(--text-primary)", fontSize:18 }}>Reset Password: {user.name}</h3>
        <label style={S.label}>New Password</label>
        <input type="password" value={pw} onChange={e=>setPw(e.target.value)} style={{ ...S.input(), marginBottom:8 }} autoFocus />
        <StrengthBar password={pw} />
        <div style={{ display:"flex", gap:10, justifyContent:"flex-end", marginTop:20 }}>
          <button onClick={onClose} className="erc-ghost" style={S.btn("ghost")}>Cancel</button>
          <button onClick={handleSave} disabled={busy} className="erc-prim" style={{ ...S.btn("primary"), opacity:busy?0.7:1 }}>Reset Password</button>
        </div>
      </div>
    </div>
  );
}

// ─── Request Access Modal ─────────────────────────────────────────────────────
function RequestAccessModal({ cred, session, onClose, toast, onDone }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const handleSubmit = async () => {
    setBusy(true);
    try {
      await createRequest({ requesterId:session.userId, requesterName:session.userName,
        requesterTeam:session.team, credentialId:cred.id, credentialName:cred.portal, message });
      logAudit({ userId:session.userId, userName:session.userName, action:"access_request",
        credentialId:cred.id, credentialName:cred.portal });
      toast("Access request submitted!","success");
      onDone && onDone();
      onClose();
    } catch (e) { toast(e.message,"error"); } finally { setBusy(false); }
  };
  return (
    <div style={S.overlay} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ ...S.modal(), padding:28, width:"90%", maxWidth:420 }}>
        <h3 style={{ fontWeight:700, marginBottom:8, color:"var(--text-primary)", fontSize:18 }}>Request Access</h3>
        <p style={{ color:"var(--text-secondary)", fontSize:14, marginBottom:16 }}>Requesting access to: <strong style={{ color:"var(--text-primary)" }}>{cred.portal}</strong></p>
        <label style={S.label}>Message (optional)</label>
        <textarea value={message} onChange={e=>setMessage(e.target.value)}
          style={{ ...S.input(), resize:"vertical", minHeight:80, marginBottom:16 }} placeholder="Why do you need access?" />
        <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
          <button onClick={onClose} className="erc-ghost" style={S.btn("ghost")}>Cancel</button>
          <button onClick={handleSubmit} disabled={busy} className="erc-prim" style={{ ...S.btn("primary"), opacity:busy?0.7:1 }}>Submit Request</button>
        </div>
      </div>
    </div>
  );
}

// ─── Import Preview Modal ─────────────────────────────────────────────────────
function ImportPreviewModal({ rows, existingCreds, clients, deptList, onConfirm, onClose }) {
  const activeClients = (clients||[]).filter(c=>c.active);
  const depts = deptList || DEFAULT_DEPTS;
  const teamKnown = {}; depts.forEach(d=>{ teamKnown[d.id.toLowerCase()]=1; teamKnown[d.label.toLowerCase()]=1; });
  const base = rows.map(r => {
    // Only these three block a row from importing.
    const errors = [];
    if (!r.Portal) errors.push("Missing Portal");
    if (!r.Username) errors.push("Missing Username");
    if (!r.Password) errors.push("Missing Password");

    // Everything below is a warning at most — never blocks import.
    const warnings = [];
    const clientRaw = String(r["Client Name"]||r.Client||r.Clients||"").trim();
    let clientDisplay = "None";
    if (!clientRaw) { warnings.push("No client assigned — will import without client tag"); }
    else if (clientRaw.toLowerCase()==="all") { clientDisplay = "All Clients"; }
    else {
      const parts = clientRaw.split(",").map(s=>s.trim()).filter(Boolean);
      const known = parts.filter(n=>activeClients.some(c=>c.name.toLowerCase()===n.toLowerCase()));
      const unknown = parts.filter(n=>!activeClients.some(c=>c.name.toLowerCase()===n.toLowerCase()));
      if (unknown.length) warnings.push(`Unknown client ${unknown.map(x=>`'${x}'`).join(", ")} — ${known.length?"others applied":"will import without client tag"}`);
      clientDisplay = known.length ? known.join(", ") : `Unknown: ${clientRaw}`;
    }

    const teamRaw = String(r.Teams||"").trim();
    if (teamRaw && teamRaw.toLowerCase()!=="all") {
      const unknownTeams = [];
      for (const seg of teamRaw.split(",").map(s=>s.trim()).filter(Boolean)) {
        if (teamKnown[seg.toLowerCase()]) continue;
        if (seg.split(/\s+/).some(t=>teamKnown[t.toLowerCase()])) continue;
        unknownTeams.push(seg);
      }
      if (unknownTeams.length) warnings.push(`Unknown team ${unknownTeams.map(x=>`'${x}'`).join(", ")} — skipped`);
    }

    // duplicate = portal + username match (case-insensitive)
    const existing = existingCreds.find(c =>
      c.portal.toLowerCase()===String(r.Portal||"").toLowerCase() &&
      c.username.toLowerCase()===String(r.Username||"").toLowerCase());
    const status = errors.length>0 ? "error" : existing ? "duplicate" : warnings.length>0 ? "warning" : "valid";
    return { row:r, status, errors, warnings, existing, clientDisplay };
  });

  const [decisions, setDecisions] = useState({}); // index -> "overwrite" | "skip" (default skip)
  const [expanded, setExpanded] = useState({});
  const decOf = (i) => decisions[i] || "skip";
  const setDec = (i, v) => setDecisions(d=>({ ...d, [i]:v }));
  const setAllDup = (v) => { const d={}; base.forEach((b,i)=>{ if(b.status==="duplicate") d[i]=v; }); setDecisions(d); };

  const counts = {
    nw: base.filter(b=>b.status==="valid"||b.status==="warning").length,
    overwrite: base.filter((b,i)=>b.status==="duplicate" && decOf(i)==="overwrite").length,
    skip: base.filter((b,i)=>b.status==="duplicate" && decOf(i)==="skip").length,
    warnings: base.filter((b,i)=>(b.status==="warning") || (b.status==="duplicate" && decOf(i)==="overwrite" && b.warnings.length>0)).length,
    errors: base.filter(b=>b.status==="error").length,
  };
  const totalImport = counts.nw + counts.overwrite;

  const diffFields = (b) => {
    if (!b.existing) return [];
    const r=b.row, ex=b.existing;
    return [
      ["Password", ex.password, r.Password],
      ["URL", ex.url, r.URL],
      ["Client", (ex.clientNames||[]).join(", "), (r.Client||r["Client Name"]||r.Clients)],
      ["Teams", (ex.teams==="all"?"all":(ex.teams||[]).join(",")), r.Teams],
    ].filter(([,o,n]) => n!==undefined && String(o||"")!==String(n||""));
  };

  const pill = (c,label) => <span style={{ background:c+"22", color:c, border:"1px solid "+c+"55", borderRadius:20, padding:"3px 10px", fontSize:12, fontWeight:600 }}>{label}</span>;
  const td = { padding:"7px 10px", verticalAlign:"top" };
  const miniBtn = (active, color) => ({ padding:"3px 8px", fontSize:11, fontWeight:600, borderRadius:6, cursor:"pointer",
    border:"1px solid "+(active?(color||"var(--gold-bright)"):"var(--border-default)"),
    background:active?hexA(color||"#f5b800",0.15):"transparent", color:active?(color||"var(--gold-bright)"):"var(--text-muted)" });

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal(), padding:28, width:"95vw", maxWidth:820, maxHeight:"85vh", overflowY:"auto" }}>
        <h3 style={{ fontWeight:700, marginBottom:12, color:"var(--text-primary)", fontSize:18 }}>Import Preview</h3>
        <div style={{ display:"flex", gap:8, marginBottom:14, alignItems:"center", flexWrap:"wrap" }}>
          {pill("#10b981", `${counts.nw} new`)}{pill("#f5b800", `${counts.overwrite} overwrite`)}{pill("#f59e0b", `${counts.warnings} warnings`)}{pill("#94a3b8", `${counts.skip} skip`)}{pill("#ef4444", `${counts.errors} errors`)}
          {base.some(b=>b.status==="duplicate") && (
            <span style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:8, fontSize:12, color:"var(--text-muted)" }}>
              Duplicates:
              <button onClick={()=>setAllDup("overwrite")} style={miniBtn(false,"#f5b800")}>Overwrite All</button>
              <button onClick={()=>setAllDup("skip")} style={miniBtn(false)}>Skip All</button>
            </span>
          )}
        </div>
        <div style={{ maxHeight:360, overflowY:"auto", marginBottom:16, border:"1px solid var(--border-subtle)", borderRadius:12 }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
            <thead>
              <tr>{["Status","Portal","Username","Client","Teams","Notes"].map(h=>(
                <th key={h} style={{ background:"rgba(0,0,0,0.3)", padding:"10px", textAlign:"left", color:"var(--text-muted)",
                  borderBottom:"1px solid var(--border-default)", fontWeight:600, position:"sticky", top:0, textTransform:"uppercase", letterSpacing:1, fontSize:10 }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {base.map((b,i)=>{
                const r=b.row; const ov = b.status==="duplicate" && decOf(i)==="overwrite";
                const dot = b.status==="valid" ? "#10b981" : b.status==="warning" ? "#f59e0b" : b.status==="error" ? "#ef4444" : "#f5b800";
                const bg = b.status==="valid" ? "rgba(16,185,129,0.06)" : b.status==="warning" ? "rgba(245,158,11,0.06)"
                  : b.status==="error" ? "rgba(239,68,68,0.07)" : ov ? "rgba(245,184,0,0.10)" : "rgba(148,163,184,0.05)";
                const note = b.status==="error" ? b.errors.join(", ") : b.warnings.join(" · ");
                const Dot = () => <span style={{ display:"inline-block", width:8, height:8, borderRadius:"50%", background:dot, marginRight:7, flexShrink:0 }} />;
                return (
                  <React.Fragment key={i}>
                    <tr style={{ background:bg, color:"var(--text-secondary)", borderLeft: "2px solid "+(ov?"var(--gold-bright)":"transparent") }}>
                      <td style={{ ...td, minWidth:200 }}>
                        {b.status==="valid" && <span style={{ display:"flex", alignItems:"center", color:"var(--success)", fontWeight:600 }}><Dot/>Ready</span>}
                        {b.status==="warning" && <span style={{ display:"flex", alignItems:"center", color:"#fbbf24", fontWeight:600 }}><Dot/>Ready · warning</span>}
                        {b.status==="error" && <span style={{ display:"flex", alignItems:"center", color:"#fca5a5", fontWeight:600 }}><Dot/>Error</span>}
                        {b.status==="duplicate" && (
                          <span style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                            <button onClick={()=>setDec(i,"overwrite")} style={miniBtn(decOf(i)==="overwrite","#f5b800")}>Import &amp; Overwrite</button>
                            <button onClick={()=>setDec(i,"skip")} style={miniBtn(decOf(i)==="skip")}>Skip</button>
                            <button onClick={()=>setExpanded(e=>({...e,[i]:!e[i]}))} title="Show changes"
                              style={{ background:"none", border:"none", color:"var(--text-muted)", cursor:"pointer", fontSize:11 }}>{expanded[i]?"▲ diff":"▾ diff"}</button>
                          </span>
                        )}
                      </td>
                      <td style={td}>{r.Portal||<span style={{color:"#fca5a5"}}>—</span>}</td>
                      <td style={{ ...td, maxWidth:160, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }} title={r.Username}>{r.Username||<span style={{color:"#fca5a5"}}>—</span>}</td>
                      <td style={td}>{b.clientDisplay==="None"
                        ? <span style={{ color:"var(--text-muted)" }}>None</span>
                        : (b.clientDisplay||"").startsWith("Unknown:")
                          ? <span style={{ color:"#fbbf24" }}>{b.clientDisplay}</span>
                          : b.clientDisplay}</td>
                      <td style={td}>{String(r.Teams||"").trim()||<span style={{ color:"var(--text-muted)" }}>all</span>}</td>
                      <td style={{ ...td, color: b.status==="error"?"#fca5a5":"#fbbf24", fontSize:11, maxWidth:200 }}>{note||<span style={{ color:"var(--text-muted)" }}>—</span>}</td>
                    </tr>
                    {b.status==="duplicate" && expanded[i] && (
                      <tr style={{ background:"rgba(0,0,0,0.3)" }}>
                        <td colSpan={6} style={{ padding:"8px 14px" }}>
                          {diffFields(b).length===0
                            ? <span style={{ color:"var(--text-muted)", fontSize:12 }}>No field changes detected.</span>
                            : <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                                {diffFields(b).map(([f,o,n])=>(
                                  <div key={f} style={{ fontSize:12 }}>
                                    <span style={{ color:"var(--text-muted)" }}>{f}: </span>
                                    <span style={{ color:"#fca5a5", textDecoration:"line-through" }}>{f==="Password"?"••••":(o||"—")}</span>
                                    <span style={{ color:"var(--text-muted)" }}> → </span>
                                    <span style={{ color:"var(--success)" }}>{f==="Password"?"••••":(n||"—")}</span>
                                  </div>
                                ))}
                              </div>}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ display:"flex", gap:10, justifyContent:"flex-end", alignItems:"center" }}>
          <button onClick={onClose} className="erc-ghost" style={S.btn("ghost")}>Cancel</button>
          <button onClick={()=>onConfirm(base.map((b,i)=>({ ...b, decision: b.status==="duplicate"?decOf(i):null })))}
            disabled={totalImport===0} className="erc-prim" style={{ ...S.btn("primary"), opacity:totalImport===0?0.5:1 }}>
            Import {totalImport} credential{totalImport===1?"":"s"}{counts.overwrite>0?` (${counts.overwrite} will overwrite existing)`:""}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 2FA Setup ────────────────────────────────────────────────────────────────
function TwoFASetup({ user, onDone, toast }) {
  const [step, setStep] = useState(1);
  const [secret, setSecret] = useState(null);
  const [totpObj, setTotpObj] = useState(null);
  const [qrUrl, setQrUrl] = useState("");
  const [code, setCode] = useState("");

  useEffect(() => {
    const s = new OTPAuth.Secret();
    const t = new OTPAuth.TOTP({ issuer:"Eagle RCM", label:user.username, algorithm:"SHA1", digits:6, period:30, secret:s });
    setSecret(s); setTotpObj(t);
    QRCode.toDataURL(t.toString()).then(url=>setQrUrl(url));
  }, [user.username]);

  const handleVerify = async () => {
    if (!totpObj) return;
    if (totpObj.validate({ token:code.trim(), window:1 }) === null) { toast("Invalid code","error"); return; }
    try {
      await updateProfile(user.id, { twoFactorEnabled:true, twoFactorSecret:secret.base32 });
      toast("2FA enabled!","success");
      onDone({ ...user, twoFactorEnabled:true, twoFactorSecret:secret.base32 });
    } catch (e) { toast(e.message,"error"); }
  };

  return (
    <div>
      {step===1 && (
        <>
          <p style={{ fontSize:13, color:"var(--text-secondary)", marginBottom:12 }}>Scan with Authenticator (Google Authenticator, Authy…)</p>
          {qrUrl && <div style={{ background:"#fff", borderRadius:12, padding:10, display:"inline-block", marginBottom:12 }}><img src={qrUrl} alt="QR" style={{ display:"block", width:160, height:160 }} /></div>}
          <div style={{ ...fieldBox, marginBottom:12 }}>
            <div style={{ ...microLabel, marginBottom:4 }}>Manual key</div>
            <code style={{ fontSize:12, wordBreak:"break-all", fontFamily:"var(--font-mono)", color:"var(--text-primary)" }}>{secret?.base32}</code>
          </div>
          <button onClick={()=>setStep(2)} className="erc-prim" style={S.btn("primary")}>Next →</button>
        </>
      )}
      {step===2 && (
        <>
          <p style={{ fontSize:13, color:"var(--text-secondary)", marginBottom:12 }}>Enter the 6-digit code to verify setup.</p>
          <input value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,"").slice(0,6))}
            style={{ ...S.input(), textAlign:"center", fontSize:20, letterSpacing:6, marginBottom:12, fontFamily:"var(--font-mono)" }} placeholder="000000" maxLength={6} />
          <div style={{ display:"flex", gap:8 }}>
            <button onClick={()=>setStep(1)} className="erc-ghost" style={S.btn("ghost")}>Back</button>
            <button onClick={handleVerify} className="erc-prim" style={S.btn("primary")}>Verify & Enable</button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Collapsible drawer section ──────────────────────────────────────────────
function DrawerSection({ title, defaultOpen = true, accent, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderBottom:"1px solid var(--border-subtle)", marginBottom:16, paddingBottom:8 }}>
      <button onClick={()=>setOpen(o=>!o)} style={{ width:"100%", display:"flex", alignItems:"center", justifyContent:"space-between",
        background:"none", border:"none", cursor:"pointer", padding:"4px 0", marginBottom:open?12:0 }}>
        <span style={{ fontWeight:700, color:accent||"var(--text-primary)", fontSize:14 }}>{title}</span>
        <span style={{ color:"var(--text-muted)", transition:"transform .25s ease", transform:open?"rotate(180deg)":"rotate(0deg)" }}>⌄</span>
      </button>
      <div style={{ maxHeight: open ? 2000 : 0, overflow:"hidden", transition:"max-height 0.25s ease" }}>{children}</div>
    </div>
  );
}

// ─── Profile Drawer ──────────────────────────────────────────────────────────
function ProfilePanel({ session, currentUser, onClose, onUserUpdate, toast, copyHistory }) {
  const [section, setSection] = useState("main");
  const [cpForm, setCpForm] = useState({ current:"", newPw:"", confirm:"" });
  const [cpError, setCpError] = useState("");
  const [busy, setBusy] = useState(false);
  const [myRequests, setMyRequests] = useState([]);
  const dctx = useDepts();
  const st = dctx ? dctx.teamStyle(currentUser.team) : (TEAM_STYLES[currentUser.team] || TEAM_STYLES.engineering);

  useEffect(() => {
    listRequests().then(rs => setMyRequests(rs.filter(r=>r.requesterId===session.userId))).catch(()=>{});
  }, [session.userId]);

  const handleChangePw = async () => {
    setCpError("");
    if (cpForm.newPw!==cpForm.confirm) { setCpError("Passwords don't match."); return; }
    if (pwStrength(cpForm.newPw) < 3) { setCpError("New password is too weak."); return; }
    setBusy(true);
    try {
      const { error: vErr } = await supabase.auth.signInWithPassword({ email:usernameToEmail(currentUser.username), password:cpForm.current });
      if (vErr) { setCpError("Current password incorrect."); return; }
      const { error } = await supabase.auth.updateUser({ password:cpForm.newPw });
      if (error) { setCpError(error.message); return; }
      logAudit({ userId:session.userId, userName:session.userName, action:"password_changed" });
      toast("Password changed!","success");
      setCpForm({ current:"", newPw:"", confirm:"" });
    } finally { setBusy(false); }
  };

  const disable2FA = async () => {
    try {
      await updateProfile(currentUser.id, { twoFactorEnabled:false, twoFactorSecret:"" });
      onUserUpdate({ ...currentUser, twoFactorEnabled:false, twoFactorSecret:"" });
      toast("2FA disabled","info");
    } catch (e) { toast(e.message,"error"); }
  };

  const Divider = () => <div style={{ height:1, background:"var(--border-subtle)", margin:"4px 0 20px" }} />;
  const heading = { fontWeight:700, color:"var(--text-primary)", marginBottom:12, fontSize:14 };

  return (
    <div style={{ position:"fixed", right:0, top:0, bottom:0, width:380, background:"var(--bg-elevated)",
      borderLeft:"1px solid var(--border-default)", boxShadow:"-8px 0 40px rgba(0,0,0,0.5)", zIndex:500, overflowY:"auto",
      display:"flex", flexDirection:"column", animation:"ercDrawerIn 0.25s ease-out" }}>
      <div style={{ background:"linear-gradient(135deg,#0a0f1e,#1a2d4a)", padding:24, color:"#fff" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <span style={{ fontWeight:700, fontSize:16 }}>Profile</span>
          <button onClick={onClose} style={{ background:"none", border:"none", cursor:"pointer", color:"var(--text-secondary)", fontSize:20, padding:0 }}>✕</button>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          <div style={{ width:56, height:56, borderRadius:"50%", background:st.bg, color:st.color, border:"2px solid "+st.border,
            display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, fontSize:18 }}>{currentUser.avatar}</div>
          <div>
            <div style={{ fontWeight:700, fontSize:18 }}>{currentUser.name}</div>
            <div style={{ color:"var(--text-secondary)", fontSize:13 }}>@{currentUser.username}</div>
            <div style={{ marginTop:4 }}><TeamBadge team={currentUser.team} small /></div>
          </div>
        </div>
        <div style={{ marginTop:10, color:"var(--text-secondary)", fontSize:12 }}>Last login: {fmtDate(currentUser.lastLoginAt)}</div>
      </div>

      <div style={{ padding:20, flex:1 }}>
        <DrawerSection title="Change Password">
          {[["Current Password","current"],["New Password","newPw"],["Confirm New","confirm"]].map(([lbl,key])=>(
            <div key={key} style={{ marginBottom:10 }}>
              <label style={S.label}>{lbl}</label>
              <input type="password" value={cpForm[key]} onChange={e=>setCpForm(p=>({...p,[key]:e.target.value}))} style={S.input()} />
            </div>
          ))}
          {cpForm.newPw && <StrengthBar password={cpForm.newPw} />}
          {cpError && <p style={{ color:"#fca5a5", fontSize:13, marginTop:6 }}>{cpError}</p>}
          <button onClick={handleChangePw} disabled={busy} className="erc-prim" style={{ ...S.btn("primary"), marginTop:10, width:"100%", justifyContent:"center", opacity:busy?0.7:1 }}>Update Password</button>
        </DrawerSection>

        <DrawerSection title="📋 Session copy history" accent="var(--text-gold)">
          {copyHistory.length>0 ? copyHistory.map((item,i)=>(
            <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 12px",
              background:"rgba(0,0,0,0.25)", border:"1px solid var(--border-subtle)", borderRadius:8, marginBottom:6, fontSize:13 }}>
              <span style={{ color:"var(--text-primary)" }}><strong>{item.portal}</strong> <span style={{ color:"var(--text-muted)" }}>· {item.field}</span></span>
              <span style={{ color:"var(--text-muted)", fontSize:11 }}>{timeAgo(item.time)}</span>
            </div>
          )) : <p style={{ color:"var(--text-muted)", fontSize:13, fontStyle:"italic" }}>Nothing copied this session</p>}
        </DrawerSection>

        <DrawerSection title="Two-Factor Authentication">
          {currentUser.twoFactorEnabled ? (
            <div>
              <div style={{ color:"var(--success)", fontWeight:600, fontSize:13, marginBottom:10 }}>✓ Enabled</div>
              <button onClick={disable2FA} style={S.btn("danger")}>Disable 2FA</button>
            </div>
          ) : (
            <div>
              <p style={{ color:"var(--text-secondary)", fontSize:13, marginBottom:10 }}>2FA is not enabled.</p>
              {section==="2fa"
                ? <TwoFASetup user={currentUser} toast={toast} onDone={u=>{ onUserUpdate(u); setSection("main"); }} />
                : <button onClick={()=>setSection("2fa")} className="erc-prim" style={S.btn("primary")}>Setup 2FA</button>}
            </div>
          )}
        </DrawerSection>

        {myRequests.length>0 && (
          <DrawerSection title="My Access Requests">
            {myRequests.map(r=>{
              const c = r.status==="pending"?"#f59e0b":r.status==="approved"?"#10b981":"#ef4444";
              return (
                <div key={r.id} style={{ padding:"10px 12px", background:"rgba(0,0,0,0.25)", border:"1px solid var(--border-subtle)", borderRadius:8, marginBottom:8, fontSize:13 }}>
                  <div style={{ fontWeight:600, color:"var(--text-primary)" }}>{r.credentialName}</div>
                  <div style={{ display:"flex", justifyContent:"space-between", marginTop:4 }}>
                    <span style={{ color:"var(--text-muted)" }}>{timeAgo(r.requestedAt)}</span>
                    <span style={{ padding:"2px 8px", borderRadius:20, fontSize:11, fontWeight:600, background:c+"22", color:c, border:"1px solid "+c+"55" }}>{r.status}</span>
                  </div>
                </div>
              );
            })}
          </DrawerSection>
        )}
      </div>
    </div>
  );
}

// ─── Matrix View ──────────────────────────────────────────────────────────────
function MatrixView({ creds, toast, onReload }) {
  const ctx = useDepts();
  const teams = ctx ? ctx.deptIds : DEFAULT_DEPTS.map(d=>d.id);
  const grpKey = (c) => (c.clientIds||[]).includes("all") ? "All Clients" : ((c.clientNames||[]).join(", ") || "—");
  const groups = [...new Set(creds.map(grpKey))];
  const hasTeam = (cred, team) => cred.teams==="all"||(Array.isArray(cred.teams)&&cred.teams.includes(team));

  const toggleCell = async (cred, team) => {
    if (!window.confirm("Toggle "+team+" access for "+cred.portal+"?")) return;
    let nextTeams;
    if (cred.teams==="all") nextTeams = teams.filter(t=>t!==team);
    else { const arr = Array.isArray(cred.teams)?cred.teams:[]; nextTeams = arr.includes(team)?arr.filter(t=>t!==team):[...arr,team]; }
    try { await patchCredential(cred.id, { teams:nextTeams }); toast("Access updated","success"); onReload&&onReload(); }
    catch (e) { toast(e.message,"error"); }
  };

  return (
    <div style={{ ...glass, padding:0, overflow:"hidden" }}>
      <div style={{ overflowX:"auto" }}>
        <table style={{ borderCollapse:"collapse", minWidth:600, fontSize:13, width:"100%" }}>
          <thead>
            <tr>
              <th style={{ position:"sticky", left:0, background:"var(--bg-surface)", zIndex:2, padding:"12px 14px", textAlign:"left",
                borderBottom:"1px solid var(--border-default)", borderRight:"1px solid var(--border-subtle)", minWidth:200, fontWeight:700, color:"var(--text-primary)" }}>Credential</th>
              {teams.map(t=>(
                <th key={t} style={{ padding:"12px 14px", textAlign:"center", borderBottom:"1px solid var(--border-default)", minWidth:120, background:"rgba(0,0,0,0.3)" }}>
                  <TeamBadge team={t} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(grp=>(
              <React.Fragment key={grp}>
                <tr>
                  <td colSpan={teams.length+1} style={{ background:"rgba(0,0,0,0.25)", padding:"6px 14px", fontWeight:700, color:"var(--text-muted)", fontSize:10, letterSpacing:1.5, textTransform:"uppercase" }}>{grp}</td>
                </tr>
                {creds.filter(c=>grpKey(c)===grp).map((cred,i)=>(
                  <tr key={cred.id} className="erc-row" style={{ borderBottom:"1px solid var(--border-subtle)", background:i%2?"rgba(255,255,255,0.02)":"transparent" }}>
                    <td style={{ position:"sticky", left:0, background:"var(--bg-surface)", padding:"10px 14px", borderRight:"1px solid var(--border-subtle)", fontWeight:600, color:"var(--text-primary)" }}>{cred.portal}</td>
                    {teams.map(t=>(
                      <td key={t} style={{ padding:"10px 14px", textAlign:"center" }}>
                        <button onClick={()=>toggleCell(cred,t)}
                          style={{ background:hasTeam(cred,t)?"var(--gold-dim)":"rgba(255,255,255,0.03)", border:"1px solid "+(hasTeam(cred,t)?"rgba(245,184,0,0.4)":"var(--border-subtle)"),
                            borderRadius:6, padding:"4px 14px", cursor:"pointer", color:hasTeam(cred,t)?"var(--gold-bright)":"var(--text-muted)", fontWeight:700 }}>
                          {hasTeam(cred,t)?"✓":"–"}
                        </button>
                      </td>
                    ))}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Empty state ─────────────────────────────────────────────────────────────
function EmptyState({ icon, title, sub, action }) {
  return (
    <div style={{ ...glass, padding:"48px 24px", textAlign:"center" }}>
      <div style={{ width:72, height:72, borderRadius:"50%", background:"var(--gold-dim)", display:"flex", alignItems:"center",
        justifyContent:"center", fontSize:34, margin:"0 auto 16px", animation:"ercFloatY 3s ease-in-out infinite" }}>{icon}</div>
      <div style={{ fontSize:16, fontWeight:600, color:"var(--text-primary)", marginBottom:6 }}>{title}</div>
      <div style={{ fontSize:13, color:"var(--text-secondary)", marginBottom:action?18:0 }}>{sub}</div>
      {action}
    </div>
  );
}

// ─── Skeleton grid (credentials loading) ─────────────────────────────────────
function SkeletonGrid() {
  return (
    <div className="erc-page">
      <div style={{ display:"flex", gap:14, marginBottom:24, flexWrap:"wrap" }}>
        {Array.from({length:4}).map((_,i)=>(
          <div key={i} className="erc-skel" style={{ flex:1, minWidth:150, height:104, borderRadius:16 }} />
        ))}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(360px,1fr))", gap:16 }}>
        {Array.from({length:6}).map((_,i)=>(
          <div key={i} style={{ ...S.card(), display:"flex", flexDirection:"column", gap:12 }}>
            <div className="erc-skel" style={{ height:36, borderRadius:8, width:"60%" }} />
            <div className="erc-skel" style={{ height:44, borderRadius:8 }} />
            <div className="erc-skel" style={{ height:44, borderRadius:8 }} />
            <div className="erc-skel" style={{ height:20, borderRadius:8, width:"40%" }} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Loading splash — minimal 3-dot pulse, no logo ──────────────────────────────
function DotLoader() {
  return (
    <div style={{ display:"flex", gap:7 }} aria-label="Loading" role="status">
      {[0,1,2].map(i=>(
        <span key={i} style={{ width:8, height:8, borderRadius:"50%", background:"var(--gold-bright)",
          animation:`ercDot3 0.9s ease-in-out ${i*0.15}s infinite` }} />
      ))}
    </div>
  );
}
function Splash({ text }) {
  return (
    <div style={{ minHeight:"100vh", background:"var(--bg-void)", display:"flex", flexDirection:"column",
      alignItems:"center", justifyContent:"center", color:"var(--text-muted)", gap:16 }}>
      <DotLoader />
      <div style={{ fontSize:13, color:"var(--text-muted)", animation:"ercFade 0.3s ease 0.2s both" }}>{text||"Loading Eagle RCM…"}</div>
    </div>
  );
}

// ─── Stat Card ───────────────────────────────────────────────────────────────
function StatCard({ icon, val, label, descriptor, accent }) {
  const num = useCountUp(typeof val === "number" ? val : 0);
  const display = typeof val === "number" ? num : val;
  // stable pseudo-trend for the sparkline (visual only)
  let seed = 0; for (let i=0;i<label.length;i++) seed = (seed*31 + label.charCodeAt(i)) % 997;
  const bars = [0,1,2,3].map(i => 8 + ((seed >> (i*2)) % 9) * 2); // 8–24px
  return (
    <div style={{ ...glass, padding:20, flex:1, minWidth:150, position:"relative", overflow:"hidden" }}>
      <div style={{ position:"absolute", left:0, top:12, bottom:12, width:3, borderRadius:3, background:accent }} />
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10, paddingLeft:8 }}>
        <span style={{ fontSize:20 }}>{icon}</span>
        <span style={microLabel}>{label}</span>
      </div>
      <div style={{ display:"flex", alignItems:"flex-end", justifyContent:"space-between", paddingLeft:8 }}>
        <div style={{ fontSize:36, fontWeight:800, color:"var(--text-primary)", lineHeight:1 }}>{display}</div>
        <div style={{ display:"flex", alignItems:"flex-end", gap:3, height:24 }}>
          {bars.map((h,i)=><span key={i} style={{ width:4, height:h, borderRadius:2, background:hexA("#f5b800",0.3) }} />)}
        </div>
      </div>
      <div style={{ fontSize:12, color:"var(--text-muted)", marginTop:6, paddingLeft:8 }}>{descriptor}</div>
    </div>
  );
}

// ─── Glass toolbar wrapper ───────────────────────────────────────────────────
const toolbar = { background:"var(--track-bg)", border:"1px solid var(--border-subtle)", borderRadius:14, padding:"12px 16px",
  display:"flex", gap:10, flexWrap:"wrap", alignItems:"center", marginBottom:16 };

// ─── Credentials Tab ──────────────────────────────────────────────────────────
function CredentialsTab({ session, toast }) {
  const { density } = usePrefs();
  const listMode = density === "list";
  const [creds, setCreds] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [clientFilter, setClientFilter] = useState("All");
  const [portalFilter, setPortalFilter] = useState([]);
  const [restrictedOnly, setRestrictedOnly] = useState(false);
  const [inUseOnly, setInUseOnly] = useState(false);
  const [notWorkingOnly, setNotWorkingOnly] = useState(false);
  const [sort, setSort] = useState("A-Z");
  const [editCred, setEditCred] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [deleteCredState, setDeleteCredState] = useState(null);
  const [requestCred, setRequestCred] = useState(null);
  const [importRows, setImportRows] = useState(null);
  const [favs, setFavs] = useState([]);
  const [requests, setRequests] = useState([]);
  const [recentViewed, setRecentViewed] = useState([]);
  const [warnDismissed, setWarnDismissed] = useState(false);

  const isAdmin = session.team==="admin";
  const dctx = useDepts();

  const loadAll = useCallback(async () => {
    try {
      const [c, f, r, cl] = await Promise.all([
        listCredentials(),
        listFavourites(session.userId).catch(()=>[]),
        listRequests().catch(()=>[]),
        listClients().catch(()=>[]),
      ]);
      setCreds(c); setFavs(f); setRequests(r); setClients(cl);
    } catch (e) { toast(e.message,"error"); } finally { setLoading(false); }
  }, [session.userId, toast]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const clientsById = useMemo(() => Object.fromEntries(clients.map(c=>[c.id, c])), [clients]);
  const accessible = creds.filter(c=>canAccess(c,session.team));
  const clientNames = ["All",...[...new Set(creds.flatMap(c=>c.clientNames||[]).filter(n=>n&&n!=="All Clients"))].sort()];
  const portalNames = [...new Set(creds.map(c=>c.portal))].sort();

  const inUseList = (isAdmin?creds:accessible).filter(c=>c.inUse);
  const notWorkingList = (isAdmin?creds:accessible).filter(c=>c.notWorking);

  const restrictBase = isAdmin?creds:accessible;
  const restrictedCount = restrictBase.filter(c=>isRestrictedState(evalTimeRestriction(c.timeRestriction).state)).length;
  const expiredCount = restrictBase.filter(c=>evalTimeRestriction(c.timeRestriction).state==="expired").length;

  const baseList = isAdmin?creds:accessible;
  const filtered = baseList.filter(c=>{
    const q=search.toLowerCase();
    const ms=!search||c.portal.toLowerCase().includes(q)||c.username.toLowerCase().includes(q)||
      (c.clientNames||[]).join(" ").toLowerCase().includes(q)||(c.authLocation||"").toLowerCase().includes(q)||(c.url||"").toLowerCase().includes(q);
    const mcl=clientFilter==="All"||(c.clientIds||[]).includes("all")||(c.clientNames||[]).includes(clientFilter);
    const mp=portalFilter.length===0||portalFilter.includes(c.portal);
    const mr=!restrictedOnly||(c.timeRestriction&&c.timeRestriction.enabled);
    const miu=!inUseOnly||c.inUse;
    const mnw=!notWorkingOnly||c.notWorking;
    return ms&&mcl&&mp&&mr&&miu&&mnw;
  }).sort((a,b)=>{
    if(sort==="A-Z") return a.portal.localeCompare(b.portal);
    if(sort==="Newest") return new Date(b.addedAt)-new Date(a.addedAt);
    if(sort==="Oldest") return new Date(a.addedAt)-new Date(b.addedAt);
    if(sort==="Expiring Soon") return ((a.passwordExpiryDays||90)-daysSince(a.updatedAt))-((b.passwordExpiryDays||90)-daysSince(b.updatedAt));
    return 0;
  });

  const pinned = filtered.filter(c=>favs.includes(c.id));
  const unpinned = filtered.filter(c=>!favs.includes(c.id));

  const handleCopy = (cred, field) => {
    logAudit({ userId:session.userId, userName:session.userName, action:"copy",
      credentialId:cred.id, credentialName:cred.portal, detail:"Copied "+field });
    setRecentViewed(prev=>[cred,...prev.filter(c=>c.id!==cred.id)].slice(0,5));
  };

  const handleCopyVerify = (cred, field) => {
    logAudit({ userId:session.userId, userName:session.userName, action:"copy_verify",
      credentialId:cred.id, credentialName:cred.portal, detail:"Copied "+field });
    setRecentViewed(prev=>[cred,...prev.filter(c=>c.id!==cred.id)].slice(0,5));
  };

  const handleFavToggle = async (id) => {
    const on = !favs.includes(id);
    setFavs(prev => on ? [...prev, id] : prev.filter(x=>x!==id));
    try { await toggleFavourite(session.userId, id, on); } catch (e) { toast(e.message,"error"); loadAll(); }
  };

  const handleSave = async (c) => {
    try {
      if (c.id) { await updateCredential(c.id, c); logAudit({ userId:session.userId, userName:session.userName, action:"edit", credentialId:c.id, credentialName:c.portal }); toast("Credential updated!","success"); }
      else { const created = await createCredential(c, session.userName); logAudit({ userId:session.userId, userName:session.userName, action:"add", credentialId:created.id, credentialName:created.portal }); toast("Credential added!","success"); }
      setEditCred(null); setShowAdd(false); await loadAll();
    } catch (e) { toast(e.message,"error"); }
  };

  const handleDelete = async (c) => {
    try { await deleteCredential(c.id); logAudit({ userId:session.userId, userName:session.userName, action:"delete", credentialId:c.id, credentialName:c.portal }); setDeleteCredState(null); toast("Credential deleted","info"); await loadAll(); }
    catch (e) { toast(e.message,"error"); }
  };

  const handlePatch = async (id, patch) => {
    try { await patchCredential(id, patch); await loadAll(); }
    catch (e) { toast(e.message,"error"); }
  };

  const handleMarkInUse = async (cred, note) => {
    try {
      await setInUse(cred.id, true, session.userName, session.userId, note||null);
      logAudit({ userId:session.userId, userName:session.userName, action:"mark_in_use", credentialId:cred.id, credentialName:cred.portal, detail:note||undefined });
      await loadAll();
    } catch (e) { toast(e.message && e.message.includes("function")? "Run migration_7_status_flags.sql in Supabase first." : e.message,"error"); }
  };
  const handleReleaseInUse = async (cred) => {
    try {
      await setInUse(cred.id, false, null, null, null);
      logAudit({ userId:session.userId, userName:session.userName, action:"release_in_use", credentialId:cred.id, credentialName:cred.portal });
      toast("Released — "+cred.portal+" is now free","info"); await loadAll();
    } catch (e) { toast(e.message,"error"); }
  };
  const handleReportIssue = async (cred, note) => {
    try {
      const entry = { reportedBy:session.userName, reportedById:session.userId, reportedAt:new Date().toISOString(), note:note||"", resolved:false, resolvedAt:null, resolvedBy:null };
      const history = [...(cred.notWorkingHistory||[]), entry];
      await setNotWorking(cred.id, true, session.userName, session.userId, note||null, history);
      logAudit({ userId:session.userId, userName:session.userName, action:"report_not_working", credentialId:cred.id, credentialName:cred.portal, detail:note||undefined });
      toast("⚠️ Issue reported — admin has been notified","info"); await loadAll();
    } catch (e) { toast(e.message && e.message.includes("function")? "Run migration_7_status_flags.sql in Supabase first." : e.message,"error"); }
  };
  const handleResolveIssue = async (cred, note) => {
    try {
      const hist = (cred.notWorkingHistory||[]).map(x=>({...x}));
      for (let i=hist.length-1; i>=0; i--) { if (!hist[i].resolved) { hist[i].resolved=true; hist[i].resolvedAt=new Date().toISOString(); hist[i].resolvedBy=session.userName; hist[i].resolveNote=note||""; break; } }
      await setNotWorking(cred.id, false, null, null, null, hist);
      logAudit({ userId:session.userId, userName:session.userName, action:"resolve_not_working", credentialId:cred.id, credentialName:cred.portal, detail:note||undefined });
      toast("✓ Marked as resolved","success"); await loadAll();
    } catch (e) { toast(e.message,"error"); }
  };

  const handleFileImport = e => {
    const file=e.target.files[0]; if(!file) return;
    const reader=new FileReader();
    reader.onload=ev=>{
      const wb=XLSX.read(new Uint8Array(ev.target.result),{type:"array"});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const aoa=XLSX.utils.sheet_to_json(ws,{header:1,defval:""});
      // Step 1 — auto-detect the header row (decorated templates have title rows above it).
      const hdr=aoa.findIndex(row=>Array.isArray(row)&&row.some(c=>String(c).trim().toLowerCase()==="portal"));
      if(hdr<0){ toast("Could not find a header row. Make sure the file has a 'Portal' column header.","error"); return; }
      const headers=(aoa[hdr]||[]).map(h=>String(h==null?"":h).trim());
      // Step 2 — map each header (case-insensitive, trimmed, with aliases) to a canonical key.
      const ALIAS={
        "portal":"Portal","url":"URL","username":"Username","password":"Password",
        "client name":"Client Name","client(s)":"Client Name","clients":"Client Name","client":"Client Name",
        "teams":"Teams","team access":"Teams",
        "expiry days":"Expiry Days",
        "verify email":"Verify Email",
        "verify text":"Verify Text","verify text (phone)":"Verify Text",
        "verify auth":"Verify Auth","verify auth (authenticator)":"Verify Auth",
        "time restriction type":"Time Restriction Type","window days":"Window Days",
        "window start":"Window Start","window end":"Window End",
        "expiry date":"Expiry Date","schedule note":"Schedule Note",
      };
      const colIndex={}; headers.forEach((h,i)=>{ const key=ALIAS[h.toLowerCase()]; if(key&&colIndex[key]===undefined) colIndex[key]=i; });
      const cell=(row,key)=>{ const i=colIndex[key]; if(i===undefined) return ""; const v=row[i]; return v==null?"":String(v).trim(); };
      const KEYS=["Portal","URL","Username","Password","Client Name","Teams","Expiry Days","Verify Email","Verify Text","Verify Auth","Time Restriction Type","Window Days","Window Start","Window End","Expiry Date","Schedule Note"];
      // Step 3 — normalize to canonical objects, skipping blank padding rows.
      const out=[];
      for(const row of aoa.slice(hdr+1)){
        if(!Array.isArray(row)) continue;
        const o={}; KEYS.forEach(k=>{ o[k]=cell(row,k); });
        if(o.Portal==="" && o.Username==="" && o.Password==="") continue; // blank padding row
        out.push(o);
      }
      if(out.length===0){ toast("No credential rows found below the header.","error"); return; }
      setImportRows(out);
    };
    reader.readAsArrayBuffer(file); e.target.value="";
  };

  const parseImportTR = (r) => {
    const type=String(r["Time Restriction Type"]||"").trim().toLowerCase();
    if(type==="window") return { enabled:true, type:"window", windowDays:String(r["Window Days"]||"").split(/[,\s]+/).filter(Boolean), windowStart:r["Window Start"]||"09:00", windowEnd:r["Window End"]||"18:00", timezone:"local" };
    if(type==="expiry") return { enabled:true, type:"expiry", expiryDate:r["Expiry Date"]||"", expiresAt:"" };
    if(type==="schedule") return { enabled:true, type:"schedule", note:r["Schedule Note"]||"" };
    return null;
  };
  const resolveTeams = (raw) => {
    const val = String(raw||"").trim();
    if (!val || val.toLowerCase()==="all") return "all"; // blank or "all" → everyone
    const deptList = dctx?dctx.list:DEFAULT_DEPTS;
    const byId={}, byLabel={};
    deptList.forEach(d=>{ byId[d.id.toLowerCase()]=d.id; byLabel[d.label.toLowerCase()]=d.id; });
    const ids=[];
    for (const seg of val.split(",").map(s=>s.trim()).filter(Boolean)) {
      const whole = byId[seg.toLowerCase()]||byLabel[seg.toLowerCase()];
      if (whole) { ids.push(whole); continue; }
      for (const tok of seg.split(/\s+/).filter(Boolean)) { const m=byId[tok.toLowerCase()]||byLabel[tok.toLowerCase()]; if(m) ids.push(m); }
    }
    const uniq=[...new Set(ids)];
    return uniq.length ? uniq : "all"; // nothing matched → keep credential visible
  };
  const buildImportRecord = (r) => {
    const raw = String(r["Client Name"]||r.Client||r.Clients||"").trim();
    let clientIds, clientNames;
    if (!raw) { clientIds=[]; clientNames=[]; }               // blank → import with no client tag
    else if (raw.toLowerCase()==="all") { clientIds=["all"]; clientNames=["All Clients"]; }
    else {
      const names = raw.split(",").map(s=>s.trim()).filter(Boolean);
      const matched = names.map(n=>clients.find(x=>x.active && x.name.toLowerCase()===n.toLowerCase())).filter(Boolean);
      clientIds = matched.map(c=>c.id);
      clientNames = matched.map(c=>c.name);                   // only the matched clients are applied
    }
    const expiry = parseInt(String(r["Expiry Days"]||"").replace(/[^\d]/g,""),10);
    return {
      portal:r.Portal, url:r.URL||"", username:r.Username||"", password:r.Password||"",
      clientIds, clientNames,
      verifyEmail:r["Verify Email"]||"", verifyText:r["Verify Text"]||"", verifyAuth:r["Verify Auth"]||"",
      teams: resolveTeams(r.Teams),
      passwordExpiryDays: expiry>0 ? expiry : 90,
      timeRestriction: parseImportTR(r),
    };
  };
  const handleImportConfirm = async (result) => {
    const inserts = result.filter(b=>b.status==="valid"||b.status==="warning").map(b=>buildImportRecord(b.row));
    const overwrites = result.filter(b=>b.status==="duplicate" && b.decision==="overwrite");
    const skipped = result.filter(b=>b.status==="duplicate" && b.decision==="skip").length;
    const errored = result.filter(b=>b.status==="error").length;
    try {
      if (inserts.length) await bulkCreateCredentials(inserts, session.userName);
      for (const b of overwrites) {
        const rec = buildImportRecord(b.row);
        await updateCredential(b.existing.id, { ...b.existing, ...rec });
      }
      if (inserts.length) logAudit({ userId:session.userId, userName:session.userName, action:"bulk_import", detail:inserts.length+" credentials imported" });
      if (overwrites.length) logAudit({ userId:session.userId, userName:session.userName, action:"bulk_import_overwrite", detail:overwrites.length+" credentials overwritten" });
      setImportRows(null);
      toast(`✓ ${inserts.length} imported · ${overwrites.length} overwritten · ${skipped} skipped · ${errored} error${errored===1?"":"s"}`,"success");
      await loadAll();
    } catch (e) { toast(e.message,"error"); }
  };

  const handleExport = () => {
    const all=creds;
    const trType = (c)=>(c.timeRestriction&&c.timeRestriction.enabled)?c.timeRestriction.type:"";
    const trDetails = (c)=>{
      const t=c.timeRestriction; if(!t||!t.enabled) return "";
      if(t.type==="window") return `${summarizeDays(t.windowDays)} ${t.windowStart||""}-${t.windowEnd||""} ${t.timezone||"local"}`;
      if(t.type==="expiry") return `Expires ${t.expiryDate||""}${t.expiresAt?(" "+t.expiresAt):""}`;
      if(t.type==="schedule") return t.note||"";
      return "";
    };
    const trActive = (c)=>{ const st=evalTimeRestriction(c.timeRestriction).state;
      if(st==="none") return ""; return (st==="active"||st==="schedule"||st==="expiring")?"Yes":"No"; };
    const h=["Portal","URL","Username","Password","Clients","Client Codes","Privilege Level","Verify Email","Verify Text","Verify Auth","Teams","Expiry Days","Days Since Updated","In Use","In Use By","In Use Since","In Use Note","Not Working","Reported By","Reported At","Issue Note","Time Restriction Type","Window/Expiry Details","Active Now","Added By","Added At"];
    const rows=all.map(c=>{
      const isAll=(c.clientIds||[]).includes("all");
      const cl = isAll ? Object.values(clientsById) : (c.clientIds||[]).map(id=>clientsById[id]).filter(Boolean);
      const names = isAll ? "All Clients" : (c.clientNames||[]).join(", ");
      const codes = isAll ? "ALL" : cl.map(x=>x.code).join(", ");
      const priv = highestPrivilege(cl);
      return [c.portal,c.url,c.username,c.password,
        names, codes, priv,
        c.verifyEmail||"",c.verifyText||"",c.verifyAuth||"",
        c.teams==="all"?"all":(c.teams||[]).join(","),c.passwordExpiryDays,daysSince(c.updatedAt),
        c.inUse?"Yes":"No", c.inUseBy||"", c.inUseSince?new Date(c.inUseSince).toLocaleString():"", c.inUseNote||"",
        c.notWorking?"Yes":"No", c.notWorkingReportedBy||"", c.notWorkingAt?new Date(c.notWorkingAt).toLocaleString():"", c.notWorkingNote||"",
        trType(c),trDetails(c),trActive(c),c.addedBy,c.addedAt]; });
    const ws1=XLSX.utils.aoa_to_sheet([h,...rows]); ws1["!cols"]=h.map(()=>({wch:20}));
    const teams=dctx?dctx.deptIds:DEFAULT_DEPTS.map(d=>d.id);
    const mh=["Credential",...teams];
    const mr=all.map(c=>[c.portal,...teams.map(t=>(c.teams==="all"||(Array.isArray(c.teams)&&c.teams.includes(t)))?"✓":"")]);
    const ws2=XLSX.utils.aoa_to_sheet([mh,...mr]);
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws1,"Credentials"); XLSX.utils.book_append_sheet(wb,ws2,"Access Matrix");
    XLSX.writeFile(wb,"EagleRCM-Export.xlsx"); toast("Exported!","success");
  };

  const handleTemplate = async () => {
    try {
      const GOLD="FFD4AF37", GOLD_DK="FF8A6D1F", INK="FF0B0F16", PAPER="FFFFFFFF", ZEBRA="FFF6F3EC", REF_BG="FFFBF8F0";
      const teamList=(dctx?dctx.list:DEFAULT_DEPTS).map(d=>({id:d.id,label:d.label}));
      const clientList=clients.filter(c=>c.active).map(c=>c.name);
      const expiryOpts=["30","60","90","180"];
      const trOpts=["window","expiry","schedule"];
      const windowPresets=["Mon Tue Wed Thu Fri","Sat Sun","Mon Tue Wed Thu Fri Sat Sun","Mon Wed Fri"];
      const cols=[
        { h:"Portal",                w:18, note:"Required. Name of the service/portal." },
        { h:"URL",                   w:24, note:"Login URL (optional)." },
        { h:"Username",              w:22, note:"Required. Login username / email." },
        { h:"Password",              w:20, note:"Required. The credential secret." },
        { h:"Client Name",           w:24, note:"Pick from list, or comma-separate several. 'all' = every client." },
        { h:"Teams",                 w:22, note:"Pick a team id, comma-separate several, or 'all'." },
        { h:"Expiry Days",           w:13, note:"Password rotation cadence." },
        { h:"Verify Email",          w:22, note:"2FA recovery email (optional)." },
        { h:"Verify Text",           w:18, note:"2FA recovery phone (optional)." },
        { h:"Verify Auth",           w:18, note:"Authenticator label (optional)." },
        { h:"Time Restriction Type", w:18, note:"window / expiry / schedule — blank = always on." },
        { h:"Window Days",           w:24, note:"For 'window': days the login is allowed." },
        { h:"Window Start",          w:13, note:"For 'window': start time, e.g. 09:00." },
        { h:"Window End",            w:13, note:"For 'window': end time, e.g. 18:00." },
        { h:"Expiry Date",           w:14, note:"For 'expiry': YYYY-MM-DD." },
        { h:"Schedule Note",         w:26, note:"For 'schedule': free-text rule." },
      ];
      const NC=cols.length, lastCol=String.fromCharCode(64+NC); // up to Z (16 cols => P)
      const samples=[
        ["GitHub","github.com","org-dev-team","ghp_xxxxxxxx",clientList[0]||"TechCorp Solutions",teamList[0]?teamList[0].id:"engineering","90","","","Engineering Authy","window","Mon Tue Wed Thu Fri","09:00","18:00","",""],
        ["Figma","figma.com","design@co.com","figpass123",clientList[1]||clientList[0]||"Bright Agency","all","60","design@co.com inbox","","","","","","","",""],
        ["Notion","notion.so","team@co.com","notionpw","all","all","90","","+1 (555) 000-0000","","schedule","","","","","Business hours only — see ops"],
      ];

      const wb=new ExcelJS.Workbook();
      wb.creator="Eagle RCM"; wb.created=new Date();

      // ── Reference sheet (holds the validation lists + a guide) ──────────────
      const ref=wb.addWorksheet("Reference",{properties:{tabColor:{argb:GOLD}}});
      ref.columns=[{width:30},{width:18},{width:14},{width:16},{width:28},{width:2},{width:60}];
      const refTitle=ref.getCell("A1"); refTitle.value="Reference — allowed values"; ref.mergeCells("A1:E1");
      refTitle.font={bold:true,size:13,color:{argb:INK}}; refTitle.fill={type:"pattern",pattern:"solid",fgColor:{argb:GOLD}};
      refTitle.alignment={vertical:"middle"}; ref.getRow(1).height=22;
      const refHeads=["Clients","Teams","Expiry Days","Restriction","Window Days"];
      refHeads.forEach((t,i)=>{ const cell=ref.getCell(2,i+1); cell.value=t;
        cell.font={bold:true,color:{argb:PAPER}}; cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:GOLD_DK}}; });
      const refData=[["all",...clientList],["all",...teamList.map(t=>t.id)],expiryOpts,trOpts,windowPresets];
      refData.forEach((listVals,colIdx)=>{ listVals.forEach((v,r)=>{ const cell=ref.getCell(3+r,colIdx+1);
        cell.value=v; cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:REF_BG}}; cell.font={size:11}; }); });
      // team id → label guide + field notes in column G
      const guide=["Team ids → labels:",...teamList.map(t=>`  • ${t.id}  =  ${t.label}`),"",
        "Field notes:",...cols.map(c=>`  • ${c.h}: ${c.note}`),"",
        "Import: portal + username match prompts an overwrite."];
      guide.forEach((line,i)=>{ const cell=ref.getCell(1+i,7); cell.value=line;
        cell.font={size:11,bold:i===0||line==="Field notes:",color:{argb:INK}}; cell.alignment={wrapText:true}; });

      const colLetter=i=>String.fromCharCode(65+i); // 0->A
      const rng=(letter,n)=>`Reference!$${letter}$3:$${letter}$${2+n}`;
      const lists={
        4: rng(colLetter(0),refData[0].length),   // Client Name
        5: rng(colLetter(1),refData[1].length),   // Teams
        6: rng(colLetter(2),refData[2].length),   // Expiry Days
        10: rng(colLetter(3),refData[3].length),  // Time Restriction Type
        11: rng(colLetter(4),refData[4].length),  // Window Days
      };

      // ── Import Template sheet (first sheet, so it re-imports) ────────────────
      const ws=wb.addWorksheet("Import Template",{properties:{tabColor:{argb:GOLD_DK}},views:[{state:"frozen",ySplit:3}]});
      ws.columns=cols.map(c=>({width:c.w}));
      // Row 1 — title banner
      ws.mergeCells(1,1,1,NC); const tcell=ws.getCell("A1");
      tcell.value="EAGLE RCM  —  Credential Import Template";
      tcell.font={bold:true,size:15,color:{argb:GOLD}}; tcell.fill={type:"pattern",pattern:"solid",fgColor:{argb:INK}};
      tcell.alignment={vertical:"middle",horizontal:"left",indent:1}; ws.getRow(1).height=30;
      // Row 2 — instructions banner
      ws.mergeCells(2,1,2,NC); const icell=ws.getCell("A2");
      icell.value="Fill one credential per row. Use the dropdowns where shown. Required: Portal, Username, Password. See the Reference tab for team ids & notes.";
      icell.font={italic:true,size:10,color:{argb:INK}}; icell.fill={type:"pattern",pattern:"solid",fgColor:{argb:GOLD}};
      icell.alignment={vertical:"middle",horizontal:"left",indent:1,wrapText:true}; ws.getRow(2).height=26;
      // Row 3 — column headers
      const hr=ws.getRow(3); hr.height=20;
      cols.forEach((c,i)=>{ const cell=hr.getCell(i+1); cell.value=c.h;
        cell.font={bold:true,color:{argb:PAPER}}; cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:GOLD_DK}};
        cell.alignment={vertical:"middle",horizontal:"center"};
        cell.border={bottom:{style:"thin",color:{argb:GOLD}}};
        cell.note=c.note; });
      // Rows 4..53 — 50 data rows (3 prefilled samples)
      const TOTAL=50;
      for(let r=0;r<TOTAL;r++){
        const excelRow=4+r; const row=ws.getRow(excelRow); row.height=16;
        const sample=samples[r]; const zebra=r%2===1;
        for(let cI=0;cI<NC;cI++){
          const cell=row.getCell(cI+1);
          if(sample) cell.value=sample[cI];
          if(zebra) cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:ZEBRA}};
          cell.font={size:11,color:{argb:INK}};
          cell.alignment={vertical:"middle"};
        }
      }
      // Data validations down all 50 rows
      Object.entries(lists).forEach(([colIdx,formula])=>{
        const L=colLetter(+colIdx);
        for(let excelRow=4;excelRow<4+TOTAL;excelRow++){
          ws.getCell(`${L}${excelRow}`).dataValidation={
            type:"list", allowBlank:true, formulae:[formula], showErrorMessage:false,
          };
        }
      });

      const buf=await wb.xlsx.writeBuffer();
      const blob=new Blob([buf],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
      const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
      a.download="EagleRCM-Template.xlsx"; document.body.appendChild(a); a.click();
      a.remove(); URL.revokeObjectURL(a.href);
      toast("Template downloaded!","success");
    } catch(e){ toast(e.message||"Template failed","error"); }
  };

  const stats = {
    accessible: accessible.length,
    clientsCount: new Set(creds.flatMap(c=>c.clientNames||[]).filter(n=>n&&n!=="All Clients")).size,
    restricted: restrictedCount,
    team: accessible.filter(c=>c.teams!=="all"&&Array.isArray(c.teams)&&c.teams.includes(session.team)).length,
    total: creds.length,
  };

  const catPill = (active) => ({ padding:"6px 14px", fontSize:13, borderRadius:20, cursor:"pointer", fontWeight: active?600:500,
    border:"1px solid "+(active?"var(--gold-bright)":"var(--border-default)"), background:active?"var(--gold-dim)":"transparent",
    color:active?"var(--gold-bright)":"var(--text-secondary)", transition:"all .15s ease" });

  if (loading) return <SkeletonGrid />;

  // Grid (cards) vs List (rows) — same data, two rendering modes. Grid stretches
  // items so every card in a row shares the tallest card's height.
  const collWrap = listMode
    ? { display:"flex", flexDirection:"column", gap:8 }
    : { display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(360px,1fr))", gap:"var(--grid-gap)", alignItems:"stretch" };
  const renderCred = (c, i, fav) => listMode
    ? <CredentialRow key={c.id} cred={c} session={session} clientsById={clientsById} onEdit={setEditCred} onDelete={setDeleteCredState}
        onCopy={handleCopy} onFavToggle={handleFavToggle} isFav={fav} requests={requests} onRequestAccess={setRequestCred} toast={toast}
        onMarkInUse={handleMarkInUse} onReleaseInUse={handleReleaseInUse} onReportIssue={handleReportIssue} onResolveIssue={handleResolveIssue} />
    : <CredentialCard key={c.id} index={i} cred={c} session={session} clientsById={clientsById} onEdit={setEditCred} onDelete={setDeleteCredState}
        onCopy={handleCopy} onCopyVerify={handleCopyVerify} onFavToggle={handleFavToggle} isFav={fav} requests={requests}
        onRequestAccess={setRequestCred} toast={toast} onPatch={handlePatch}
        onMarkInUse={handleMarkInUse} onReleaseInUse={handleReleaseInUse} onReportIssue={handleReportIssue} onResolveIssue={handleResolveIssue} />;

  return (
    <div className="erc-page">
      {notWorkingList.length>0 && (
        <div style={{ background:"linear-gradient(90deg, rgba(239,68,68,0.12) 0%, rgba(239,68,68,0.05) 100%)",
          borderLeft:"3px solid #ef4444", border:"1px solid rgba(239,68,68,0.25)", borderRadius:12, padding:"12px 16px",
          marginBottom:12, display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
          <span style={{ width:30, height:30, borderRadius:"50%", background:"rgba(239,68,68,0.2)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>❌</span>
          <span style={{ color:"#fca5a5", fontWeight:600, fontSize:14, flex:1 }}>
            {notWorkingList.length} credential(s) reported as not working — {notWorkingList.slice(0,3).map(c=>c.portal).join(", ")}{notWorkingList.length>3?`, +${notWorkingList.length-3} more`:""}
          </span>
          <button onClick={()=>{ setNotWorkingOnly(true); setInUseOnly(false); setRestrictedOnly(false); }} style={{ background:"none", border:"none", color:"#f87171", cursor:"pointer", fontSize:13, fontWeight:600 }}>View All →</button>
        </div>
      )}
      {inUseList.length>0 && (
        <div style={{ background:"linear-gradient(90deg, rgba(249,115,22,0.12) 0%, rgba(249,115,22,0.05) 100%)",
          borderLeft:"3px solid #f97316", border:"1px solid rgba(249,115,22,0.25)", borderRadius:12, padding:"12px 16px",
          marginBottom:20, display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
          <span style={{ width:30, height:30, borderRadius:"50%", background:"rgba(249,115,22,0.2)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>🟠</span>
          <span style={{ color:"#fdba74", fontWeight:600, fontSize:14, flex:1 }}>
            {inUseList.length} credential(s) currently in use by your team — {inUseList.slice(0,3).map(c=>`${c.portal} (${c.inUseBy})`).join(", ")}{inUseList.length>3?`, +${inUseList.length-3} more`:""}
          </span>
          <button onClick={()=>{ setInUseOnly(true); setNotWorkingOnly(false); setRestrictedOnly(false); }} style={{ background:"none", border:"none", color:"#fb923c", cursor:"pointer", fontSize:13, fontWeight:600 }}>View All →</button>
        </div>
      )}

      <div style={{ display:"flex", gap:14, marginBottom:24, flexWrap:"wrap" }}>
        <StatCard icon="🔑" val={stats.accessible} label="Accessible" descriptor="credentials you can use" accent="var(--gold-bright)" />
        <StatCard icon="🏢" val={stats.clientsCount} label="Clients" descriptor="organisations" accent="#a78bfa" />
        <StatCard icon="⏰" val={stats.restricted} label="Restricted" descriptor="time-limited now" accent="var(--danger)" />
        <StatCard icon="👥" val={stats.team} label={"Team · "+session.team} descriptor="team-scoped" accent={(dctx?dctx.teamStyle(session.team):(TEAM_STYLES[session.team]||TEAM_STYLES.engineering)).color} />
        {isAdmin && <StatCard icon="📊" val={stats.total} label="Total" descriptor="across the vault" accent="var(--success)" />}
      </div>

      {recentViewed.length>0 && (
        <div style={{ marginBottom:20 }}>
          <div style={{ ...microLabel, color:"var(--text-gold)", marginBottom:8 }}>🕘 Recently viewed</div>
          <div style={{ display:"flex", gap:10, overflowX:"auto", paddingBottom:4 }}>
            {recentViewed.map(c=>(
              <div key={c.id} className="erc-card" style={{ ...glass, height:44, display:"flex", alignItems:"center", gap:8, padding:"0 14px",
                whiteSpace:"nowrap", fontSize:13, fontWeight:600, color:"var(--text-primary)", flexShrink:0 }}>
                🔑 {c.portal} <span style={{ color:"var(--text-muted)", fontWeight:400 }}>· {timeAgo(c.updatedAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {pinned.length>0 && (
        <div style={{ marginBottom:20, borderTop:"1px solid rgba(245,184,0,0.15)", paddingTop:16 }}>
          <div style={{ fontSize:13, fontWeight:700, color:"var(--gold-bright)", marginBottom:12, display:"flex", alignItems:"center", gap:8 }}>
            ⭐ Pinned <span style={{ background:"var(--gold-dim)", color:"var(--gold-bright)", borderRadius:20, padding:"1px 8px", fontSize:11 }}>{pinned.length}</span>
          </div>
          <div style={collWrap}>
            {pinned.map((c,i)=>renderCred(c,i,true))}
          </div>
        </div>
      )}

      <div style={toolbar}>
        <div style={{ position:"relative", flex:1, minWidth:240, maxWidth:340 }}>
          <span style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", color:"var(--text-muted)", fontSize:14 }}>🔍</span>
          <input value={search} onChange={e=>setSearch(e.target.value)} style={{ ...S.input(), padding:"10px 36px" }} placeholder="Search credentials..." />
          {search && <button onClick={()=>setSearch("")} style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", color:"var(--text-muted)", cursor:"pointer", fontSize:14 }}>✕</button>}
        </div>
        <select value={sort} onChange={e=>setSort(e.target.value)} style={{ ...S.input(), width:"auto" }}>
          {["A-Z","Newest","Oldest","Expiring Soon"].map(s=><option key={s}>{s}</option>)}
        </select>
        <PortalFilter portals={portalNames} creds={baseList} selected={portalFilter} onChange={setPortalFilter} />
        <button onClick={()=>setRestrictedOnly(v=>!v)} style={catPill(restrictedOnly)}>⏰ Time-Restricted</button>
        <button onClick={()=>setInUseOnly(v=>!v)} style={{ padding:"8px 14px", fontSize:13, borderRadius:8, cursor:"pointer", fontWeight:600, border:"1px solid "+(inUseOnly?"#f97316":"var(--border-default)"), background:inUseOnly?"rgba(249,115,22,0.15)":"transparent", color:inUseOnly?"#f97316":"var(--text-secondary)" }}>🟠 In Use</button>
        <button onClick={()=>setNotWorkingOnly(v=>!v)} style={{ padding:"8px 14px", fontSize:13, borderRadius:8, cursor:"pointer", fontWeight:600, border:"1px solid "+(notWorkingOnly?"#ef4444":"var(--border-default)"), background:notWorkingOnly?"rgba(239,68,68,0.15)":"transparent", color:notWorkingOnly?"#f87171":"var(--text-secondary)" }}>❌ Not Working</button>
        {isAdmin && (
          <div style={{ display:"flex", gap:8, marginLeft:"auto", flexWrap:"wrap" }}>
            <label className="erc-ghost" style={{ ...S.btn("ghost"), cursor:"pointer" }}>
              📥 Import<input type="file" accept=".xlsx,.xls" style={{ display:"none" }} onChange={handleFileImport} />
            </label>
            <button onClick={handleExport} className="erc-ghost" style={S.btn("ghost")}>📤 Export</button>
            <button onClick={handleTemplate} className="erc-ghost" style={S.btn("ghost")}>📋 Template</button>
            <button onClick={()=>setShowAdd(true)} className="erc-prim" style={S.btn("primary")}>+ Add Credential</button>
          </div>
        )}
      </div>

      {clientNames.length>1 && (
        <div style={{ display:"flex", gap:8, marginBottom:18, flexWrap:"wrap", alignItems:"center" }}>
          <span style={microLabel}>Client</span>
          {clientNames.map(cl=>(<button key={cl} className="erc-pill" onClick={()=>setClientFilter(cl)} style={catPill(clientFilter===cl)}>{cl==="All"?"All Clients":"🏢 "+cl}</button>))}
        </div>
      )}

      <div style={{ fontSize:13, color:"var(--text-muted)", marginBottom:14 }}>{filtered.length} credential(s) found</div>

      {filtered.length===0 ? (
        search||clientFilter!=="All"||portalFilter.length>0||restrictedOnly||inUseOnly||notWorkingOnly
          ? <EmptyState icon="🔍" title="Nothing matched" sub="Try different search terms or clear filters" />
          : <EmptyState icon="🔑" title="No credentials yet" sub="Add your first credential to get started"
              action={isAdmin && <button onClick={()=>setShowAdd(true)} className="erc-prim" style={S.btn("primary")}>+ Add Credential</button>} />
      ) : (
        <div style={collWrap}>
          {unpinned.map((c,i)=>renderCred(c,i,false))}
        </div>
      )}

      {(editCred||showAdd) && (
        <CredModal cred={editCred} onSave={handleSave} onClose={()=>{ setEditCred(null); setShowAdd(false); }} session={session} clients={clients} />
      )}
      {deleteCredState && (
        <div style={S.overlay}>
          <div style={{ ...glass, padding:28, maxWidth:380, textAlign:"center" }}>
            <div style={{ width:56, height:56, borderRadius:"50%", background:"var(--danger-bg)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:26, margin:"0 auto 14px" }}>🗑️</div>
            <h3 style={{ fontWeight:700, marginBottom:8, color:"var(--text-primary)", fontSize:18 }}>Delete "{deleteCredState.portal}"?</h3>
            <p style={{ color:"var(--text-secondary)", fontSize:14, marginBottom:20 }}>This permanently removes the credential and cannot be undone.</p>
            <div style={{ display:"flex", gap:10, justifyContent:"center" }}>
              <button onClick={()=>setDeleteCredState(null)} className="erc-ghost" style={S.btn("ghost")}>Cancel</button>
              <button onClick={()=>handleDelete(deleteCredState)} className="erc-prim" style={{ ...S.btn("primary"), background:"#dc2626", color:"#fff", boxShadow:"0 4px 16px rgba(239,68,68,0.3)" }}>Delete</button>
            </div>
          </div>
        </div>
      )}
      {requestCred && (
        <RequestAccessModal cred={requestCred} session={session} onClose={()=>setRequestCred(null)} toast={toast} onDone={loadAll} />
      )}
      {importRows && (
        <ImportPreviewModal rows={importRows} existingCreds={creds} clients={clients} deptList={dctx?dctx.list:DEFAULT_DEPTS} onConfirm={handleImportConfirm} onClose={()=>setImportRows(null)} />
      )}
    </div>
  );
}

// ─── Client Modal ─────────────────────────────────────────────────────────────
function ClientModal({ client, onSave, onClose }) {
  const ctx = useDepts();
  const deptList = ctx ? ctx.list : DEFAULT_DEPTS;
  const [form, setForm] = useState(client
    ? { ...client }
    : { name:"", code:"", color:CLIENT_PALETTE[0], privilegeLevel:"standard", allowedTeams:[], description:"", active:true });
  const [codeEdited, setCodeEdited] = useState(!!client);
  const [busy, setBusy] = useState(false);
  const set = (k,v) => setForm(p=>({...p,[k]:v}));
  const onName = (v) => setForm(p=>({ ...p, name:v, code: codeEdited?p.code:autoCode(v) }));
  const toggleTeam = (t) => setForm(p=>({ ...p, allowedTeams: p.allowedTeams.includes(t)?p.allowedTeams.filter(x=>x!==t):[...p.allowedTeams,t] }));
  const submit = async (e) => { e.preventDefault(); if(!form.name.trim()) return; setBusy(true);
    try { await onSave({ ...form, code: (form.code||autoCode(form.name)).toUpperCase() }); } finally { setBusy(false); } };

  return (
    <div style={S.overlay} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ ...S.modal(), padding:28, width:"90%", maxWidth:520, maxHeight:"85vh", overflowY:"auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
          <h3 style={{ fontWeight:700, fontSize:18, color:"var(--text-primary)" }}>{client?"Edit Client":"Add Client"}</h3>
          <button onClick={onClose} className="erc-ghost" style={{ ...S.btn("ghost"), padding:"6px 10px" }}>✕</button>
        </div>
        <form onSubmit={submit}>
          <div style={{ display:"flex", gap:12, marginBottom:14 }}>
            <div style={{ flex:1 }}>
              <label style={S.label}>Client Name</label>
              <input value={form.name} onChange={e=>onName(e.target.value)} style={S.input()} required />
            </div>
            <div style={{ width:120 }}>
              <label style={S.label}>Code</label>
              <input value={form.code} onChange={e=>{ setCodeEdited(true); set("code",e.target.value.toUpperCase().slice(0,5)); }} style={{ ...S.input(), fontFamily:"var(--font-mono)" }} />
            </div>
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={S.label}>Colour</label>
            <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
              {CLIENT_PALETTE.map(c=>(
                <button key={c} type="button" onClick={()=>set("color",c)} title={c}
                  style={{ width:26, height:26, borderRadius:"50%", background:c, cursor:"pointer", border:form.color===c?"2px solid #fff":"2px solid transparent" }} />
              ))}
            </div>
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={S.label}>Privilege Level</label>
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {Object.entries(PRIVILEGE_META).map(([key,m])=>{ const on=form.privilegeLevel===key;
                return (
                  <button key={key} type="button" onClick={()=>set("privilegeLevel",key)}
                    style={{ display:"flex", alignItems:"flex-start", gap:10, padding:"10px 12px", borderRadius:10, cursor:"pointer", textAlign:"left",
                      border:"1px solid "+(on?m.color:"var(--border-default)"), background:on?hexA(m.color,0.12):"rgba(0,0,0,0.25)" }}>
                    <span style={{ marginTop:2, color:m.color }}>{on?"●":"○"}</span>
                    <span>
                      <span style={{ fontSize:13, fontWeight:700, color:on?m.color:"var(--text-primary)" }}>{m.label}</span>
                      <span style={{ fontSize:12, color:"var(--text-muted)", display:"block" }}>{m.desc}</span>
                    </span>
                  </button>
                ); })}
            </div>
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={S.label}>Allowed Teams</label>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
              {deptList.map(d=>{ const on=form.allowedTeams.includes(d.id);
                return (
                  <label key={d.id} style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer", padding:"5px 12px", textTransform:"capitalize",
                    border:"1px solid "+(on?"var(--info)":"var(--border-default)"), borderRadius:20, fontSize:12,
                    background:on?"var(--info-bg)":"rgba(0,0,0,0.3)", color:on?"var(--info)":"var(--text-secondary)" }}>
                    <input type="checkbox" checked={on} onChange={()=>toggleTeam(d.id)} style={{ display:"none" }} />{d.label}
                  </label>
                ); })}
            </div>
            {form.privilegeLevel==="confidential" && <p style={{ fontSize:12, color:"var(--text-muted)", margin:"6px 0 0" }}>Confidential clients are admin-only regardless of allowed teams.</p>}
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={S.label}>Description</label>
            <textarea value={form.description} onChange={e=>set("description",e.target.value)} style={{ ...S.input(), resize:"vertical", minHeight:64 }} placeholder="What this client covers…" />
          </div>
          <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", fontSize:13, color:"var(--text-secondary)", marginBottom:20 }}>
            <input type="checkbox" checked={form.active} onChange={e=>set("active",e.target.checked)} /> Active (selectable for new credentials)
          </label>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <button type="button" onClick={onClose} className="erc-ghost" style={S.btn("ghost")}>Cancel</button>
            <button type="submit" disabled={busy} className="erc-prim" style={{ ...S.btn("primary"), opacity:busy?0.7:1 }}>{client?"Save Changes":"Add Client"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Clients Tab (admin) ──────────────────────────────────────────────────────
function ClientsTab({ session, toast }) {
  const [clients, setClients] = useState([]);
  const [creds, setCreds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [privFilter, setPrivFilter] = useState("All");
  const [showAdd, setShowAdd] = useState(false);
  const [editClient, setEditClient] = useState(null);

  const load = useCallback(async () => {
    try { const [cl,cr] = await Promise.all([listClients(), listCredentials()]); setClients(cl); setCreds(cr); }
    catch (e) { toast(e.message,"error"); } finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  const credCount = (id) => creds.filter(c=>(c.clientIds||[]).includes(id)||(c.clientIds||[]).includes("all")).length;
  const filtered = clients.filter(c =>
    (!search || c.name.toLowerCase().includes(search.toLowerCase()) || (c.code||"").toLowerCase().includes(search.toLowerCase())) &&
    (privFilter==="All" || c.privilegeLevel===privFilter));

  const handleSave = async (c) => {
    try {
      if (c.id) { await updateClient(c.id, c); logAudit({ userId:session.userId, userName:session.userName, action:"client_edited", detail:c.name }); toast("Client saved","success"); }
      else { await createClient(c, session.userName); logAudit({ userId:session.userId, userName:session.userName, action:"client_created", detail:c.name }); toast("Client created","success"); }
      setShowAdd(false); setEditClient(null); await load();
    } catch (e) { toast(e.message && e.message.includes("does not exist") ? "Run migration_4_clients.sql in Supabase first." : e.message, "error"); }
  };
  const handleArchive = async (c) => {
    try { await archiveClient(c.id, !c.active); logAudit({ userId:session.userId, userName:session.userName, action:"client_archived", detail:c.name }); toast(c.active?"Client archived":"Client restored","info"); await load(); }
    catch (e) { toast(e.message,"error"); }
  };

  const privPill = (active, color) => ({ padding:"6px 14px", fontSize:13, borderRadius:20, cursor:"pointer", fontWeight: active?600:500,
    border:"1px solid "+(active?(color||"var(--gold-bright)"):"var(--border-default)"), background:active?hexA(color||"#f5b800",0.15):"transparent",
    color:active?(color||"var(--gold-bright)"):"var(--text-secondary)" });

  if (loading) return <Splash text="Loading clients…" />;

  return (
    <div className="erc-page">
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16, flexWrap:"wrap", gap:10 }}>
        <div style={{ fontWeight:700, color:"var(--text-primary)", fontSize:20 }}>
          Clients <span style={{ color:"var(--text-muted)", fontSize:14, fontWeight:400 }}>({clients.length})</span>
        </div>
        <button onClick={()=>setShowAdd(true)} className="erc-prim" style={S.btn("primary")}>+ Add Client</button>
      </div>

      <div style={toolbar}>
        <div style={{ position:"relative", flex:1, minWidth:220, maxWidth:320 }}>
          <span style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", color:"var(--text-muted)" }}>🔍</span>
          <input value={search} onChange={e=>setSearch(e.target.value)} style={{ ...S.input(), padding:"10px 36px" }} placeholder="Search clients..." />
        </div>
        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
          <button onClick={()=>setPrivFilter("All")} style={privPill(privFilter==="All")}>All</button>
          {Object.entries(PRIVILEGE_META).map(([k,m])=>(<button key={k} onClick={()=>setPrivFilter(k)} style={privPill(privFilter===k,m.color)}>{m.label}</button>))}
        </div>
      </div>

      {filtered.length===0 ? (
        <EmptyState icon="🏢" title="No clients yet" sub="Add your first client to start tagging credentials"
          action={<button onClick={()=>setShowAdd(true)} className="erc-prim" style={S.btn("primary")}>+ Add Client</button>} />
      ) : (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))", gap:16 }}>
          {filtered.map((c,i)=>{ const pm=PRIVILEGE_META[c.privilegeLevel];
            return (
              <div key={c.id} className="erc-card" style={{ ...S.card(), opacity:c.active?1:0.6, animation:"ercCardIn 0.3s ease-out both", animationDelay:`${i*40}ms` }}>
                <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:12 }}>
                  <span style={{ width:48, height:48, borderRadius:"50%", background:hexA(c.color,0.2), border:"2px solid "+c.color, flexShrink:0 }} />
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                      <span style={{ fontWeight:700, fontSize:16, color:"var(--text-primary)" }}>{c.name}</span>
                      <span style={{ fontFamily:"var(--font-mono)", fontSize:11, color:"var(--text-muted)", background:"rgba(255,255,255,0.05)", borderRadius:6, padding:"1px 6px" }}>{c.code}</span>
                    </div>
                    <div style={{ marginTop:4 }}>
                      <span style={{ background:hexA(pm.color,0.15), color:pm.color, border:"1px solid "+hexA(pm.color,0.4), borderRadius:20, padding:"2px 9px", fontSize:11, fontWeight:700 }}>{pm.label}</span>
                      {!c.active && <span style={{ marginLeft:6, fontSize:11, color:"var(--text-muted)" }}>· Archived</span>}
                    </div>
                  </div>
                </div>
                <div style={{ ...microLabel, marginBottom:6 }}>Allowed teams</div>
                <div style={{ display:"flex", gap:4, flexWrap:"wrap", marginBottom:12, minHeight:22 }}>
                  {c.allowedTeams.length ? c.allowedTeams.map(t=><TeamBadge key={t} team={t} small />) : <span style={{ fontSize:12, color:"var(--text-muted)" }}>{c.privilegeLevel==="confidential"?"Admin only":"None"}</span>}
                </div>
                {c.description && <p style={{ fontSize:13, color:"var(--text-secondary)", marginBottom:12, display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical", overflow:"hidden" }}>{c.description}</p>}
                <div style={{ fontSize:12, color:"var(--text-muted)", marginBottom:12 }}>{credCount(c.id)} credential(s) tagged</div>
                <div style={{ display:"flex", gap:6, paddingTop:10, borderTop:"1px solid var(--border-subtle)" }}>
                  <button onClick={()=>setEditClient(c)} className="erc-ghost" style={{ ...S.btn("ghost"), padding:"5px 12px", fontSize:12 }}>Edit</button>
                  <button onClick={()=>handleArchive(c)} className="erc-ghost" style={{ ...S.btn("ghost"), padding:"5px 12px", fontSize:12 }}>{c.active?"Archive":"Restore"}</button>
                </div>
              </div>
            ); })}
        </div>
      )}

      {(showAdd||editClient) && (
        <ClientModal client={editClient} onSave={handleSave} onClose={()=>{ setShowAdd(false); setEditClient(null); }} />
      )}
    </div>
  );
}

// ─── Users Tab ────────────────────────────────────────────────────────────────
function UsersTab({ session, toast, onPendingChange }) {
  const ctx = useDepts();
  const [users, setUsers] = useState([]);
  const [creds, setCreds] = useState([]);
  const [invites, setInvites] = useState([]);
  const [pendingRegs, setPendingRegs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [teamFilter, setTeamFilter] = useState("All");
  const [showAdd, setShowAdd] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const [resetUser, setResetUser] = useState(null);
  const [matrixView, setMatrixView] = useState(false);
  const [showDepts, setShowDepts] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);
  const [rejectReg, setRejectReg] = useState(null);
  const [approveReg, setApproveReg] = useState(null);
  const [showResolved, setShowResolved] = useState(false);

  const loadAll = useCallback(async () => {
    try {
      const [u,c,inv,reg] = await Promise.all([
        listUsers(), listCredentials(),
        listInviteTokens().catch(()=>[]), listPendingRegistrations().catch(()=>[]),
      ]);
      setUsers(u); setCreds(c); setInvites(inv); setPendingRegs(reg);
    } catch (e) { toast(e.message,"error"); } finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { loadAll(); }, [loadAll]);

  const adminCount = users.filter(u=>u.team==="admin" && u.active!==false).length;
  const filtered = users.filter(u=>{
    if (u.active===false) return false; // pending/inactive shown in Registrations section
    const ms=!search||u.name.toLowerCase().includes(search.toLowerCase())||u.username.toLowerCase().includes(search.toLowerCase());
    const mt=teamFilter==="All"||u.team===teamFilter;
    return ms&&mt;
  });

  const pendingRegList = pendingRegs.filter(r=>r.status==="pending");
  const resolvedRegList = pendingRegs.filter(r=>r.status!=="pending");

  const handleApprove = async (reg, team) => {
    try {
      await approveRegistration(reg, team, session.userName);
      logAudit({ userId:session.userId, userName:session.userName, action:"user_approved_registration", detail:reg.fullName+" ("+reg.username+")" });
      toast(reg.fullName+" approved","success"); setApproveReg(null); await loadAll(); onPendingChange && onPendingChange();
    } catch (e) { toast(e.message,"error"); }
  };
  const handleReject = async (reg, reason) => {
    try {
      await rejectRegistration(reg, reason, session.userName);
      logAudit({ userId:session.userId, userName:session.userName, action:"user_rejected_registration", detail:reg.fullName+" ("+reg.username+")" });
      toast(reg.fullName+" rejected","info"); await loadAll(); onPendingChange && onPendingChange();
    } catch (e) { toast(e.message,"error"); }
  };
  const handleRevoke = async (inv) => {
    try { await revokeInviteToken(inv.id); toast("Invite revoked","info"); await loadAll(); } catch (e) { toast(e.message,"error"); }
  };
  const copyInvite = (inv) => { navigator.clipboard.writeText(`${window.location.origin}?invite=${inv.token}`).then(()=>toast("Link copied","success")); };
  const inviteStatus = (inv) => {
    if (!inv.active) return inv.usedCount>=inv.maxUses ? { t:"Used", c:"#94a3b8" } : { t:"Revoked", c:"#94a3b8" };
    if (inv.expiresAt && new Date(inv.expiresAt) < new Date()) return { t:"Expired", c:"#ef4444" };
    return { t:"Active", c:"#10b981" };
  };

  const handleSave = async (form) => {
    try {
      if (editUser) {
        await updateProfile(editUser.id, { name:form.name, team:form.team, avatar:getInitials(form.name) });
        if (form.password) await adminResetPassword(editUser.id, form.password);
        logAudit({ userId:session.userId, userName:session.userName, action:"edit_user", targetUserId:editUser.id });
        toast("User updated!","success");
      } else {
        await adminCreateUser({ name:form.name, username:form.username, password:form.password, team:form.team });
        logAudit({ userId:session.userId, userName:session.userName, action:"add_user" });
        toast("User added!","success");
      }
      setShowAdd(false); setEditUser(null); await loadAll();
    } catch (e) { toast(e.message,"error"); }
  };

  const handleRemove = async (u) => {
    if(u.id===session.userId){ toast("Cannot remove yourself","error"); return; }
    if(u.team==="admin"&&adminCount<=1){ toast("Cannot remove last admin","error"); return; }
    if(!window.confirm("Remove "+u.name+"?")) return;
    try { await adminDeleteUser(u.id); logAudit({ userId:session.userId, userName:session.userName, action:"remove_user", targetUserId:u.id }); toast("User removed","info"); await loadAll(); }
    catch (e) { toast(e.message,"error"); }
  };

  const handleToggle2FA = async (u) => {
    try { await updateProfile(u.id, { twoFactorEnabled:!u.twoFactorEnabled, twoFactorSecret:"" }); toast("2FA "+(u.twoFactorEnabled?"disabled":"enabled")+" for "+u.name,"info"); await loadAll(); }
    catch (e) { toast(e.message,"error"); }
  };

  const teamPill = (active) => ({ ...S.btn(active?"primary":"ghost"), padding:"6px 14px", fontSize:13 });

  if (loading) return <Splash text="Loading users…" />;

  return (
    <div className="erc-page">
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16, flexWrap:"wrap", gap:10 }}>
        <div style={{ fontWeight:700, color:"var(--text-primary)", fontSize:20 }}>
          Users <span style={{ color:"var(--text-muted)", fontSize:14, fontWeight:400 }}>({users.length})</span>
        </div>
        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
          <button onClick={()=>setShowDepts(true)} className="erc-ghost" style={S.btn("ghost")}>🏷️ Departments</button>
          <button onClick={()=>setMatrixView(p=>!p)} className={matrixView?"erc-prim":"erc-ghost"} style={S.btn(matrixView?"primary":"ghost")}>{matrixView?"List View":"Matrix View"}</button>
          <button onClick={()=>setShowAdd(true)} className="erc-prim" style={S.btn("primary")}>+ Add User</button>
        </div>
      </div>

      {matrixView ? (
        <MatrixView creds={creds} toast={toast} onReload={loadAll} />
      ) : (
        <>
          <div style={toolbar}>
            <div style={{ position:"relative", flex:1, minWidth:220, maxWidth:300 }}>
              <span style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", color:"var(--text-muted)" }}>🔍</span>
              <input value={search} onChange={e=>setSearch(e.target.value)} style={{ ...S.input(), padding:"10px 36px" }} placeholder="Search users..." />
            </div>
            <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
              {["All","admin",...(ctx?ctx.deptIds:DEFAULT_DEPTS.map(d=>d.id))].map(t=>(
                <button key={t} onClick={()=>setTeamFilter(t)} style={teamPill(teamFilter===t)}>{t==="All"?"All":(ctx?ctx.teamLabel(t):t)}</button>
              ))}
            </div>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))", gap:16 }}>
            {filtered.map((u,i)=>{
              const accessCount=creds.filter(c=>canAccess(c,u.team)).length;
              const st=ctx?ctx.teamStyle(u.team):(TEAM_STYLES[u.team]||TEAM_STYLES.engineering);
              const status = u.lockedUntil && new Date(u.lockedUntil)>new Date() ? { t:"Locked", c:"#ef4444" }
                : u.lastLoginAt ? { t:"Active", c:"#10b981" } : { t:"No recent login", c:"#f59e0b" };
              return (
                <div key={u.id} className="erc-card" style={{ ...S.card(), animation:"ercCardIn 0.3s ease-out both", animationDelay:`${i*40}ms` }}>
                  <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:12 }}>
                    <div style={{ width:52, height:52, borderRadius:"50%", background:st.bg, color:st.color, border:"2px solid "+st.border,
                      display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, fontSize:17, flexShrink:0 }}>{u.avatar}</div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                        <span style={{ fontWeight:700, color:"var(--text-primary)", fontSize:16 }}>{u.name}</span>
                        {u.id===session.userId && <span style={{ background:"var(--gold-dim)", color:"var(--gold-bright)", borderRadius:20, padding:"1px 7px", fontSize:10, fontWeight:700 }}>You</span>}
                      </div>
                      <div style={{ marginTop:4 }}><TeamBadge team={u.team} small /></div>
                    </div>
                  </div>
                  <div style={{ height:1, background:"var(--border-subtle)", marginBottom:12 }} />
                  <div style={{ fontSize:12, color:"var(--text-secondary)", marginBottom:12, display:"flex", flexDirection:"column", gap:5 }}>
                    <div style={{ display:"flex", justifyContent:"space-between" }}><span>Last login</span><span style={{ color:"var(--text-primary)" }}>{u.lastLoginAt?timeAgo(u.lastLoginAt):"Never"}</span></div>
                    <div style={{ display:"flex", justifyContent:"space-between" }}><span>Credential access</span><span style={{ color:"var(--text-primary)" }}>{accessCount}</span></div>
                    <div style={{ display:"flex", justifyContent:"space-between" }}><span>Two-factor</span><span style={{ color:u.twoFactorEnabled?"var(--success)":"var(--text-muted)" }}>{u.twoFactorEnabled?"Enabled ✓":"Off"}</span></div>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}><span>Status</span>
                      <span style={{ background:status.c+"22", color:status.c, border:"1px solid "+status.c+"55", borderRadius:20, padding:"2px 8px", fontSize:11, fontWeight:600 }}>{status.t}</span></div>
                  </div>
                  <div style={{ display:"flex", gap:6, flexWrap:"wrap", paddingTop:10, borderTop:"1px solid var(--border-subtle)" }}>
                    <button onClick={()=>setEditUser(u)} className="erc-ghost" style={{ ...S.btn("ghost"), padding:"5px 10px", fontSize:12 }}>Edit</button>
                    <button onClick={()=>setResetUser(u)} className="erc-ghost" style={{ ...S.btn("ghost"), padding:"5px 10px", fontSize:12 }}>Reset PW</button>
                    <button onClick={()=>handleToggle2FA(u)} className="erc-ghost" style={{ ...S.btn("ghost"), padding:"5px 10px", fontSize:12 }}>{u.twoFactorEnabled?"Disable 2FA":"Enable 2FA"}</button>
                    <button onClick={()=>handleRemove(u)} disabled={u.id===session.userId||(u.team==="admin"&&adminCount<=1)}
                      style={{ ...S.btn("danger"), padding:"5px 10px", fontSize:12,
                        opacity:(u.id===session.userId||(u.team==="admin"&&adminCount<=1))?0.4:1,
                        cursor:(u.id===session.userId||(u.team==="admin"&&adminCount<=1))?"not-allowed":"pointer" }}>Remove</button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Invite Links */}
      <div style={{ marginTop:28 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12, flexWrap:"wrap", gap:10 }}>
          <h3 style={{ fontWeight:700, color:"var(--text-primary)", fontSize:18 }}>Invite Links</h3>
          <button onClick={()=>setShowGenerate(true)} className="erc-prim" style={S.btn("primary")}>+ Generate Invite Link</button>
        </div>
        {invites.length===0
          ? <div style={{ ...glass, padding:20, color:"var(--text-muted)", fontSize:13 }}>No invite links yet.</div>
          : <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {invites.map(inv=>{ const s=inviteStatus(inv);
                const hrsLeft = inv.expiresAt ? Math.max(0, Math.round((new Date(inv.expiresAt)-Date.now())/3600000)) : null;
                return (
                  <div key={inv.id} style={{ ...glass, padding:"12px 16px", display:"flex", alignItems:"center", gap:12, flexWrap:"wrap", opacity:s.t==="Active"?1:0.6 }}>
                    <div style={{ flex:1, minWidth:160 }}>
                      <div style={{ color:"var(--text-primary)", fontWeight:600, fontSize:14 }}>{inv.label||"(no label)"}</div>
                      <div style={{ color:"var(--text-muted)", fontSize:12 }}>
                        {inv.allowedTeam ? (ctx?ctx.teamLabel(inv.allowedTeam):inv.allowedTeam) : "Team on approval"} · {hrsLeft!==null?`expires in ${hrsLeft}h`:"no expiry"} · uses {inv.usedCount}/{inv.maxUses}
                      </div>
                    </div>
                    <span style={{ background:s.c+"22", color:s.c, border:"1px solid "+s.c+"55", borderRadius:20, padding:"2px 10px", fontSize:11, fontWeight:600 }}>{s.t}</span>
                    <button onClick={()=>copyInvite(inv)} className="erc-ghost" style={{ ...S.btn("ghost"), padding:"5px 10px", fontSize:12 }}>Copy Link</button>
                    {inv.active && <button onClick={()=>handleRevoke(inv)} style={{ ...S.btn("danger"), padding:"5px 10px", fontSize:12 }}>Revoke</button>}
                  </div>
                ); })}
            </div>}
      </div>

      {/* Pending Registrations */}
      <div style={{ marginTop:28 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12 }}>
          <h3 style={{ fontWeight:700, color:"var(--text-primary)", fontSize:18 }}>Pending Registrations</h3>
          {pendingRegList.length>0 && <span style={{ background:"var(--gold-dim)", color:"var(--gold-bright)", borderRadius:20, padding:"1px 9px", fontSize:12, fontWeight:700 }}>{pendingRegList.length}</span>}
        </div>
        {pendingRegList.length===0
          ? <div style={{ ...glass, padding:20, color:"var(--text-muted)", fontSize:13 }}>No pending registrations.</div>
          : <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {pendingRegList.map(reg=>(
                <div key={reg.id} style={{ ...glass, padding:"12px 16px", display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
                  <div style={{ flex:1, minWidth:160 }}>
                    <div style={{ color:"var(--text-primary)", fontWeight:600 }}>{reg.fullName} <span style={{ color:"var(--text-muted)", fontWeight:400, fontFamily:"var(--font-mono)", fontSize:13 }}>@{reg.username}</span></div>
                    <div style={{ color:"var(--text-muted)", fontSize:12 }}>Requested: {reg.requestedTeam?(ctx?ctx.teamLabel(reg.requestedTeam):reg.requestedTeam):"—"} · {timeAgo(reg.submittedAt)}</div>
                  </div>
                  <button onClick={()=>setApproveReg(reg)} className="erc-prim" style={{ ...S.btn("primary"), padding:"6px 14px", fontSize:13 }}>Approve</button>
                  <button onClick={()=>setRejectReg(reg)} style={{ ...S.btn("danger"), padding:"6px 14px", fontSize:13 }}>Reject</button>
                </div>
              ))}
            </div>}
        {resolvedRegList.length>0 && (
          <div style={{ marginTop:12 }}>
            <button onClick={()=>setShowResolved(s=>!s)} style={{ background:"none", border:"none", color:"var(--text-secondary)", cursor:"pointer", fontSize:13, display:"flex", alignItems:"center", gap:6 }}>
              <span style={{ transform:showResolved?"rotate(180deg)":"none", transition:"transform .2s" }}>⌄</span> Previous requests ({resolvedRegList.length})
            </button>
            {showResolved && <div style={{ display:"flex", flexDirection:"column", gap:6, marginTop:8 }}>
              {resolvedRegList.map(reg=>{ const c=reg.status==="approved"?"#10b981":"#ef4444";
                return (
                  <div key={reg.id} style={{ ...glass, padding:"10px 14px", display:"flex", alignItems:"center", gap:10, fontSize:13, opacity:0.7 }}>
                    <span style={{ color:"var(--text-primary)", flex:1 }}>{reg.fullName} <span style={{ color:"var(--text-muted)" }}>@{reg.username}</span></span>
                    <span style={{ background:c+"22", color:c, border:"1px solid "+c+"55", borderRadius:20, padding:"2px 8px", fontSize:11, fontWeight:600 }}>{reg.status}</span>
                    {reg.reviewedBy && <span style={{ color:"var(--text-muted)", fontSize:11 }}>by {reg.reviewedBy}</span>}
                  </div>
                ); })}
            </div>}
          </div>
        )}
      </div>

      {showGenerate && <GenerateInviteModal createdBy={session.userName} onClose={()=>setShowGenerate(false)} onCreated={loadAll} toast={toast} />}
      {rejectReg && <RejectModal reg={rejectReg} onClose={()=>setRejectReg(null)} onSubmit={(reason)=>handleReject(rejectReg, reason)} />}
      {approveReg && <ApproveRegModal reg={approveReg} onClose={()=>setApproveReg(null)} onConfirm={(team)=>handleApprove(approveReg, team)} />}

      {(showAdd||editUser) && (
        <UserModal user={editUser} onSave={handleSave} onClose={()=>{ setShowAdd(false); setEditUser(null); }} />
      )}
      {resetUser && (
        <ResetPasswordModal user={resetUser} onClose={()=>setResetUser(null)}
          onSubmit={async (pw)=>{ try { await adminResetPassword(resetUser.id, pw); logAudit({ userId:session.userId, userName:session.userName, action:"password_changed", targetUserId:resetUser.id }); toast("Password reset!","success"); } catch (e) { toast(e.message,"error"); } }} />
      )}
      {showDepts && <DepartmentsModal onClose={()=>setShowDepts(false)} toast={toast} />}
    </div>
  );
}

// ─── Departments Modal (admin) ───────────────────────────────────────────────
function DepartmentsModal({ onClose, toast }) {
  const ctx = useDepts();
  const [rows, setRows] = useState(ctx ? ctx.list.map(d=>({ ...d })) : []);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(DEPT_PALETTE[0]);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (ctx) setRows(ctx.list.map(d=>({ ...d }))); }, [ctx]);

  const setRow = (id, patch) => setRows(rs => rs.map(r=>r.id===id?{ ...r, ...patch }:r));

  const add = async () => {
    const id = slugify(newName);
    if (!id) { toast("Enter a department name","error"); return; }
    if (rows.some(r=>r.id===id)) { toast("That department already exists","error"); return; }
    setBusy(true);
    try { await createDepartment({ id, label:newName.trim(), color:newColor }); toast("Department added","success"); setNewName(""); ctx.reload(); }
    catch (e) { toast(e.message.includes("does not exist")?"Run migration_3_departments.sql in Supabase first.":e.message,"error"); }
    finally { setBusy(false); }
  };
  const save = async (d) => {
    try { await updateDepartment(d.id, { label:d.label, color:d.color }); toast("Department saved","success"); ctx.reload(); }
    catch (e) { toast(e.message,"error"); }
  };
  const remove = async (d) => {
    if (!window.confirm(`Remove "${d.label}"?\nUsers and credentials that reference it keep the value but lose its colour/label.`)) return;
    try { await deleteDepartment(d.id); toast("Department removed","info"); ctx.reload(); }
    catch (e) { toast(e.message,"error"); }
  };

  return (
    <div style={S.overlay} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ ...S.modal(), padding:28, width:"90%", maxWidth:520, maxHeight:"85vh", overflowY:"auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
          <h3 style={{ fontWeight:700, fontSize:18, color:"var(--text-primary)" }}>Departments</h3>
          <button onClick={onClose} className="erc-ghost" style={{ ...S.btn("ghost"), padding:"6px 10px" }}>✕</button>
        </div>
        <p style={{ color:"var(--text-secondary)", fontSize:13, marginBottom:18 }}>Rename, recolour, add or remove departments. The “Admin” role is fixed and not listed here.</p>

        <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:18 }}>
          {rows.map(d=>(
            <div key={d.id} style={{ ...fieldBox, display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
              <div style={{ display:"flex", gap:4, flexWrap:"wrap", maxWidth:140 }}>
                {DEPT_PALETTE.map(c=>(
                  <button key={c} onClick={()=>setRow(d.id,{ color:c })} title={c}
                    style={{ width:16, height:16, borderRadius:"50%", background:c, cursor:"pointer",
                      border:d.color===c?"2px solid #fff":"2px solid transparent" }} />
                ))}
              </div>
              <input value={d.label} onChange={e=>setRow(d.id,{ label:e.target.value })} style={{ ...S.input(), flex:1, minWidth:120, padding:"6px 10px" }} />
              <button onClick={()=>save(d)} className="erc-prim" style={{ ...S.btn("primary"), padding:"6px 12px", fontSize:12 }}>Save</button>
              <button onClick={()=>remove(d)} style={{ ...S.btn("danger"), padding:"6px 10px", fontSize:12 }}>Remove</button>
            </div>
          ))}
        </div>

        <div style={{ borderTop:"1px solid var(--border-subtle)", paddingTop:16 }}>
          <label style={S.label}>Add department</label>
          <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
            <div style={{ display:"flex", gap:4, flexWrap:"wrap", maxWidth:140 }}>
              {DEPT_PALETTE.map(c=>(
                <button key={c} onClick={()=>setNewColor(c)} title={c}
                  style={{ width:16, height:16, borderRadius:"50%", background:c, cursor:"pointer", border:newColor===c?"2px solid #fff":"2px solid transparent" }} />
              ))}
            </div>
            <input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="e.g. Finance" style={{ ...S.input(), flex:1, minWidth:140, padding:"8px 12px" }} />
            <button onClick={add} disabled={busy} className="erc-prim" style={{ ...S.btn("primary"), opacity:busy?0.7:1 }}>+ Add</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Audit Log Tab ────────────────────────────────────────────────────────────
function AuditTab({ session, toast }) {
  const [audit, setAudit] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState("All");
  const [userFilter, setUserFilter] = useState("All");
  const [dateRange, setDateRange] = useState("All");
  const [search, setSearch] = useState("");

  useEffect(() => { listAudit().then(setAudit).catch(e=>toast(e.message,"error")).finally(()=>setLoading(false)); }, [toast]);

  const actionColors = {
    add:"#10b981", approve:"#10b981", add_user:"#10b981", bulk_import:"#10b981", client_created:"#10b981", user_approved_registration:"#10b981", resolve_not_working:"#10b981",
    login:"#60a5fa", view:"#60a5fa", copy:"#60a5fa", copy_verify:"#60a5fa", logout:"#60a5fa", release_in_use:"#60a5fa",
    edit:"#f59e0b", access_request:"#f59e0b", edit_user:"#f59e0b", password_changed:"#f59e0b", client_edited:"#f59e0b", bulk_import_overwrite:"#f59e0b", mark_in_use:"#f97316",
    delete:"#ef4444", deny:"#ef4444", login_failed:"#ef4444", remove_user:"#ef4444", client_archived:"#ef4444", user_rejected_registration:"#ef4444", report_not_working:"#ef4444",
  };
  const dateMs = { Today:86400000, "7d":7*86400000, "30d":30*86400000, All:Infinity };
  const now = Date.now();
  const uniqueUsers = [...new Set(audit.map(e=>e.userName).filter(Boolean))];

  const filtered = audit.filter(e=>{
    if(actionFilter!=="All"&&!e.action.includes(actionFilter.toLowerCase())) return false;
    if(userFilter!=="All"&&e.userName!==userFilter) return false;
    if(dateRange!=="All"&&(now-new Date(e.timestamp))>dateMs[dateRange]) return false;
    if(search&&!e.userName?.toLowerCase().includes(search.toLowerCase())&&!e.credentialName?.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }).slice(0,500);

  const handleExport = () => {
    const h=["Timestamp","User","Action","Credential","Target","Detail"];
    const rows=filtered.map(e=>[new Date(e.timestamp).toLocaleString(),e.userName,e.action,e.credentialName||"",e.targetUserId||"",e.detail||e.ipNote||""]);
    const ws=XLSX.utils.aoa_to_sheet([h,...rows]); const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,"Audit Log"); XLSX.writeFile(wb,"EagleRCM-Audit.xlsx"); toast("Exported!","success");
  };

  const th = { padding:"12px 14px", textAlign:"left", borderBottom:"1px solid var(--border-default)", fontWeight:600, color:"var(--text-muted)", fontSize:10, textTransform:"uppercase", letterSpacing:1.5 };
  if (loading) return <Splash text="Loading audit log…" />;

  return (
    <div className="erc-page">
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16, flexWrap:"wrap", gap:10 }}>
        <h2 style={{ fontWeight:700, color:"var(--text-primary)", fontSize:20 }}>Audit Log</h2>
        <button onClick={handleExport} className="erc-prim" style={S.btn("primary")}>📤 Export Audit Log</button>
      </div>
      <div style={toolbar}>
        <input value={search} onChange={e=>setSearch(e.target.value)} style={{ ...S.input(), maxWidth:220 }} placeholder="Search..." />
        <select value={actionFilter} onChange={e=>setActionFilter(e.target.value)} style={{ ...S.input(), width:"auto" }}>
          {["All","login","copy","edit","delete","add","request","import"].map(a=>(<option key={a}>{a}</option>))}
        </select>
        <select value={userFilter} onChange={e=>setUserFilter(e.target.value)} style={{ ...S.input(), width:"auto" }}>
          <option>All</option>{uniqueUsers.map(u=><option key={u}>{u}</option>)}
        </select>
        <select value={dateRange} onChange={e=>setDateRange(e.target.value)} style={{ ...S.input(), width:"auto" }}>
          {["Today","7d","30d","All"].map(d=><option key={d}>{d}</option>)}
        </select>
      </div>
      <div style={{ background:"var(--bg-surface)", borderRadius:14, border:"1px solid var(--border-subtle)", overflow:"hidden" }}>
        <div style={{ overflowX:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
            <thead>
              <tr style={{ background:"rgba(0,0,0,0.3)" }}>
                {["Timestamp","User","Action","Credential/Target","Detail"].map(h=>(<th key={h} style={th}>{h}</th>))}
              </tr>
            </thead>
            <tbody>
              {filtered.length===0
                ? <tr><td colSpan={5}><EmptyState icon="📋" title="No activity yet" sub="Actions will appear here as the team uses Eagle RCM" /></td></tr>
                : filtered.map((e,i)=>{ const c=actionColors[e.action]||"#8899b4";
                  return (
                    <tr key={e.id} style={{ borderBottom:"1px solid var(--border-subtle)", height:48, background:i%2?"rgba(255,255,255,0.015)":"transparent" }}>
                      <td style={{ padding:"10px 14px", color:"var(--text-muted)", whiteSpace:"nowrap", fontSize:12, fontFamily:"var(--font-mono)" }}>{new Date(e.timestamp).toLocaleString()}</td>
                      <td style={{ padding:"10px 14px" }}>
                        <span style={{ display:"inline-flex", alignItems:"center", gap:8 }}>
                          <span style={{ width:24, height:24, borderRadius:"50%", background:"var(--bg-highlight)", color:"var(--text-secondary)", display:"inline-flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:700 }}>{getInitials(e.userName)}</span>
                          <span style={{ color:"var(--text-primary)", fontWeight:600 }}>{e.userName}</span>
                        </span>
                      </td>
                      <td style={{ padding:"10px 14px" }}>
                        <span style={{ background:c+"22", color:c, border:"1px solid "+c+"44", borderRadius:20, padding:"3px 10px", fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:0.5 }}>{e.action}</span>
                      </td>
                      <td style={{ padding:"10px 14px", color:"var(--text-muted)", fontSize:12, fontStyle:"italic" }}>{e.credentialName||e.targetUserId||"—"}</td>
                      <td style={{ padding:"10px 14px", color:"var(--text-secondary)", fontSize:13, maxWidth:280, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{e.detail||e.ipNote}</td>
                    </tr>
                  ); })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Access Requests Tab ──────────────────────────────────────────────────────
function AccessRequestsTab({ session, toast, onChange }) {
  const rctx = useDepts();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [subTab, setSubTab] = useState("pending");

  const reload = useCallback(async () => {
    try { setRequests(await listRequests()); } catch (e) { toast(e.message,"error"); } finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { reload(); }, [reload]);

  const handleResolve = async (req, status) => {
    try {
      await resolveRequest(req, status, session.userName);
      logAudit({ userId:session.userId, userName:session.userName, action:status==="approved"?"approve":"deny",
        credentialId:req.credentialId, credentialName:req.credentialName, detail:(status==="approved"?"Approved":"Denied")+" access for "+req.requesterName });
      toast(status==="approved"?"Access approved!":"Request denied", status==="approved"?"success":"info");
      await reload(); onChange && onChange();
    } catch (e) { toast(e.message,"error"); }
  };

  const pendingCount = requests.filter(r=>r.status==="pending").length;
  const filtered = requests.filter(r=>r.status===subTab);
  const accent = { pending:"var(--gold-bright)", approved:"var(--success)", denied:"var(--danger)" };

  if (loading) return <Splash text="Loading requests…" />;

  return (
    <div className="erc-page">
      <h2 style={{ fontWeight:700, color:"var(--text-primary)", fontSize:20, marginBottom:16 }}>Access Requests</h2>
      <div style={{ display:"flex", gap:6, marginBottom:20 }}>
        {["pending","approved","denied"].map(t=>{ const on=subTab===t;
          return (
            <button key={t} onClick={()=>setSubTab(t)} style={{ display:"flex", alignItems:"center", gap:6, padding:"8px 16px", fontSize:13, fontWeight:600, cursor:"pointer",
              borderRadius:10, border:"1px solid "+(on?"var(--gold-bright)":"var(--border-default)"), background:on?"var(--gold-dim)":"transparent", color:on?"var(--gold-bright)":"var(--text-secondary)" }}>
              {t.charAt(0).toUpperCase()+t.slice(1)}
              {t==="pending"&&pendingCount>0&&(<span style={{ background:"var(--gold-bright)", color:"#03070f", borderRadius:"50%", minWidth:18, height:18, fontSize:10, fontWeight:800, display:"flex", alignItems:"center", justifyContent:"center", padding:"0 4px" }}>{pendingCount}</span>)}
            </button>
          ); })}
      </div>
      {filtered.length===0
        ? <EmptyState icon="🔒" title="All clear — no pending requests" sub="Team members can request access from credential cards" />
        : <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
            {filtered.map(r=>{ const st=rctx?rctx.teamStyle(r.requesterTeam):(TEAM_STYLES[r.requesterTeam]||TEAM_STYLES.engineering);
              return (
                <div key={r.id} style={{ ...S.card(), borderLeft:"3px solid "+accent[r.status] }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", flexWrap:"wrap", gap:12 }}>
                    <div style={{ display:"flex", gap:12 }}>
                      <div style={{ width:40, height:40, borderRadius:"50%", background:st.bg, color:st.color, border:"2px solid "+st.border,
                        display:"flex", alignItems:"center", justifyContent:"center", fontWeight:700, fontSize:13, flexShrink:0 }}>{getInitials(r.requesterName)}</div>
                      <div>
                        <div style={{ fontWeight:700, fontSize:15, color:"var(--text-primary)", marginBottom:4, display:"flex", alignItems:"center", gap:8 }}>
                          {r.requesterName} <TeamBadge team={r.requesterTeam} small />
                        </div>
                        <div style={{ color:"var(--text-secondary)", fontSize:13 }}>→ Requesting access to: <strong style={{ color:"var(--text-primary)" }}>{r.credentialName}</strong></div>
                        {r.message && <div style={{ marginTop:6, color:"var(--text-secondary)", fontSize:13, background:"rgba(0,0,0,0.25)", borderRadius:8, padding:"6px 10px", fontStyle:"italic" }}>"{r.message}"</div>}
                        <div style={{ fontSize:12, color:"var(--text-muted)", marginTop:6 }}>{timeAgo(r.requestedAt)}{r.resolvedBy?" · Resolved by "+r.resolvedBy:""}</div>
                      </div>
                    </div>
                    {subTab==="pending"
                      ? <div style={{ display:"flex", gap:8 }}>
                          <button onClick={()=>handleResolve(r,"approved")} className="erc-prim" style={S.btn("primary")}>Approve</button>
                          <button onClick={()=>handleResolve(r,"denied")} style={S.btn("danger")}>Deny</button>
                        </div>
                      : <span style={{ background:accent[r.status]+"22", color:accent[r.status], border:"1px solid "+accent[r.status]+"55", borderRadius:20, padding:"4px 12px", fontSize:12, fontWeight:600, height:"fit-content" }}>{r.status}</span>}
                  </div>
                </div>
              ); })}
          </div>}
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
// ── Tweaks menu: theme + layout density (segmented controls) ──
function TweaksMenu() {
  const { theme, density, setTheme, setDensity } = usePrefs();
  const [open, setOpen] = useState(false);
  const themeOpts = [["dark","🌙 Dark"],["light","☀️ Light"],["grey","🌫️ Grey"]];
  const densOpts = [["compact","Compact"],["comfortable","Comfortable"],["list","List"]];
  const Seg = ({ opts, value, onPick }) => (
    <div role="group" style={{ display:"flex", gap:4, background:"var(--track-bg)", border:"1px solid var(--border-subtle)", borderRadius:10, padding:4 }}>
      {opts.map(([val,label])=>{ const on=value===val; return (
        <button key={val} onClick={()=>onPick(val)} aria-pressed={on}
          style={{ flex:1, whiteSpace:"nowrap", padding:"6px 10px", borderRadius:7, border:"none", cursor:"pointer", fontSize:12, fontWeight:on?700:500,
            transition:"all .15s ease", background:on?"var(--bg-elevated)":"transparent", color:on?"var(--text-primary)":"var(--text-muted)",
            boxShadow:on?"var(--tab-shadow)":"none" }}>{label}</button>
      ); })}
    </div>
  );
  return (
    <div style={{ position:"relative" }}>
      <button onClick={()=>setOpen(o=>!o)} title="Tweaks" aria-label="Tweaks" aria-expanded={open}
        style={{ background:"none", border:"none", cursor:"pointer", fontSize:18, padding:0, lineHeight:1, color:"var(--text-secondary)" }}>⚙️</button>
      {open && (<>
        <div onClick={()=>setOpen(false)} style={{ position:"fixed", inset:0, zIndex:140 }} />
        <div style={{ ...dropdownPanel, right:0, left:"auto", top:"calc(100% + 10px)", minWidth:280, zIndex:150, padding:16 }}>
          <div style={{ fontSize:13, fontWeight:700, color:"var(--text-primary)", marginBottom:12 }}>Tweaks</div>
          <div style={{ ...S.label, marginBottom:6 }}>Theme</div>
          <Seg opts={themeOpts} value={theme} onPick={setTheme} />
          <div style={{ ...S.label, margin:"14px 0 6px" }}>Layout density</div>
          <Seg opts={densOpts} value={density} onPick={setDensity} />
        </div>
      </>)}
    </div>
  );
}

function Dashboard({ user, onLogout }) {
  const session = getSession();
  const [tab, setTab] = useState("credentials");
  const [showProfile, setShowProfile] = useState(false);
  const [currentUser, setCurrentUser] = useState(user);
  const [showInactivity, setShowInactivity] = useState(false);
  const [countdown, setCountdown] = useState(60);
  const [copyHistory, setCopyHistory] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingRegCount, setPendingRegCount] = useState(0);
  const [showBell, setShowBell] = useState(false);
  const [theme, setThemeState] = useState(() => readPref("erc-theme", THEMES, "dark"));
  const [density, setDensityState] = useState(() => readPref("erc-density", DENSITIES, "compact"));
  const setTheme = useCallback((t) => { setThemeState(t); try { localStorage.setItem("erc-theme", t); } catch {} }, []);
  const setDensity = useCallback((d) => { setDensityState(d); try { localStorage.setItem("erc-density", d); } catch {} }, []);
  useEffect(() => {
    const r = document.documentElement;
    r.setAttribute("data-theme", theme);
    r.setAttribute("data-density", density);
    const bg = theme==="light" ? "#f4f6fa" : theme==="grey" ? "#22272e" : "#070a10";
    r.style.background = bg; if (document.body) document.body.style.background = bg;
  }, [theme, density]);
  const prefs = useMemo(() => ({ theme, density, setTheme, setDensity }), [theme, density, setTheme, setDensity]);
  const [toasts, toast] = useToast();
  const lastActivity = useRef(Date.now());
  const warningShown = useRef(false);

  const isAdmin = session?.team==="admin";

  const [depts, setDepts] = useState(DEFAULT_DEPTS);
  const reloadDepts = useCallback(() => {
    listDepartments().then(d => { if (d && d.length) setDepts(d); }).catch(()=>{});
  }, []);
  useEffect(() => { reloadDepts(); }, [reloadDepts]);
  const deptCtx = useMemo(() => {
    const byId = Object.fromEntries(depts.map(d=>[d.id,d]));
    return {
      list: depts, byId, reload: reloadDepts,
      teamStyle: (t)=> t==="admin"?ADMIN_STYLE : (byId[t]?styleForColor(byId[t].color):FALLBACK_STYLE),
      teamLabel: (t)=> t==="admin"?"Admin":(byId[t]?byId[t].label:t),
      deptIds: depts.map(d=>d.id),
      options: ["admin", ...depts.map(d=>d.id)],
    };
  }, [depts, reloadDepts]);
  const st = deptCtx.teamStyle(currentUser.team);

  const refreshPending = useCallback(() => {
    if (!isAdmin) return;
    listRequests().then(rs => setPendingCount(rs.filter(r=>r.status==="pending").length)).catch(()=>{});
    listPendingRegistrations().then(rs => setPendingRegCount(rs.filter(r=>r.status==="pending").length)).catch(()=>{});
  }, [isAdmin]);
  useEffect(() => { refreshPending(); }, [refreshPending, tab]);

  const resetActivity = useCallback(() => {
    lastActivity.current = Date.now();
    if (warningShown.current) { warningShown.current = false; setShowInactivity(false); }
  }, []);

  useEffect(() => {
    const evts = ["click","keypress","mousemove"];
    evts.forEach(e=>window.addEventListener(e,resetActivity));
    return () => evts.forEach(e=>window.removeEventListener(e,resetActivity));
  }, [resetActivity]);

  useEffect(() => {
    const iv = setInterval(() => {
      const idle = Date.now() - lastActivity.current;
      if (idle >= 15*60000) { clearInterval(iv); onLogout(); return; }
      if (idle >= 14*60000 && !warningShown.current) { warningShown.current = true; setShowInactivity(true); setCountdown(Math.ceil((15*60000-idle)/1000)); }
      else if (idle >= 14*60000 && warningShown.current) { setCountdown(Math.ceil((15*60000-idle)/1000)); }
    }, 1000);
    return () => clearInterval(iv);
  }, [onLogout]);

  const TABS = isAdmin ? ["credentials","clients","users","audit","requests"] : ["credentials"];
  const TAB_LABELS = { credentials:"Credentials", clients:"Clients", users:"Users", audit:"Audit Log", requests:"Access Requests" };

  const tabRefs = useRef({});
  const [underline, setUnderline] = useState({ left:0, width:0 });
  useEffect(() => {
    const el = tabRefs.current[tab];
    if (el) setUnderline({ left: el.offsetLeft, width: el.offsetWidth });
  }, [tab, isAdmin, pendingCount]);

  const gridBg = {
    minHeight:"100vh", background:"transparent",
    backgroundImage:"radial-gradient(circle at 1px 1px, var(--page-dot) 1px, transparent 0)",
    backgroundSize:"32px 32px",
  };

  return (
    <PrefsContext.Provider value={prefs}>
    <DeptContext.Provider value={deptCtx}>
    <div style={gridBg}>
      <GlobalStyles />
      <ToastContainer toasts={toasts} />

      <header style={{ background:"var(--header-bg)", backdropFilter:"blur(20px)", WebkitBackdropFilter:"blur(20px)",
        padding:"0 24px", height:64, display:"flex", alignItems:"center", justifyContent:"space-between",
        position:"sticky", top:0, zIndex:100, borderBottom:"1px solid var(--border-subtle)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:9 }}>
          <span className="erc-logo-gold" style={{ fontWeight:900, fontSize:16, letterSpacing:1.5 }}>EAGLE</span>
          <span style={{ width:1, height:15, background:"var(--border-strong)" }} />
          <span style={{ color:"var(--text-primary)", fontWeight:300, fontSize:16, letterSpacing:3 }}>RCM</span>
        </div>

        {TABS.length>1 && (
          <div style={{ position:"relative", display:"flex", gap:4, background:"var(--track-bg)", border:"1px solid var(--border-subtle)", borderRadius:12, padding:4 }}>
            {TABS.map(t=>{ const on=tab===t;
              return (
                <button key={t} ref={el=>{ tabRefs.current[t]=el; }} onClick={()=>setTab(t)} style={{ display:"flex", alignItems:"center", gap:6, padding:"6px 14px", fontSize:13, fontWeight:on?600:500, cursor:"pointer",
                  borderRadius:9, border:"none", transition:"all 0.2s ease",
                  background:on?"var(--bg-elevated)":"transparent", color:on?"var(--text-primary)":"var(--text-muted)",
                  boxShadow:on?"var(--tab-shadow)":"none" }}>
                  {TAB_LABELS[t]}
                  {t==="requests"&&pendingCount>0&&(<span style={{ width:6, height:6, borderRadius:"50%", background:"var(--gold-bright)" }} />)}
                  {t==="users"&&pendingRegCount>0&&(<span style={{ width:6, height:6, borderRadius:"50%", background:"var(--gold-bright)" }} />)}
                </button>
              ); })}
            <div style={{ position:"absolute", bottom:1, height:2, borderRadius:2, background:"var(--gold-bright)", left:underline.left, width:underline.width,
              transition:"left 0.25s cubic-bezier(0.4,0,0.2,1), width 0.25s cubic-bezier(0.4,0,0.2,1)", pointerEvents:"none" }} />
          </div>
        )}

        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          {isAdmin && (pendingCount>0 || pendingRegCount>0) && (
            <div style={{ position:"relative" }}>
              <button onClick={()=>setShowBell(b=>!b)} style={{ position:"relative", fontSize:18, background:"none", border:"none", cursor:"pointer", padding:0, lineHeight:1 }}>🔔
                <span style={{ position:"absolute", top:-4, right:-6, minWidth:15, height:15, padding:"0 3px", borderRadius:8, background:"var(--gold-bright)", color:"#03070f", fontSize:9, fontWeight:800, display:"flex", alignItems:"center", justifyContent:"center" }}>{pendingCount+pendingRegCount}</span>
              </button>
              {showBell && (
                <>
                  <div onClick={()=>setShowBell(false)} style={{ position:"fixed", inset:0, zIndex:140 }} />
                  <div style={{ ...dropdownPanel, right:0, left:"auto", top:"calc(100% + 10px)", minWidth:240, zIndex:150 }}>
                    {pendingRegCount>0 && (
                      <button onClick={()=>{ setTab("users"); setShowBell(false); }} style={{ width:"100%", textAlign:"left", background:"none", border:"none", color:"var(--text-primary)", cursor:"pointer", padding:"10px 12px", borderRadius:8, fontSize:13 }}>
                        🧑 {pendingRegCount} registration request{pendingRegCount===1?"":"s"} pending
                      </button>
                    )}
                    {pendingCount>0 && (
                      <button onClick={()=>{ setTab("requests"); setShowBell(false); }} style={{ width:"100%", textAlign:"left", background:"none", border:"none", color:"var(--text-primary)", cursor:"pointer", padding:"10px 12px", borderRadius:8, fontSize:13 }}>
                        🔑 {pendingCount} access request{pendingCount===1?"":"s"} pending
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
          <TweaksMenu />
          <div style={{ width:1, height:28, background:"var(--border-subtle)" }} />
          <button onClick={()=>setShowProfile(p=>!p)} style={{ background:st.bg, color:st.color, border:"2px solid "+st.border,
            borderRadius:"50%", width:36, height:36, cursor:"pointer", fontWeight:700, fontSize:13, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>{currentUser.avatar}</button>
          <div style={{ lineHeight:1.3 }}>
            <div style={{ fontSize:13, fontWeight:600, color:"var(--text-primary)" }}>{currentUser.name}</div>
            <div style={{ fontSize:11, color:"var(--text-muted)", textTransform:"capitalize" }}>{session?.team}</div>
          </div>
          <button onClick={onLogout} className="erc-ghost" style={{ ...S.btn("ghost"), padding:"7px 14px", fontSize:12 }}>Sign Out</button>
        </div>
      </header>

      <main style={{ maxWidth:1280, margin:"0 auto", padding:28 }}>
        <div key={tab} className="erc-tabin">
          {tab==="credentials" && <CredentialsTab session={session} toast={toast} />}
          {tab==="clients"&&isAdmin && <ClientsTab session={session} toast={toast} />}
          {tab==="users"&&isAdmin && <UsersTab session={session} toast={toast} onPendingChange={refreshPending} />}
          {tab==="audit"&&isAdmin && <AuditTab session={session} toast={toast} />}
          {tab==="requests"&&isAdmin && <AccessRequestsTab session={session} toast={toast} onChange={refreshPending} />}
        </div>
      </main>

      {showProfile && (
        <>
          <div onClick={()=>setShowProfile(false)} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.4)", zIndex:499 }} />
          <ProfilePanel session={session} currentUser={currentUser} onClose={()=>setShowProfile(false)}
            onUserUpdate={u=>setCurrentUser(u)} toast={toast} copyHistory={copyHistory} />
        </>
      )}

      {showInactivity && <InactivityModal countdown={countdown} onStay={()=>{ resetActivity(); }} onLogout={onLogout} />}
    </div>
    </DeptContext.Provider>
    </PrefsContext.Provider>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function EagleRCM() {
  const [stage, setStage] = useState({ name:"loading" });

  useEffect(() => {
    (async () => {
      if (!isSupabaseConfigured) { setStage({ name:"unconfigured" }); return; }
      const invite = new URLSearchParams(window.location.search).get("invite");
      if (invite) { setStage({ name:"register", token:invite }); return; }
      try {
        const { data } = await supabase.auth.getSession();
        if (data.session) {
          const user = await getMyProfile();
          if (user && user.active !== false) {
            setSession({ userId:user.id, userName:user.name, team:user.team, loginAt:new Date().toISOString(), lastActivityAt:new Date().toISOString() });
            setStage({ name:"dashboard", user });
            return;
          }
          if (user && user.active === false) { try { await supabase.auth.signOut(); } catch { /* ignore */ } }
        }
      } catch { /* fall through to login */ }
      setStage({ name:"login" });
    })();
  }, []);

  const backToLogin = () => {
    try { const url = new URL(window.location.href); url.searchParams.delete("invite"); window.history.replaceState({}, "", url.pathname + url.search); } catch { /* ignore */ }
    setStage({ name:"login" });
  };

  const handleLogin = ({ stage:s, user }) => {
    if (s==="totp") setStage({ name:"totp", user });
    else setStage({ name:"dashboard", user });
  };

  const handleLogout = useCallback(async () => {
    const sess = getSession();
    if (sess) logAudit({ userId:sess.userId, userName:sess.userName, action:"logout" });
    clearSession();
    try { await supabase.auth.signOut(); } catch { /* ignore */ }
    setStage({ name:"login" });
  }, []);

  if (stage.name==="loading") return <><GlobalStyles /><Splash text="Starting Eagle RCM…" /></>;
  if (stage.name==="unconfigured") return (
    <><GlobalStyles />
    <div style={{ minHeight:"100vh", background:"var(--bg-void)", display:"flex", alignItems:"center", justifyContent:"center", padding:24 }}>
      <div style={{ ...glass, padding:32, maxWidth:480 }}>
        <h2 style={{ color:"var(--gold-bright)", marginBottom:12 }}>Backend not configured</h2>
        <p style={{ fontSize:14, color:"var(--text-secondary)", lineHeight:1.6 }}>
          Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to a
          <code> .env.local</code> file (see <code>SETUP.md</code>), then restart the dev server.
        </p>
      </div>
    </div></>
  );
  if (stage.name==="register") return <><GlobalStyles /><RegistrationScreen token={stage.token} onBackToLogin={backToLogin} /></>;
  if (stage.name==="login") return <><GlobalStyles /><LoginScreen onLogin={handleLogin} /></>;
  if (stage.name==="totp") return <><GlobalStyles /><TOTPScreen user={stage.user} onVerify={u=>setStage({ name:"dashboard", user:u })} onBack={()=>setStage({ name:"login" })} /></>;
  if (stage.name==="dashboard") return <Dashboard user={stage.user} onLogout={handleLogout} />;
  return null;
}
