import React, { useState, useEffect, useRef, useCallback } from "react";
import * as XLSX from "xlsx";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { supabase, isSupabaseConfigured, usernameToEmail } from "./lib/supabase";
import {
  getMyProfile, touchLastLogin, updateProfile,
  listCredentials, createCredential, updateCredential, patchCredential, deleteCredential, bulkCreateCredentials,
  listUsers, logAudit, listAudit, createRequest, listRequests, resolveRequest,
  listFavourites, toggleFavourite, adminCreateUser, adminResetPassword, adminDeleteUser,
} from "./lib/db";

// ─── Constants ───────────────────────────────────────────────────────────────
const SS_KEY = "vault_session";
const TEAMS = ["admin","engineering","marketing","design","ops"];
const TEAM_STYLES = {
  admin:       { bg:"#fef3c7", color:"#92400e", border:"#fde68a" },
  engineering: { bg:"#dbeafe", color:"#1e40af", border:"#bfdbfe" },
  marketing:   { bg:"#fce7f3", color:"#9d174d", border:"#fbcfe8" },
  design:      { bg:"#ede9fe", color:"#6d28d9", border:"#ddd6fe" },
  ops:         { bg:"#dcfce7", color:"#166534", border:"#bbf7d0" },
};
const CAT_ICONS = {
  Development:"💻", Infrastructure:"🔧", Design:"🎨", Marketing:"📣",
  Communication:"💬", Default:"🔑",
};
const AUTH_METHODS = ["None","Text","Auth","Email"];
const AUTH_META = {
  Text:  { icon:"💬", label:"Text (SMS)",   bg:"#dbeafe", color:"#1e40af", border:"#bfdbfe" },
  Auth:  { icon:"🔑", label:"Auth (App)",   bg:"#ede9fe", color:"#6d28d9", border:"#ddd6fe" },
  Email: { icon:"✉️", label:"Email (Code)", bg:"#dcfce7", color:"#166534", border:"#bbf7d0" },
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
const fmtHm = (s) => { // "09:00" -> "9am", "17:30" -> "5:30pm"
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

// Evaluate a credential's time restriction against the current moment.
// Returns { state, label?, note? }. state ∈ none|active|outside|wrongday|expired|expiring|schedule
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

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = {
  btn: (variant, extra) => {
    const base = { padding:"8px 16px", borderRadius:8, border:"none", cursor:"pointer",
      fontWeight:600, fontSize:14, transition:"all 0.15s", display:"inline-flex",
      alignItems:"center", gap:4 };
    const variants = {
      primary: { background:"linear-gradient(135deg,#f59e0b,#d97706)", color:"#fff" },
      danger:  { background:"#fee2e2", color:"#dc2626", border:"1px solid #fca5a5" },
      ghost:   { background:"transparent", color:"#64748b", border:"1px solid #e5e9f0" },
      secondary:{ background:"#f1f5f9", color:"#334155", border:"1px solid #e5e9f0" },
    };
    return { ...base, ...(variants[variant || "secondary"] || variants.secondary), ...(extra||{}) };
  },
  card: (extra) => ({ background:"#fff", borderRadius:14, border:"1px solid #e5e9f0",
    padding:20, transition:"box-shadow 0.2s", ...(extra||{}) }),
  input: (extra) => ({ width:"100%", padding:"10px 14px", borderRadius:8,
    border:"1px solid #e5e9f0", fontSize:14, color:"#0f172a", background:"#f8fafc",
    outline:"none", fontFamily:"inherit", boxSizing:"border-box", ...(extra||{}) }),
  label: { fontSize:13, fontWeight:600, color:"#475569", marginBottom:4, display:"block" },
  overlay: { position:"fixed", inset:0, background:"rgba(10,15,30,0.6)", zIndex:1000,
    display:"flex", alignItems:"center", justifyContent:"center", padding:16 },
};

// ─── Toast ────────────────────────────────────────────────────────────────────
function ToastContainer({ toasts }) {
  return (
    <div style={{ position:"fixed", top:20, right:20, zIndex:9999, display:"flex", flexDirection:"column", gap:8 }}>
      {toasts.map(t => (
        <div key={t.id} style={{ padding:"12px 20px", borderRadius:10, fontWeight:500, fontSize:14,
          color:"#fff", minWidth:260, boxShadow:"0 4px 16px rgba(0,0,0,0.15)",
          background: t.type==="success"?"#16a34a":t.type==="error"?"#dc2626":"#2563eb",
          animation:"slideIn 0.2s ease" }}>{t.msg}</div>
      ))}
    </div>
  );
}
function useToast() {
  const [toasts, setToasts] = useState([]);
  const toast = useCallback((msg, type) => {
    const id = Math.random().toString(36).slice(2);
    setToasts(p => [...p, { id, msg, type:type||"info" }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3500);
  }, []);
  return [toasts, toast];
}

// ─── Password Strength Bar ────────────────────────────────────────────────────
function StrengthBar({ password }) {
  const s = pwStrength(password || "");
  const colors = ["#dc2626","#dc2626","#f59e0b","#f59e0b","#16a34a"];
  const labels = ["","Weak","Weak","Fair","Good","Strong"];
  if (!password) return null;
  return (
    <div style={{ marginTop:6 }}>
      <div style={{ display:"flex", gap:4, marginBottom:4 }}>
        {[1,2,3,4,5].map(i => (
          <div key={i} style={{ flex:1, height:4, borderRadius:2, background: i<=s ? colors[s-1] : "#e5e9f0" }} />
        ))}
      </div>
      <div style={{ fontSize:12, color:colors[s-1]||"#94a3b8" }}>{labels[s]||""}</div>
    </div>
  );
}

// ─── Team Badge ───────────────────────────────────────────────────────────────
function TeamBadge({ team, small }) {
  const st = TEAM_STYLES[team] || { bg:"#f1f5f9", color:"#64748b", border:"#e5e9f0" };
  return (
    <span style={{ background:st.bg, color:st.color, border:"1px solid "+st.border,
      borderRadius:20, padding:small?"2px 8px":"3px 10px",
      fontSize:small?11:12, fontWeight:600, display:"inline-block" }}>{team}</span>
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

  const isLocalhost = ["localhost","127.0.0.1"].includes(window.location.hostname);
  const DEMO = [
    { role:"Admin", username:"alex", password:"Admin@123!" },
    { role:"Engineering", username:"sam", password:"Eng@123!" },
    { role:"Marketing", username:"morgan", password:"Mkt@123!" },
    { role:"Design", username:"jordan", password:"Des@123!" },
    { role:"Ops", username:"casey", password:"Ops@123!" },
  ];

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      const { error: authErr } = await supabase.auth.signInWithPassword({
        email: usernameToEmail(username), password,
      });
      if (authErr) {
        const n = attempts + 1; setAttempts(n);
        setError(n >= 5 ? "Too many failed attempts. Please wait a moment and try again." :
          `Invalid username or password. ${5 - n} attempt(s) before a cooldown.`);
        return;
      }
      const user = await getMyProfile();
      if (!user) { setError("Your account has no profile. Contact an admin."); await supabase.auth.signOut(); return; }
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

  const darkInput = { ...S.input(), background:"rgba(255,255,255,0.05)", color:"#fff",
    border:"1px solid rgba(255,255,255,0.12)" };

  return (
    <div style={{ minHeight:"100vh", background:"#060d1a", display:"flex",
      alignItems:"center", justifyContent:"center", flexDirection:"column", padding:20 }}>
      <div style={{ background:"#0f1a2e", borderRadius:20, padding:40, width:"100%", maxWidth:420,
        boxShadow:"0 20px 60px rgba(0,0,0,0.5)", border:"1px solid rgba(245,158,11,0.15)" }}>
        <div style={{ textAlign:"center", marginBottom:32 }}>
          <div style={{ fontSize:40, marginBottom:8 }}>🔐</div>
          <h1 style={{ color:"#fff", fontSize:26, fontWeight:700, letterSpacing:-0.5 }}>VaultAccess</h1>
          <p style={{ color:"#64748b", fontSize:14, marginTop:4 }}>Secure credential management</p>
        </div>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom:16 }}>
            <label style={{ ...S.label, color:"#94a3b8" }}>Username</label>
            <input value={username} onChange={e=>setUsername(e.target.value)}
              style={darkInput} placeholder="Enter username" autoFocus />
          </div>
          <div style={{ marginBottom:20, position:"relative" }}>
            <label style={{ ...S.label, color:"#94a3b8" }}>Password</label>
            <input type={showPw?"text":"password"} value={password} onChange={e=>setPassword(e.target.value)}
              style={{ ...darkInput, paddingRight:44 }} placeholder="Enter password" />
            <button type="button" onClick={()=>setShowPw(p=>!p)}
              style={{ position:"absolute", right:12, top:32, background:"none", border:"none",
                cursor:"pointer", color:"#64748b", fontSize:16, padding:0 }}>{showPw?"🙈":"👁"}</button>
          </div>
          {error && <div style={{ background:"rgba(220,38,38,0.1)", border:"1px solid rgba(220,38,38,0.3)",
            color:"#fca5a5", borderRadius:8, padding:"10px 14px", fontSize:13, marginBottom:16 }}>{error}</div>}
          <button type="submit" disabled={busy} style={{ ...S.btn("primary"), width:"100%", padding:"12px",
            fontSize:16, justifyContent:"center", opacity:busy?0.7:1 }}>{busy?"Signing in…":"Sign In"}</button>
        </form>
      </div>

      {isLocalhost && (
        <div style={{ marginTop:24, background:"#0f1a2e", borderRadius:16, padding:24,
          width:"100%", maxWidth:520, border:"1px solid rgba(245,158,11,0.2)" }}>
          <h3 style={{ color:"#f59e0b", fontSize:14, fontWeight:700, marginBottom:12 }}>Demo Logins (dev only)</h3>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
            <thead><tr>
              {["Role","Username","Password"].map(h=>(
                <th key={h} style={{ color:"#64748b", fontWeight:600, textAlign:"left",
                  padding:"6px 8px", borderBottom:"1px solid rgba(255,255,255,0.08)" }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {DEMO.map(d=>(
                <tr key={d.username}>
                  <td style={{ color:"#94a3b8", padding:"6px 8px" }}>{d.role}</td>
                  <td style={{ color:"#e2e8f0", padding:"6px 8px", fontFamily:"monospace" }}>{d.username}</td>
                  <td style={{ color:"#e2e8f0", padding:"6px 8px", fontFamily:"monospace" }}>{d.password}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
    const totp = new OTPAuth.TOTP({ issuer:"VaultAccess", label:user.username,
      algorithm:"SHA1", digits:6, period:30, secret });
    if (totp.validate({ token:code.trim(), window:1 }) === null) { setError("Invalid code. Please try again."); return; }
    setSession({ userId:user.id, userName:user.name, team:user.team,
      loginAt:new Date().toISOString(), lastActivityAt:new Date().toISOString() });
    logAudit({ userId:user.id, userName:user.name, action:"login" });
    onVerify(user);
  };
  const back = async () => { await supabase.auth.signOut(); onBack(); };

  return (
    <div style={{ minHeight:"100vh", background:"#060d1a", display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
      <div style={{ background:"#0f1a2e", borderRadius:20, padding:40, width:"100%", maxWidth:380,
        boxShadow:"0 20px 60px rgba(0,0,0,0.5)", border:"1px solid rgba(245,158,11,0.15)" }}>
        <div style={{ textAlign:"center", marginBottom:24 }}>
          <div style={{ fontSize:32, marginBottom:8 }}>🔒</div>
          <h2 style={{ color:"#fff", fontSize:20, fontWeight:700 }}>Two-Factor Authentication</h2>
          <p style={{ color:"#64748b", fontSize:13, marginTop:6 }}>Enter the 6-digit code from your authenticator app</p>
        </div>
        <input value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,"").slice(0,6))}
          style={{ ...S.input(), background:"rgba(255,255,255,0.05)", color:"#fff",
            border:"1px solid rgba(255,255,255,0.12)", textAlign:"center", fontSize:24, letterSpacing:8, marginBottom:12 }}
          placeholder="000000" maxLength={6} />
        {error && <div style={{ color:"#fca5a5", fontSize:13, marginBottom:12, textAlign:"center" }}>{error}</div>}
        <button onClick={handleVerify} style={{ ...S.btn("primary"), width:"100%", padding:12, fontSize:15, marginBottom:12, justifyContent:"center" }}>Verify</button>
        <button onClick={back} style={{ background:"none", border:"none", cursor:"pointer", color:"#64748b", fontSize:13, width:"100%", textAlign:"center" }}>← Back to login</button>
      </div>
    </div>
  );
}

// ─── Inactivity Modal ─────────────────────────────────────────────────────────
function InactivityModal({ countdown, onStay, onLogout }) {
  return (
    <div style={S.overlay}>
      <div style={{ background:"#fff", borderRadius:16, padding:32, maxWidth:380, width:"90%", textAlign:"center" }}>
        <div style={{ fontSize:40, marginBottom:12 }}>⏰</div>
        <h3 style={{ fontSize:18, fontWeight:700, color:"#0f172a", marginBottom:8 }}>Session Expiring</h3>
        <p style={{ color:"#64748b", marginBottom:20, fontSize:14 }}>
          You will be logged out in <strong style={{ color:"#dc2626" }}>{countdown}s</strong> due to inactivity.
        </p>
        <div style={{ display:"flex", gap:10, justifyContent:"center" }}>
          <button onClick={onStay} style={S.btn("primary")}>Stay Logged In</button>
          <button onClick={onLogout} style={S.btn("danger")}>Log Out</button>
        </div>
      </div>
    </div>
  );
}

// ─── Credential Card ──────────────────────────────────────────────────────────
function CredentialCard({ cred, session, onEdit, onDelete, onCopy, onCopyVerify, onFavToggle, isFav,
  requests, onRequestAccess, toast, onPatch }) {
  const [showPw, setShowPw] = useState(false);
  const hasAccess = canAccess(cred, session.team);
  const isAdmin = session.team === "admin";
  const age = daysSince(cred.updatedAt);
  const ageColor = age < 30 ? "#16a34a" : age < 60 ? "#f59e0b" : "#dc2626";
  const catIcon = CAT_ICONS[cred.category] || CAT_ICONS.Default;
  const pendingReq = requests.find(r => r.credentialId===cred.id && r.requesterId===session.userId && r.status==="pending");
  const expiryDays = cred.passwordExpiryDays || 90;
  const daysLeft = expiryDays - age;

  // Time restriction — evaluated every render against the current moment.
  const tr = evalTimeRestriction(cred.timeRestriction);
  const lockedByTime = tr.state === "expired";
  const cardExtra =
    tr.state === "expired" ? { borderLeft:"4px solid #ef4444", background:"rgba(239,68,68,0.04)" } :
    (tr.state === "outside" || tr.state === "wrongday" || tr.state === "expiring") ? { borderLeft:"4px solid #f59e0b" } : {};

  const hasVerify = !!(cred.verifyEmail || cred.verifyText || cred.verifyAuth);

  const handleCopyField = (value, field) => {
    if (!hasAccess || lockedByTime) return;
    navigator.clipboard.writeText(value).then(() => {
      onCopy && onCopy(cred, field);
      toast && toast(field + " copied!", "success");
    });
  };
  const handleCopyVerify = (value, field) => {
    if (!hasAccess || lockedByTime) return;
    navigator.clipboard.writeText(value).then(() => {
      onCopyVerify && onCopyVerify(cred, field);
      toast && toast(field + " copied!", "success");
    });
  };

  return (
    <div style={{ ...S.card(), ...cardExtra, display:"flex", flexDirection:"column", gap:12 }}>
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:8 }}>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4, flexWrap:"wrap" }}>
            <span style={{ fontSize:18 }}>{catIcon}</span>
            <span style={{ fontWeight:700, fontSize:15, color:"#0f172a" }}>{cred.portal}</span>
            {cred.needsRotation && (
              <span style={{ background:"#fee2e2", color:"#dc2626", border:"1px solid #fca5a5",
                borderRadius:20, padding:"2px 8px", fontSize:11, fontWeight:700 }}>Needs Rotation</span>
            )}
          </div>
          {cred.url && (
            <a href={"https://"+cred.url} target="_blank" rel="noreferrer"
              style={{ color:"#64748b", fontSize:12, textDecoration:"none" }}>🔗 {cred.url}</a>
          )}
          {cred.client && (
            <div style={{ marginTop:3 }}>
              <span style={{ background:"#f0f4ff", color:"#3b52a0", border:"1px solid #c7d2fe",
                borderRadius:20, padding:"2px 9px", fontSize:11, fontWeight:600 }}>🏢 {cred.client}</span>
            </div>
          )}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
          <span style={{ background:"#f1f5f9", color:"#64748b", borderRadius:20, padding:"3px 10px", fontSize:11, fontWeight:600 }}>{cred.category}</span>
          <button onClick={()=>onFavToggle(cred.id)}
            style={{ background:"none", border:"none", cursor:"pointer", fontSize:20, color:isFav?"#f59e0b":"#d1d5db", padding:0 }}>★</button>
        </div>
      </div>

      {/* Time-restriction status */}
      {tr.state==="active" && (
        <span style={{ alignSelf:"flex-start", background:"#dcfce7", color:"#166534", border:"1px solid #bbf7d0",
          borderRadius:20, padding:"2px 10px", fontSize:11, fontWeight:700 }}>🟢 Active now</span>
      )}
      {tr.state==="schedule" && tr.note && (
        <span style={{ alignSelf:"flex-start", background:"#eff6ff", color:"#1e40af", border:"1px solid #bfdbfe",
          borderRadius:20, padding:"3px 10px", fontSize:11, fontWeight:600 }}>ℹ️ {tr.note}</span>
      )}
      {(tr.state==="outside" || tr.state==="wrongday" || tr.state==="expiring") && (
        <div style={{ background:"#fffbeb", border:"1px solid #fde68a", color:"#92400e",
          borderRadius:8, padding:"8px 12px", fontSize:12, fontWeight:600 }}>
          {tr.state==="expiring" ? "⚠️" : "⏰"} {tr.label}
        </div>
      )}
      {tr.state==="expired" && (
        <div style={{ background:"#fef2f2", border:"1px solid #fecaca", color:"#b91c1c",
          borderRadius:8, padding:"8px 12px", fontSize:12, fontWeight:600 }}>
          🔴 {tr.label}
        </div>
      )}

      <div style={{ background:"#f8fafc", borderRadius:8, padding:"8px 12px" }}>
        <div style={{ fontSize:11, color:"#94a3b8", marginBottom:2, fontWeight:600 }}>USERNAME</div>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8 }}>
          <code style={{ fontSize:13, color:"#0f172a", fontFamily:"'JetBrains Mono',monospace", wordBreak:"break-all", flex:1 }}>{cred.username}</code>
          {hasAccess && (
            <button onClick={()=>handleCopyField(cred.username,"Username")} disabled={lockedByTime}
              style={{ ...S.btn("ghost"), padding:"4px 10px", fontSize:12, flexShrink:0, opacity:lockedByTime?0.4:1, cursor:lockedByTime?"not-allowed":"pointer" }}>Copy</button>
          )}
        </div>
      </div>

      <div style={{ background:"#f8fafc", borderRadius:8, padding:"8px 12px" }}>
        <div style={{ fontSize:11, color:"#94a3b8", marginBottom:2, fontWeight:600 }}>PASSWORD</div>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8 }}>
          {hasAccess ? (
            <code style={{ fontSize:13, color:"#0f172a", fontFamily:"'JetBrains Mono',monospace", flex:1, wordBreak:"break-all" }}>
              {showPw ? cred.password : "•".repeat(Math.min(cred.password.length, 16))}
            </code>
          ) : (
            <span style={{ fontSize:13, color:"#94a3b8", flex:1 }}>No access</span>
          )}
          {hasAccess && (
            <div style={{ display:"flex", gap:4, flexShrink:0 }}>
              <button onClick={()=>setShowPw(p=>!p)} disabled={lockedByTime} style={{ ...S.btn("ghost"), padding:"4px 8px", fontSize:12, opacity:lockedByTime?0.4:1, cursor:lockedByTime?"not-allowed":"pointer" }}>{showPw?"Hide":"Show"}</button>
              <button onClick={()=>handleCopyField(cred.password,"Password")} disabled={lockedByTime} style={{ ...S.btn("ghost"), padding:"4px 10px", fontSize:12, opacity:lockedByTime?0.4:1, cursor:lockedByTime?"not-allowed":"pointer" }}>Copy</button>
            </div>
          )}
        </div>
      </div>

      {hasVerify && (
        <div style={{ background:"#f0f4f8", borderRadius:8, padding:"8px 12px", display:"flex", flexDirection:"column", gap:8 }}>
          <div style={{ fontSize:11, color:"#94a3b8", fontWeight:600 }}>VERIFICATION</div>
          {[["📧","Email verification",cred.verifyEmail],["💬","Text verification",cred.verifyText],["🔐","Auth verification",cred.verifyAuth]]
            .filter(([,,v])=>v).map(([icon,field,value])=>(
            <div key={field} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8 }}>
              <code style={{ fontSize:13, color:"#0f172a", fontFamily:"'JetBrains Mono',monospace", wordBreak:"break-all", flex:1 }}>{icon} {value}</code>
              {hasAccess && (
                <button onClick={()=>handleCopyVerify(value, field)} disabled={lockedByTime}
                  style={{ ...S.btn("ghost"), padding:"4px 10px", fontSize:12, flexShrink:0, opacity:lockedByTime?0.4:1, cursor:lockedByTime?"not-allowed":"pointer" }}>Copy</button>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ display:"flex", alignItems:"center", gap:6, fontSize:12, flexWrap:"wrap" }}>
        <span style={{ width:8, height:8, borderRadius:"50%", background:ageColor, display:"inline-block" }}/>
        <span style={{ color:ageColor, fontWeight:600 }}>{age}d old</span>
        <span style={{ color:"#94a3b8" }}>·</span>
        <span style={{ color:daysLeft<=0?"#dc2626":daysLeft<=7?"#f59e0b":"#94a3b8" }}>
          {daysLeft<=0 ? "Expired" : daysLeft+"d until expiry"}
        </span>
      </div>

      <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
        {cred.teams==="all"
          ? <span style={{ background:"#f0fdf4", color:"#166534", border:"1px solid #bbf7d0", borderRadius:20, padding:"2px 8px", fontSize:11, fontWeight:600 }}>All Teams</span>
          : (cred.teams||[]).map(t=><TeamBadge key={t} team={t} small />)}
      </div>

      <div style={{ fontSize:11, color:"#94a3b8", borderTop:"1px solid #f1f5f9", paddingTop:8 }}>
        Added {timeAgo(cred.addedAt)} by {cred.addedBy}
      </div>

      {isAdmin && (
        <div style={{ display:"flex", gap:6, flexWrap:"wrap", borderTop:"1px solid #f1f5f9", paddingTop:8 }}>
          <button onClick={()=>onEdit(cred)} style={{ ...S.btn("ghost"), padding:"4px 10px", fontSize:12 }}>✏️ Edit</button>
          <button onClick={()=>onDelete(cred)} style={{ ...S.btn("danger"), padding:"4px 10px", fontSize:12 }}>🗑️ Delete</button>
          <button onClick={()=>onPatch(cred.id,{ needsRotation:!cred.needsRotation })}
            style={{ ...S.btn("ghost"), padding:"4px 10px", fontSize:12, color:cred.needsRotation?"#dc2626":"#64748b" }}>
            🔄 {cred.needsRotation?"Clear Rotation":"Flag Rotation"}
          </button>
          <select value={cred.passwordExpiryDays||90} onChange={e=>onPatch(cred.id,{ passwordExpiryDays:+e.target.value })}
            style={{ ...S.input(), width:"auto", padding:"4px 8px", fontSize:12 }}>
            {[30,60,90,180].map(d=><option key={d} value={d}>{d}d expiry</option>)}
          </select>
          {cred.timeRestriction && cred.timeRestriction.enabled && (
            <button onClick={()=>onPatch(cred.id,{ timeRestriction:null })}
              style={{ ...S.btn("ghost"), padding:"4px 10px", fontSize:12, color:"#b91c1c" }}>⏱️ Clear restriction</button>
          )}
        </div>
      )}

      {!hasAccess && session.team!=="admin" && (
        <div style={{ borderTop:"1px solid #f1f5f9", paddingTop:8 }}>
          {pendingReq
            ? <span style={{ background:"#fef3c7", color:"#92400e", border:"1px solid #fde68a", borderRadius:20, padding:"4px 12px", fontSize:12, fontWeight:600 }}>Request Pending</span>
            : <button onClick={()=>onRequestAccess(cred)} style={{ ...S.btn("ghost"), fontSize:12, color:"#2563eb", borderColor:"#bfdbfe" }}>🔑 Request Access</button>}
        </div>
      )}
    </div>
  );
}

// ─── Credential Modal ─────────────────────────────────────────────────────────
function CredModal({ cred, onSave, onClose, session }) {
  const [form, setForm] = useState(cred
    ? { verifyEmail:"", verifyText:"", verifyAuth:"", timeRestriction:null, ...cred }
    : { portal:"", url:"", username:"", password:"", category:"Development",
        teams:[], passwordExpiryDays:90, needsRotation:false, rotationNote:"", client:"",
        authMethod:"None", authLocation:"",
        verifyEmail:"", verifyText:"", verifyAuth:"", timeRestriction:null });
  const [teamsAll, setTeamsAll] = useState(!!(cred && cred.teams==="all"));
  const [selTeams, setSelTeams] = useState(cred && Array.isArray(cred.teams) ? cred.teams : []);
  const [busy, setBusy] = useState(false);
  const [showVerify, setShowVerify] = useState(!!(cred && (cred.verifyEmail || cred.verifyText || cred.verifyAuth)));
  const [showTime, setShowTime] = useState(!!(cred && cred.timeRestriction && cred.timeRestriction.enabled));
  const set = (k,v) => setForm(p=>({...p,[k]:v}));
  const toggleTeam = t => setSelTeams(p => p.includes(t)?p.filter(x=>x!==t):[...p,t]);

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

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.portal.trim()||!form.username.trim()||!form.password.trim()) return;
    setBusy(true);
    try {
      const timeRestriction = (form.timeRestriction && form.timeRestriction.enabled) ? form.timeRestriction : null;
      await onSave({ ...form, teams: teamsAll ? "all" : selTeams, timeRestriction });
    } finally { setBusy(false); }
  };

  return (
    <div style={S.overlay} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ background:"#fff", borderRadius:16, padding:28, width:"90%", maxWidth:540, maxHeight:"90vh", overflowY:"auto" }}>
        <h3 style={{ fontWeight:700, marginBottom:20, color:"#0f172a" }}>{cred?"Edit Credential":"Add Credential"}</h3>
        <form onSubmit={handleSubmit}>
          {[["Portal Name","portal",true],["URL","url",false],["Client / Company","client",false],["Username","username",true]].map(([lbl,key,req])=>(
            <div key={key} style={{ marginBottom:14 }}>
              <label style={S.label}>{lbl}</label>
              <input value={form[key]||""} onChange={e=>set(key,e.target.value)} style={S.input()} required={req}
                placeholder={key==="client"?"e.g. Acme Corp, Internal…":undefined} />
            </div>
          ))}
          <div style={{ marginBottom:14 }}>
            <label style={S.label}>Password</label>
            <input value={form.password||""} onChange={e=>set("password",e.target.value)} style={S.input()} required />
            <StrengthBar password={form.password} />
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={S.label}>Category</label>
            <select value={form.category||"Development"} onChange={e=>set("category",e.target.value)} style={S.input()}>
              {["Development","Infrastructure","Design","Marketing","Communication"].map(c=>(<option key={c} value={c}>{c}</option>))}
            </select>
          </div>
          {/* Verification Methods (collapsible) */}
          <div style={{ marginBottom:14, border:"1px solid #e5e9f0", borderRadius:10, overflow:"hidden" }}>
            <button type="button" onClick={()=>setShowVerify(v=>!v)}
              style={{ width:"100%", display:"flex", alignItems:"center", justifyContent:"space-between",
                background:"#f8fafc", border:"none", padding:"10px 12px", cursor:"pointer", fontSize:13, fontWeight:600, color:"#475569" }}>
              <span>＋ Add verification info</span>
              <span style={{ transform:showVerify?"rotate(180deg)":"none", transition:"transform .15s" }}>⌄</span>
            </button>
            {showVerify && (
              <div style={{ padding:12, display:"flex", flexDirection:"column", gap:12 }}>
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

          {/* Time Restriction (collapsible) */}
          <div style={{ marginBottom:14, border:"1px solid #e5e9f0", borderRadius:10, overflow:"hidden" }}>
            <button type="button" onClick={()=>setShowTime(v=>!v)}
              style={{ width:"100%", display:"flex", alignItems:"center", justifyContent:"space-between",
                background:"#f8fafc", border:"none", padding:"10px 12px", cursor:"pointer", fontSize:13, fontWeight:600, color:"#475569" }}>
              <span>⏰ Time Restriction</span>
              <span style={{ transform:showTime?"rotate(180deg)":"none", transition:"transform .15s" }}>⌄</span>
            </button>
            {showTime && (
              <div style={{ padding:12 }}>
                <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", fontSize:13, marginBottom:trEnabled?12:0 }}>
                  <input type="checkbox" checked={trEnabled} onChange={e=>enableTR(e.target.checked)} />
                  Restrict usage to specific times
                </label>
                {trEnabled && (<>
                  <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:12 }}>
                    {[["window","Time Window"],["expiry","Expiry Date"],["schedule","Schedule Note"]].map(([val,lbl])=>(
                      <button key={val} type="button" onClick={()=>setTR({ type:val })}
                        style={{ ...S.btn(tr.type===val?"primary":"ghost"), padding:"6px 12px", fontSize:12 }}>
                        {tr.type===val?"● ":"○ "}{lbl}
                      </button>
                    ))}
                  </div>

                  {tr.type==="window" && (
                    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                      <div>
                        <label style={S.label}>Days</label>
                        <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                          {ALL_DAYS.map(d=>{
                            const on=(tr.windowDays||[]).includes(d);
                            return <button key={d} type="button" onClick={()=>toggleTRDay(d)}
                              style={{ padding:"4px 10px", borderRadius:8, fontSize:12, cursor:"pointer", fontWeight:600,
                                border:"1px solid "+(on?"#3b82f6":"#e5e9f0"), background:on?"#dbeafe":"#f8fafc", color:on?"#1e40af":"#64748b" }}>{d}</button>;
                          })}
                        </div>
                      </div>
                      <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
                        <div style={{ flex:1, minWidth:120 }}>
                          <label style={S.label}>Start</label>
                          <input type="time" value={tr.windowStart||"09:00"} onChange={e=>setTR({ windowStart:e.target.value })} style={S.input()} />
                        </div>
                        <div style={{ flex:1, minWidth:120 }}>
                          <label style={S.label}>End</label>
                          <input type="time" value={tr.windowEnd||"18:00"} onChange={e=>setTR({ windowEnd:e.target.value })} style={S.input()} />
                        </div>
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
                        <div style={{ flex:1, minWidth:140 }}>
                          <label style={S.label}>Expiry date</label>
                          <input type="date" value={tr.expiryDate||""} onChange={e=>setTR({ expiryDate:e.target.value })} style={S.input()} />
                        </div>
                        <div style={{ flex:1, minWidth:120 }}>
                          <label style={S.label}>Time (optional)</label>
                          <input type="time" value={tr.expiresAt||""} onChange={e=>setTR({ expiresAt:e.target.value })} style={S.input()} />
                        </div>
                      </div>
                      <p style={{ fontSize:12, color:"#94a3b8", margin:0 }}>Card will appear locked after this date/time.</p>
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
            <label style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8, cursor:"pointer", fontSize:13 }}>
              <input type="checkbox" checked={teamsAll} onChange={e=>setTeamsAll(e.target.checked)} /> All Teams
            </label>
            {!teamsAll && (
              <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                {TEAMS.filter(t=>t!=="admin").map(t=>(
                  <label key={t} style={{ display:"flex", alignItems:"center", gap:4, cursor:"pointer",
                    padding:"4px 12px", border:"1px solid "+(selTeams.includes(t)?"#3b82f6":"#e5e9f0"),
                    borderRadius:20, fontSize:12, background:selTeams.includes(t)?"#dbeafe":"#f8fafc" }}>
                    <input type="checkbox" checked={selTeams.includes(t)} onChange={()=>toggleTeam(t)} style={{ display:"none" }} />{t}
                  </label>
                ))}
              </div>
            )}
          </div>
          <div style={{ marginBottom:20 }}>
            <label style={S.label}>Expiry Days</label>
            <select value={form.passwordExpiryDays||90} onChange={e=>set("passwordExpiryDays",+e.target.value)} style={S.input()}>
              {[30,60,90,180].map(d=><option key={d} value={d}>{d} days</option>)}
            </select>
          </div>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <button type="button" onClick={onClose} style={S.btn("ghost")}>Cancel</button>
            <button type="submit" disabled={busy} style={{ ...S.btn("primary"), opacity:busy?0.7:1 }}>{cred?"Save Changes":"Add Credential"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── User Modal ───────────────────────────────────────────────────────────────
function UserModal({ user, onSave, onClose }) {
  const [form, setForm] = useState(user
    ? { name:user.name, username:user.username, team:user.team, password:"" }
    : { name:"", username:"", password:"", team:"engineering" });
  const [busy, setBusy] = useState(false);
  const set = (k,v) => setForm(p=>({...p,[k]:v}));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name||!form.username||(!user&&!form.password)) return;
    setBusy(true);
    try { await onSave(form); } finally { setBusy(false); }
  };

  return (
    <div style={S.overlay} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ background:"#fff", borderRadius:16, padding:28, width:"90%", maxWidth:460, maxHeight:"90vh", overflowY:"auto" }}>
        <h3 style={{ fontWeight:700, marginBottom:20, color:"#0f172a" }}>{user?"Edit User":"Add User"}</h3>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom:14 }}>
            <label style={S.label}>Full Name</label>
            <input value={form.name} onChange={e=>set("name",e.target.value)} style={S.input()} required />
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={S.label}>Username {user && <span style={{ color:"#94a3b8", fontWeight:400 }}>(can't change)</span>}</label>
            <input value={form.username} onChange={e=>set("username",e.target.value)} style={S.input({ opacity:user?0.6:1 })} required disabled={!!user} />
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={S.label}>{user?"New Password (blank = keep current)":"Password"}</label>
            <input type="password" value={form.password} onChange={e=>set("password",e.target.value)} style={S.input()} required={!user} />
            {form.password && <StrengthBar password={form.password} />}
          </div>
          <div style={{ marginBottom:20 }}>
            <label style={S.label}>Team</label>
            <select value={form.team} onChange={e=>set("team",e.target.value)} style={S.input()}>
              {TEAMS.map(t=><option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <button type="button" onClick={onClose} style={S.btn("ghost")}>Cancel</button>
            <button type="submit" disabled={busy} style={{ ...S.btn("primary"), opacity:busy?0.7:1 }}>{user?"Save Changes":"Add User"}</button>
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
      <div style={{ background:"#fff", borderRadius:16, padding:28, width:"90%", maxWidth:400 }}>
        <h3 style={{ fontWeight:700, marginBottom:16, color:"#0f172a" }}>Reset Password: {user.name}</h3>
        <label style={S.label}>New Password</label>
        <input type="password" value={pw} onChange={e=>setPw(e.target.value)} style={{ ...S.input(), marginBottom:8 }} autoFocus />
        <StrengthBar password={pw} />
        <div style={{ display:"flex", gap:10, justifyContent:"flex-end", marginTop:20 }}>
          <button onClick={onClose} style={S.btn("ghost")}>Cancel</button>
          <button onClick={handleSave} disabled={busy} style={{ ...S.btn("primary"), opacity:busy?0.7:1 }}>Reset Password</button>
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
      <div style={{ background:"#fff", borderRadius:16, padding:28, width:"90%", maxWidth:420 }}>
        <h3 style={{ fontWeight:700, marginBottom:8, color:"#0f172a" }}>Request Access</h3>
        <p style={{ color:"#64748b", fontSize:14, marginBottom:16 }}>Requesting access to: <strong>{cred.portal}</strong></p>
        <label style={S.label}>Message (optional)</label>
        <textarea value={message} onChange={e=>setMessage(e.target.value)}
          style={{ ...S.input(), resize:"vertical", minHeight:80, marginBottom:16 }} placeholder="Why do you need access?" />
        <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
          <button onClick={onClose} style={S.btn("ghost")}>Cancel</button>
          <button onClick={handleSubmit} disabled={busy} style={{ ...S.btn("primary"), opacity:busy?0.7:1 }}>Submit Request</button>
        </div>
      </div>
    </div>
  );
}

// ─── Import Preview Modal ─────────────────────────────────────────────────────
function ImportPreviewModal({ rows, existingCreds, onConfirm, onClose }) {
  const processed = rows.map(r => {
    const errors = [];
    if (!r.Portal) errors.push("Missing Portal");
    if (!r.Username) errors.push("Missing Username");
    if (!r.Password) errors.push("Missing Password");
    const isDup = existingCreds.some(c=>c.portal===r.Portal);
    const status = errors.length>0?"error":isDup?"duplicate":"valid";
    return { ...r, _status:status, _errors:errors };
  });
  const valid = processed.filter(r=>r._status==="valid").length;
  const errs = processed.filter(r=>r._status==="error").length;
  const dups = processed.filter(r=>r._status==="duplicate").length;

  return (
    <div style={S.overlay}>
      <div style={{ background:"#fff", borderRadius:16, padding:28, width:"95vw", maxWidth:780, maxHeight:"90vh", overflowY:"auto" }}>
        <h3 style={{ fontWeight:700, marginBottom:8 }}>Import Preview</h3>
        <p style={{ color:"#64748b", fontSize:13, marginBottom:16 }}>
          <span style={{ color:"#16a34a" }}>✓ {valid} valid</span>{"  ·  "}
          <span style={{ color:"#f59e0b" }}>⚠ {dups} duplicate</span>{"  ·  "}
          <span style={{ color:"#dc2626" }}>✗ {errs} error</span>
        </p>
        <div style={{ maxHeight:340, overflowY:"auto", marginBottom:16 }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
            <thead>
              <tr>{["Status","Portal","URL","Username","Category","Teams"].map(h=>(
                <th key={h} style={{ background:"#f8fafc", padding:"8px 10px", textAlign:"left",
                  borderBottom:"1px solid #e5e9f0", fontWeight:600, color:"#64748b", position:"sticky", top:0 }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {processed.map((r,i)=>(
                <tr key={i} style={{ background:r._status==="valid"?"#f0fdf4":r._status==="error"?"#fef2f2":"#fffbeb" }}>
                  <td style={{ padding:"6px 10px", fontWeight:600, color:r._status==="valid"?"#16a34a":r._status==="error"?"#dc2626":"#92400e" }}>
                    {r._status==="valid"?"✓":r._status==="error"?("✗ "+r._errors.join(",")):"⚠ Dup"}
                  </td>
                  <td style={{ padding:"6px 10px" }}>{r.Portal}</td>
                  <td style={{ padding:"6px 10px" }}>{r.URL}</td>
                  <td style={{ padding:"6px 10px" }}>{r.Username}</td>
                  <td style={{ padding:"6px 10px" }}>{r.Category}</td>
                  <td style={{ padding:"6px 10px" }}>{r.Teams}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
          <button onClick={onClose} style={S.btn("ghost")}>Cancel</button>
          <button onClick={()=>onConfirm(processed)} style={S.btn("primary")}>Import {valid} Valid Row(s)</button>
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
    const t = new OTPAuth.TOTP({ issuer:"VaultAccess", label:user.username, algorithm:"SHA1", digits:6, period:30, secret:s });
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
          <p style={{ fontSize:13, color:"#64748b", marginBottom:12 }}>Scan this QR code with Google Authenticator, Authy, or similar.</p>
          {qrUrl && <img src={qrUrl} alt="QR" style={{ borderRadius:8, marginBottom:12, display:"block" }} />}
          <div style={{ background:"#f8fafc", borderRadius:8, padding:"8px 12px", marginBottom:12 }}>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:4, fontWeight:600 }}>MANUAL KEY</div>
            <code style={{ fontSize:12, wordBreak:"break-all" }}>{secret?.base32}</code>
          </div>
          <button onClick={()=>setStep(2)} style={S.btn("primary")}>Next →</button>
        </>
      )}
      {step===2 && (
        <>
          <p style={{ fontSize:13, color:"#64748b", marginBottom:12 }}>Enter the 6-digit code to verify setup.</p>
          <input value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,"").slice(0,6))}
            style={{ ...S.input(), textAlign:"center", fontSize:20, letterSpacing:6, marginBottom:12 }} placeholder="000000" maxLength={6} />
          <div style={{ display:"flex", gap:8 }}>
            <button onClick={()=>setStep(1)} style={S.btn("ghost")}>Back</button>
            <button onClick={handleVerify} style={S.btn("primary")}>Verify & Enable</button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Profile Panel ────────────────────────────────────────────────────────────
function ProfilePanel({ session, currentUser, onClose, onUserUpdate, toast, copyHistory }) {
  const [section, setSection] = useState("main");
  const [cpForm, setCpForm] = useState({ current:"", newPw:"", confirm:"" });
  const [cpError, setCpError] = useState("");
  const [busy, setBusy] = useState(false);
  const [myRequests, setMyRequests] = useState([]);

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

  return (
    <div style={{ position:"fixed", right:0, top:0, bottom:0, width:380, background:"#fff",
      boxShadow:"-8px 0 32px rgba(0,0,0,0.12)", zIndex:500, overflowY:"auto", display:"flex", flexDirection:"column" }}>
      <div style={{ background:"linear-gradient(135deg,#0a0f1e,#1e293b)", padding:24, color:"#fff" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <span style={{ fontWeight:700, fontSize:16 }}>Profile</span>
          <button onClick={onClose} style={{ background:"none", border:"none", cursor:"pointer", color:"#94a3b8", fontSize:20, padding:0 }}>✕</button>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          <div style={{ width:52, height:52, borderRadius:"50%", background:"linear-gradient(135deg,#f59e0b,#d97706)",
            display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, fontSize:18, color:"#fff" }}>{currentUser.avatar}</div>
          <div>
            <div style={{ fontWeight:700, fontSize:16 }}>{currentUser.name}</div>
            <div style={{ color:"#94a3b8", fontSize:13 }}>@{currentUser.username}</div>
            <div style={{ marginTop:4 }}><TeamBadge team={currentUser.team} small /></div>
          </div>
        </div>
        <div style={{ marginTop:10, color:"#64748b", fontSize:12 }}>Last login: {fmtDate(currentUser.lastLoginAt)}</div>
      </div>

      <div style={{ padding:20, flex:1 }}>
        <div style={{ marginBottom:24 }}>
          <h4 style={{ fontWeight:700, color:"#0f172a", marginBottom:12, fontSize:14 }}>Change Password</h4>
          {[["Current Password","current"],["New Password","newPw"],["Confirm New","confirm"]].map(([lbl,key])=>(
            <div key={key} style={{ marginBottom:10 }}>
              <label style={S.label}>{lbl}</label>
              <input type="password" value={cpForm[key]} onChange={e=>setCpForm(p=>({...p,[key]:e.target.value}))} style={S.input()} />
            </div>
          ))}
          {cpForm.newPw && <StrengthBar password={cpForm.newPw} />}
          {cpError && <p style={{ color:"#dc2626", fontSize:13, marginTop:6 }}>{cpError}</p>}
          <button onClick={handleChangePw} disabled={busy} style={{ ...S.btn("primary"), marginTop:10, opacity:busy?0.7:1 }}>Update Password</button>
        </div>

        {copyHistory.length>0 && (
          <div style={{ marginBottom:24 }}>
            <h4 style={{ fontWeight:700, color:"#0f172a", marginBottom:10, fontSize:14 }}>Recent Copies</h4>
            {copyHistory.map((item,i)=>(
              <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
                padding:"8px 12px", background:"#f8fafc", borderRadius:8, marginBottom:6, fontSize:13 }}>
                <span><strong>{item.portal}</strong> · {item.field}</span>
                <span style={{ color:"#94a3b8", fontSize:11 }}>{timeAgo(item.time)}</span>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginBottom:24 }}>
          <h4 style={{ fontWeight:700, color:"#0f172a", marginBottom:10, fontSize:14 }}>Two-Factor Authentication</h4>
          {currentUser.twoFactorEnabled ? (
            <div>
              <div style={{ color:"#16a34a", fontWeight:600, fontSize:13, marginBottom:10 }}>✓ Enabled</div>
              <button onClick={disable2FA} style={S.btn("danger")}>Disable 2FA</button>
            </div>
          ) : (
            <div>
              <p style={{ color:"#64748b", fontSize:13, marginBottom:10 }}>2FA is not enabled.</p>
              {section==="2fa"
                ? <TwoFASetup user={currentUser} toast={toast} onDone={u=>{ onUserUpdate(u); setSection("main"); }} />
                : <button onClick={()=>setSection("2fa")} style={S.btn("primary")}>Setup 2FA</button>}
            </div>
          )}
        </div>

        {myRequests.length>0 && (
          <div>
            <h4 style={{ fontWeight:700, color:"#0f172a", marginBottom:10, fontSize:14 }}>My Access Requests</h4>
            {myRequests.map(r=>(
              <div key={r.id} style={{ padding:"10px 12px", background:"#f8fafc", borderRadius:8, marginBottom:8, fontSize:13 }}>
                <div style={{ fontWeight:600 }}>{r.credentialName}</div>
                <div style={{ display:"flex", justifyContent:"space-between", marginTop:4 }}>
                  <span style={{ color:"#64748b" }}>{timeAgo(r.requestedAt)}</span>
                  <span style={{ padding:"2px 8px", borderRadius:20, fontSize:11, fontWeight:600,
                    background:r.status==="pending"?"#fef3c7":r.status==="approved"?"#dcfce7":"#fee2e2",
                    color:r.status==="pending"?"#92400e":r.status==="approved"?"#166534":"#dc2626" }}>{r.status}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Matrix View ──────────────────────────────────────────────────────────────
function MatrixView({ creds, toast, onReload }) {
  const teams = ["engineering","marketing","design","ops"];
  const categories = [...new Set(creds.map(c=>c.category))];
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
    <div style={{ overflowX:"auto" }}>
      <table style={{ borderCollapse:"collapse", minWidth:600, fontSize:13 }}>
        <thead>
          <tr>
            <th style={{ position:"sticky", left:0, background:"#fff", zIndex:2, padding:"10px 14px", textAlign:"left",
              borderBottom:"2px solid #e5e9f0", borderRight:"1px solid #e5e9f0", minWidth:200, fontWeight:700, color:"#0f172a" }}>Credential</th>
            {teams.map(t=>(
              <th key={t} style={{ padding:"10px 14px", textAlign:"center", borderBottom:"2px solid #e5e9f0", minWidth:120, fontWeight:700 }}>
                <TeamBadge team={t} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {categories.map(cat=>(
            <React.Fragment key={cat}>
              <tr>
                <td colSpan={teams.length+1} style={{ background:"#f8fafc", padding:"6px 14px", fontWeight:700, color:"#64748b", fontSize:11, letterSpacing:1 }}>{cat.toUpperCase()}</td>
              </tr>
              {creds.filter(c=>c.category===cat).map(cred=>(
                <tr key={cred.id} style={{ borderBottom:"1px solid #f1f5f9" }}>
                  <td style={{ position:"sticky", left:0, background:"#fff", padding:"10px 14px", borderRight:"1px solid #e5e9f0", fontWeight:600 }}>{cred.portal}</td>
                  {teams.map(t=>(
                    <td key={t} style={{ padding:"10px 14px", textAlign:"center" }}>
                      <button onClick={()=>toggleCell(cred,t)}
                        style={{ background:hasTeam(cred,t)?"#dcfce7":"#f8fafc", border:"1px solid "+(hasTeam(cred,t)?"#bbf7d0":"#e5e9f0"),
                          borderRadius:6, padding:"4px 14px", cursor:"pointer", color:hasTeam(cred,t)?"#166534":"#94a3b8", fontWeight:700 }}>
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
  );
}

// ─── Loading splash ───────────────────────────────────────────────────────────
function Splash({ text }) {
  return (
    <div style={{ minHeight:"100vh", background:"#060d1a", display:"flex", flexDirection:"column",
      alignItems:"center", justifyContent:"center", color:"#94a3b8", gap:12 }}>
      <div style={{ fontSize:40 }}>🔐</div>
      <div style={{ fontSize:14 }}>{text||"Loading…"}</div>
    </div>
  );
}

// ─── Credentials Tab ──────────────────────────────────────────────────────────
function CredentialsTab({ session, toast }) {
  const [creds, setCreds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("All");
  const [clientFilter, setClientFilter] = useState("All");
  const [restrictedOnly, setRestrictedOnly] = useState(false);
  const [sort, setSort] = useState("A-Z");
  const [editCred, setEditCred] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [deleteCredState, setDeleteCredState] = useState(null);
  const [requestCred, setRequestCred] = useState(null);
  const [importRows, setImportRows] = useState(null);
  const [favs, setFavs] = useState([]);
  const [requests, setRequests] = useState([]);
  const [recentViewed, setRecentViewed] = useState([]);

  const isAdmin = session.team==="admin";

  const loadAll = useCallback(async () => {
    try {
      const [c, f, r] = await Promise.all([
        listCredentials(),
        listFavourites(session.userId).catch(()=>[]),
        listRequests().catch(()=>[]),
      ]);
      setCreds(c); setFavs(f); setRequests(r);
    } catch (e) { toast(e.message,"error"); } finally { setLoading(false); }
  }, [session.userId, toast]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const accessible = creds.filter(c=>canAccess(c,session.team));
  const categories = ["All",...new Set(creds.map(c=>c.category))];
  const clients = ["All",...[...new Set(creds.map(c=>c.client||"").filter(Boolean))].sort()];

  const rotationWarning = (isAdmin?creds:accessible).filter(c=>{
    const age=daysSince(c.updatedAt);
    return c.needsRotation||((c.passwordExpiryDays||90)-age)<=7;
  });

  const restrictBase = isAdmin?creds:accessible;
  const restrictedCount = restrictBase.filter(c=>isRestrictedState(evalTimeRestriction(c.timeRestriction).state)).length;
  const expiredCount = restrictBase.filter(c=>evalTimeRestriction(c.timeRestriction).state==="expired").length;

  const baseList = isAdmin?creds:accessible;
  const filtered = baseList.filter(c=>{
    const q=search.toLowerCase();
    const ms=!search||c.portal.toLowerCase().includes(q)||c.username.toLowerCase().includes(q)||
      (c.client||"").toLowerCase().includes(q)||(c.authLocation||"").toLowerCase().includes(q)||(c.url||"").toLowerCase().includes(q);
    const mc=catFilter==="All"||c.category===catFilter;
    const mcl=clientFilter==="All"||(c.client||"")===clientFilter;
    const mr=!restrictedOnly||(c.timeRestriction&&c.timeRestriction.enabled);
    return ms&&mc&&mcl&&mr;
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

  const handleFileImport = e => {
    const file=e.target.files[0]; if(!file) return;
    const reader=new FileReader();
    reader.onload=ev=>{ const wb=XLSX.read(new Uint8Array(ev.target.result),{type:"array"}); const ws=wb.Sheets[wb.SheetNames[0]]; setImportRows(XLSX.utils.sheet_to_json(ws,{defval:""})); };
    reader.readAsArrayBuffer(file); e.target.value="";
  };

  const handleImportConfirm = async (processed) => {
    const valid=processed.filter(r=>r._status==="valid");
    const newC=valid.map(r=>({
      portal:r.Portal, url:r.URL||"", client:r.Client||"", username:r.Username||"", password:r.Password||"",
      category:r.Category||"Development",
      verifyEmail:r["Verify Email"]||"", verifyText:r["Verify Text"]||"", verifyAuth:r["Verify Auth"]||"",
      teams:r.Teams==="all"?"all":String(r.Teams||"").split(",").map(t=>t.trim()).filter(Boolean),
      passwordExpiryDays:+(r["Expiry Days"])||90, needsRotation:false, rotationNote:"",
    }));
    try {
      if (newC.length) await bulkCreateCredentials(newC, session.userName);
      logAudit({ userId:session.userId, userName:session.userName, action:"bulk_import", detail:newC.length+" credentials imported" });
      setImportRows(null);
      const sk=processed.filter(r=>r._status==="duplicate").length;
      const er=processed.filter(r=>r._status==="error").length;
      toast(newC.length+" imported, "+sk+" skipped, "+er+" errors","success");
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
    const h=["Portal","URL","Client","Username","Password","Verify Email","Verify Text","Verify Auth","Category","Teams","Expiry Days","Days Since Updated","Needs Rotation","Time Restriction Type","Window/Expiry Details","Active Now","Added By","Added At"];
    const rows=all.map(c=>[c.portal,c.url,c.client||"",c.username,c.password,
      c.verifyEmail||"",c.verifyText||"",c.verifyAuth||"",c.category,
      c.teams==="all"?"all":(c.teams||[]).join(","),c.passwordExpiryDays,daysSince(c.updatedAt),c.needsRotation?"Yes":"No",
      trType(c),trDetails(c),trActive(c),c.addedBy,c.addedAt]);
    const ws1=XLSX.utils.aoa_to_sheet([h,...rows]); ws1["!cols"]=h.map(()=>({wch:20}));
    const teams=["engineering","marketing","design","ops"];
    const mh=["Credential",...teams];
    const mr=all.map(c=>[c.portal,...teams.map(t=>(c.teams==="all"||(Array.isArray(c.teams)&&c.teams.includes(t)))?"✓":"")]);
    const ws2=XLSX.utils.aoa_to_sheet([mh,...mr]);
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws1,"Credentials"); XLSX.utils.book_append_sheet(wb,ws2,"Access Matrix");
    XLSX.writeFile(wb,"VaultAccess-Export.xlsx"); toast("Exported!","success");
  };

  const handleTemplate = () => {
    const h=["Portal","URL","Client","Username","Password","Verify Email","Verify Text","Verify Auth","Category","Teams","Expiry Days"];
    const ex=[
      ["GitHub","github.com","Acme Corp","user@example.com","password123","","","Engineering Authy (shared)","Development","engineering",90],
      ["Figma","figma.com","Bright Agency","design@co.com","figpass","design@co.com inbox","","","Design","design,marketing",60],
      ["Notion","notion.so","Internal","team@co.com","notionpw","","+1 (555) 000-0000","","Communication","all",90],
    ];
    const ws=XLSX.utils.aoa_to_sheet([h,...ex]); ws["!cols"]=h.map(()=>({wch:22}));
    const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,"Template");
    XLSX.writeFile(wb,"VaultAccess-Template.xlsx"); toast("Template downloaded!","success");
  };

  const stats = {
    accessible: accessible.length,
    categories: new Set(accessible.map(c=>c.category)).size,
    clientsCount: new Set(creds.map(c=>c.client||"").filter(Boolean)).size,
    restricted: restrictedCount,
    team: accessible.filter(c=>c.teams!=="all"&&Array.isArray(c.teams)&&c.teams.includes(session.team)).length,
    total: creds.length,
  };
  const StatCard = ({ val, label, color }) => (
    <div style={{ background:color+"10", border:"1px solid "+color+"25", borderRadius:12, padding:"14px 18px", flex:1, minWidth:100 }}>
      <div style={{ fontSize:22, fontWeight:800, color }}>{val}</div>
      <div style={{ fontSize:12, color:"#64748b", marginTop:2 }}>{label}</div>
    </div>
  );

  if (loading) return <Splash text="Loading credentials…" />;

  return (
    <div>
      {(rotationWarning.length>0 || expiredCount>0) && (
        <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:10, padding:"12px 16px", marginBottom:16, display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:18 }}>⚠️</span>
          <span style={{ color:"#92400e", fontWeight:600, fontSize:14 }}>
            {rotationWarning.length>0 && `${rotationWarning.length} credential(s) need rotation or expiring within 7 days.`}
            {rotationWarning.length>0 && expiredCount>0 && " "}
            {expiredCount>0 && `${expiredCount} time-restricted credential(s) have expired.`}
          </span>
        </div>
      )}

      <div style={{ display:"flex", gap:12, marginBottom:20, flexWrap:"wrap" }}>
        <StatCard val={stats.accessible} label="Accessible" color="#2563eb" />
        <StatCard val={stats.categories} label="Categories" color="#16a34a" />
        <StatCard val={stats.clientsCount} label="Clients" color="#3b52a0" />
        <StatCard val={stats.restricted} label="Restricted" color="#ef4444" />
        <StatCard val={stats.team} label={"Team ("+session.team+")"} color="#9333ea" />
        {isAdmin && <StatCard val={stats.total} label="Total" color="#f59e0b" />}
      </div>

      {recentViewed.length>0 && (
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:13, fontWeight:700, color:"#64748b", marginBottom:8 }}>Recently Viewed</div>
          <div style={{ display:"flex", gap:10, overflowX:"auto", paddingBottom:4 }}>
            {recentViewed.map(c=>(
              <div key={c.id} style={{ background:"#fff", border:"1px solid #e5e9f0", borderRadius:10, padding:"8px 14px", whiteSpace:"nowrap", fontSize:13, fontWeight:600, color:"#0f172a", flexShrink:0 }}>
                {CAT_ICONS[c.category]||"🔑"} {c.portal}
              </div>
            ))}
          </div>
        </div>
      )}

      {pinned.length>0 && (
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:13, fontWeight:700, color:"#64748b", marginBottom:10 }}>⭐ Pinned</div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(340px,1fr))", gap:16 }}>
            {pinned.map(c=>(
              <CredentialCard key={c.id} cred={c} session={session} onEdit={setEditCred} onDelete={setDeleteCredState}
                onCopy={handleCopy} onCopyVerify={handleCopyVerify} onFavToggle={handleFavToggle} isFav={true} requests={requests}
                onRequestAccess={setRequestCred} toast={toast} onPatch={handlePatch} />
            ))}
          </div>
        </div>
      )}

      <div style={{ display:"flex", gap:10, marginBottom:12, flexWrap:"wrap", alignItems:"center" }}>
        <input value={search} onChange={e=>setSearch(e.target.value)} style={{ ...S.input(), maxWidth:280 }} placeholder="🔍 Search credentials..." />
        <select value={sort} onChange={e=>setSort(e.target.value)} style={{ ...S.input(), width:"auto" }}>
          {["A-Z","Newest","Oldest","Expiring Soon"].map(s=><option key={s}>{s}</option>)}
        </select>
        <button onClick={()=>setRestrictedOnly(v=>!v)}
          style={{ padding:"8px 14px", fontSize:13, borderRadius:8, cursor:"pointer", fontWeight:600,
            border:"1px solid "+(restrictedOnly?"#ef4444":"#e5e9f0"),
            background:restrictedOnly?"#fef2f2":"#fff", color:restrictedOnly?"#b91c1c":"#64748b" }}>
          ⏰ Time-Restricted
        </button>
      </div>

      <div style={{ display:"flex", gap:8, marginBottom:10, flexWrap:"wrap", alignItems:"center" }}>
        <span style={{ fontSize:12, fontWeight:600, color:"#94a3b8", whiteSpace:"nowrap" }}>CATEGORY</span>
        {categories.map(c=>(
          <button key={c} onClick={()=>setCatFilter(c)} style={{ ...S.btn(catFilter===c?"primary":"ghost"), padding:"6px 14px", fontSize:13 }}>{c}</button>
        ))}
      </div>

      {clients.length>1 && (
        <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
          <span style={{ fontSize:12, fontWeight:600, color:"#94a3b8", whiteSpace:"nowrap" }}>CLIENT</span>
          {clients.map(cl=>(
            <button key={cl} onClick={()=>setClientFilter(cl)}
              style={{ padding:"6px 14px", fontSize:13, borderRadius:8, border:"none", cursor:"pointer", fontWeight:600,
                background: clientFilter===cl ? "#3b52a0" : "#f0f4ff", color: clientFilter===cl ? "#fff" : "#3b52a0" }}>
              {cl==="All" ? "All Clients" : "🏢 "+cl}
            </button>
          ))}
        </div>
      )}

      {isAdmin && (
        <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap" }}>
          <label style={{ ...S.btn("ghost"), cursor:"pointer" }}>
            📥 Import Excel
            <input type="file" accept=".xlsx,.xls" style={{ display:"none" }} onChange={handleFileImport} />
          </label>
          <button onClick={handleExport} style={S.btn("ghost")}>📤 Export Excel</button>
          <button onClick={handleTemplate} style={S.btn("ghost")}>📋 Download Template</button>
          <button onClick={()=>setShowAdd(true)} style={S.btn("primary")}>+ Add Credential</button>
        </div>
      )}

      <div style={{ fontSize:13, color:"#64748b", marginBottom:12 }}>{filtered.length} credential(s) found</div>

      {filtered.length===0 ? (
        <div style={{ textAlign:"center", padding:40, color:"#94a3b8" }}>No credentials found.</div>
      ) : (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(340px,1fr))", gap:16 }}>
          {unpinned.map(c=>(
            <CredentialCard key={c.id} cred={c} session={session} onEdit={setEditCred} onDelete={setDeleteCredState}
              onCopy={handleCopy} onFavToggle={handleFavToggle} isFav={false} requests={requests}
              onRequestAccess={setRequestCred} toast={toast} onPatch={handlePatch} />
          ))}
        </div>
      )}

      {(editCred||showAdd) && (
        <CredModal cred={editCred} onSave={handleSave} onClose={()=>{ setEditCred(null); setShowAdd(false); }} session={session} />
      )}
      {deleteCredState && (
        <div style={S.overlay}>
          <div style={{ background:"#fff", borderRadius:16, padding:28, maxWidth:380, textAlign:"center" }}>
            <div style={{ fontSize:32, marginBottom:12 }}>🗑️</div>
            <h3 style={{ fontWeight:700, marginBottom:8 }}>Delete "{deleteCredState.portal}"?</h3>
            <p style={{ color:"#64748b", fontSize:14, marginBottom:20 }}>This cannot be undone.</p>
            <div style={{ display:"flex", gap:10, justifyContent:"center" }}>
              <button onClick={()=>setDeleteCredState(null)} style={S.btn("ghost")}>Cancel</button>
              <button onClick={()=>handleDelete(deleteCredState)} style={S.btn("danger")}>Delete</button>
            </div>
          </div>
        </div>
      )}
      {requestCred && (
        <RequestAccessModal cred={requestCred} session={session} onClose={()=>setRequestCred(null)} toast={toast} onDone={loadAll} />
      )}
      {importRows && (
        <ImportPreviewModal rows={importRows} existingCreds={creds} onConfirm={handleImportConfirm} onClose={()=>setImportRows(null)} />
      )}
    </div>
  );
}

// ─── Users Tab ────────────────────────────────────────────────────────────────
function UsersTab({ session, toast }) {
  const [users, setUsers] = useState([]);
  const [creds, setCreds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [teamFilter, setTeamFilter] = useState("All");
  const [showAdd, setShowAdd] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const [resetUser, setResetUser] = useState(null);
  const [matrixView, setMatrixView] = useState(false);

  const loadAll = useCallback(async () => {
    try { const [u,c] = await Promise.all([listUsers(), listCredentials()]); setUsers(u); setCreds(c); }
    catch (e) { toast(e.message,"error"); } finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { loadAll(); }, [loadAll]);

  const adminCount = users.filter(u=>u.team==="admin").length;
  const filtered = users.filter(u=>{
    const ms=!search||u.name.toLowerCase().includes(search.toLowerCase())||u.username.toLowerCase().includes(search.toLowerCase());
    const mt=teamFilter==="All"||u.team===teamFilter;
    return ms&&mt;
  });

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

  if (loading) return <Splash text="Loading users…" />;

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16, flexWrap:"wrap", gap:10 }}>
        <div style={{ fontWeight:700, color:"#0f172a", fontSize:18 }}>
          Users <span style={{ color:"#94a3b8", fontSize:14, fontWeight:400 }}>({users.length})</span>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={()=>setMatrixView(p=>!p)} style={S.btn(matrixView?"primary":"ghost")}>{matrixView?"List View":"Matrix View"}</button>
          <button onClick={()=>setShowAdd(true)} style={S.btn("primary")}>+ Add User</button>
        </div>
      </div>

      {matrixView ? (
        <MatrixView creds={creds} toast={toast} onReload={loadAll} />
      ) : (
        <>
          <div style={{ display:"flex", gap:10, marginBottom:12, flexWrap:"wrap" }}>
            <input value={search} onChange={e=>setSearch(e.target.value)} style={{ ...S.input(), maxWidth:260 }} placeholder="🔍 Search users..." />
          </div>
          <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap" }}>
            {["All",...TEAMS].map(t=>(
              <button key={t} onClick={()=>setTeamFilter(t)} style={{ ...S.btn(teamFilter===t?"primary":"ghost"), padding:"6px 14px", fontSize:13 }}>{t}</button>
            ))}
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))", gap:16 }}>
            {filtered.map(u=>{
              const accessCount=creds.filter(c=>canAccess(c,u.team)).length;
              return (
                <div key={u.id} style={S.card()}>
                  <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:12 }}>
                    <div style={{ width:44, height:44, borderRadius:"50%", background:"linear-gradient(135deg,#f59e0b,#d97706)",
                      display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, fontSize:15, color:"#fff", flexShrink:0 }}>{u.avatar}</div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                        <span style={{ fontWeight:700, color:"#0f172a", fontSize:15 }}>{u.name}</span>
                        {u.id===session.userId && <span style={{ background:"#dbeafe", color:"#1e40af", borderRadius:20, padding:"1px 6px", fontSize:10, fontWeight:700 }}>You</span>}
                      </div>
                      <div style={{ color:"#64748b", fontSize:13, fontFamily:"monospace" }}>@{u.username}</div>
                    </div>
                  </div>
                  <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:10 }}>
                    <TeamBadge team={u.team} small />
                    {u.twoFactorEnabled && <span style={{ background:"#dcfce7", color:"#166534", borderRadius:20, padding:"2px 8px", fontSize:11, fontWeight:600 }}>2FA ✓</span>}
                  </div>
                  <div style={{ fontSize:12, color:"#64748b", marginBottom:10 }}>
                    <div>Access: {accessCount} credentials</div>
                    <div>Last login: {u.lastLoginAt?timeAgo(u.lastLoginAt):"Never"}</div>
                  </div>
                  <div style={{ display:"flex", gap:6, flexWrap:"wrap", paddingTop:10, borderTop:"1px solid #f1f5f9" }}>
                    <button onClick={()=>setEditUser(u)} style={{ ...S.btn("ghost"), padding:"4px 10px", fontSize:12 }}>Edit</button>
                    <button onClick={()=>setResetUser(u)} style={{ ...S.btn("ghost"), padding:"4px 10px", fontSize:12 }}>Reset PW</button>
                    <button onClick={()=>handleToggle2FA(u)} style={{ ...S.btn("ghost"), padding:"4px 10px", fontSize:12 }}>{u.twoFactorEnabled?"Disable 2FA":"Enable 2FA"}</button>
                    <button onClick={()=>handleRemove(u)} disabled={u.id===session.userId||(u.team==="admin"&&adminCount<=1)}
                      style={{ ...S.btn("danger"), padding:"4px 10px", fontSize:12,
                        opacity:(u.id===session.userId||(u.team==="admin"&&adminCount<=1))?0.4:1,
                        cursor:(u.id===session.userId||(u.team==="admin"&&adminCount<=1))?"not-allowed":"pointer" }}>Remove</button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {(showAdd||editUser) && (
        <UserModal user={editUser} onSave={handleSave} onClose={()=>{ setShowAdd(false); setEditUser(null); }} />
      )}
      {resetUser && (
        <ResetPasswordModal user={resetUser} onClose={()=>setResetUser(null)}
          onSubmit={async (pw)=>{ try { await adminResetPassword(resetUser.id, pw); logAudit({ userId:session.userId, userName:session.userName, action:"password_changed", targetUserId:resetUser.id }); toast("Password reset!","success"); } catch (e) { toast(e.message,"error"); } }} />
      )}
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
    add:"#16a34a", approve:"#16a34a", add_user:"#16a34a", bulk_import:"#16a34a",
    login:"#2563eb", view:"#2563eb", copy:"#2563eb", logout:"#2563eb",
    edit:"#f59e0b", access_request:"#f59e0b", edit_user:"#f59e0b", password_changed:"#f59e0b",
    delete:"#dc2626", deny:"#dc2626", login_failed:"#dc2626", remove_user:"#dc2626",
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
    XLSX.utils.book_append_sheet(wb,ws,"Audit Log"); XLSX.writeFile(wb,"VaultAccess-Audit.xlsx"); toast("Exported!","success");
  };

  if (loading) return <Splash text="Loading audit log…" />;

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16, flexWrap:"wrap", gap:10 }}>
        <h2 style={{ fontWeight:700, color:"#0f172a", fontSize:18 }}>Audit Log</h2>
        <button onClick={handleExport} style={S.btn("primary")}>📤 Export Audit Log</button>
      </div>
      <div style={{ display:"flex", gap:10, marginBottom:16, flexWrap:"wrap" }}>
        <input value={search} onChange={e=>setSearch(e.target.value)} style={{ ...S.input(), maxWidth:220 }} placeholder="Search..." />
        <select value={actionFilter} onChange={e=>setActionFilter(e.target.value)} style={{ ...S.input(), width:"auto" }}>
          {["All","login","copy","edit","delete","add","request","import"].map(a=>(<option key={a}>{a}</option>))}
        </select>
        <select value={userFilter} onChange={e=>setUserFilter(e.target.value)} style={{ ...S.input(), width:"auto" }}>
          <option>All</option>
          {uniqueUsers.map(u=><option key={u}>{u}</option>)}
        </select>
        <select value={dateRange} onChange={e=>setDateRange(e.target.value)} style={{ ...S.input(), width:"auto" }}>
          {["Today","7d","30d","All"].map(d=><option key={d}>{d}</option>)}
        </select>
      </div>
      <div style={{ background:"#fff", borderRadius:12, border:"1px solid #e5e9f0", overflow:"hidden" }}>
        <div style={{ overflowX:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
            <thead>
              <tr style={{ background:"#f8fafc" }}>
                {["Timestamp","User","Action","Credential/Target","Detail"].map(h=>(
                  <th key={h} style={{ padding:"12px 14px", textAlign:"left", borderBottom:"1px solid #e5e9f0", fontWeight:600, color:"#64748b", fontSize:12 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length===0
                ? <tr><td colSpan={5} style={{ textAlign:"center", padding:30, color:"#94a3b8" }}>No entries</td></tr>
                : filtered.map(e=>(
                  <tr key={e.id} style={{ borderBottom:"1px solid #f1f5f9" }}>
                    <td style={{ padding:"10px 14px", color:"#64748b", whiteSpace:"nowrap", fontSize:12 }}>{new Date(e.timestamp).toLocaleString()}</td>
                    <td style={{ padding:"10px 14px", fontWeight:600 }}>{e.userName}</td>
                    <td style={{ padding:"10px 14px" }}>
                      <span style={{ background:(actionColors[e.action]||"#64748b")+"20", color:actionColors[e.action]||"#64748b", borderRadius:20, padding:"3px 10px", fontSize:11, fontWeight:700 }}>{e.action}</span>
                    </td>
                    <td style={{ padding:"10px 14px", color:"#0f172a" }}>{e.credentialName||e.targetUserId||"—"}</td>
                    <td style={{ padding:"10px 14px", color:"#64748b", fontSize:12 }}>{e.detail||e.ipNote}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Access Requests Tab ──────────────────────────────────────────────────────
function AccessRequestsTab({ session, toast, onChange }) {
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

  if (loading) return <Splash text="Loading requests…" />;

  return (
    <div>
      <h2 style={{ fontWeight:700, color:"#0f172a", fontSize:18, marginBottom:16 }}>Access Requests</h2>
      <div style={{ display:"flex", gap:4, marginBottom:20, borderBottom:"2px solid #e5e9f0" }}>
        {["pending","approved","denied"].map(t=>(
          <button key={t} onClick={()=>setSubTab(t)}
            style={{ background:"none", border:"none", borderBottom:"2px solid "+(subTab===t?"#f59e0b":"transparent"),
              color:subTab===t?"#f59e0b":"#64748b", fontWeight:subTab===t?700:400, padding:"8px 16px", fontSize:14, cursor:"pointer",
              display:"flex", alignItems:"center", gap:6 }}>
            {t.charAt(0).toUpperCase()+t.slice(1)}
            {t==="pending"&&pendingCount>0&&(
              <span style={{ background:"#dc2626", color:"#fff", borderRadius:"50%", minWidth:18, height:18, fontSize:10, fontWeight:800, display:"flex", alignItems:"center", justifyContent:"center", padding:"0 4px" }}>{pendingCount}</span>
            )}
          </button>
        ))}
      </div>
      {filtered.length===0
        ? <div style={{ textAlign:"center", padding:40, color:"#94a3b8" }}>No {subTab} requests.</div>
        : <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
            {filtered.map(r=>(
              <div key={r.id} style={S.card()}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", flexWrap:"wrap", gap:10 }}>
                  <div>
                    <div style={{ fontWeight:700, fontSize:15, color:"#0f172a", marginBottom:4, display:"flex", alignItems:"center", gap:8 }}>
                      {r.requesterName} <TeamBadge team={r.requesterTeam} small />
                    </div>
                    <div style={{ color:"#64748b", fontSize:13 }}>Requesting access to: <strong>{r.credentialName}</strong></div>
                    {r.message && <div style={{ marginTop:6, color:"#64748b", fontSize:13, background:"#f8fafc", borderRadius:6, padding:"6px 10px" }}>"{r.message}"</div>}
                    <div style={{ fontSize:12, color:"#94a3b8", marginTop:6 }}>{timeAgo(r.requestedAt)}{r.resolvedBy?" · Resolved by "+r.resolvedBy:""}</div>
                  </div>
                  {subTab==="pending" && (
                    <div style={{ display:"flex", gap:8 }}>
                      <button onClick={()=>handleResolve(r,"approved")} style={S.btn("primary")}>Approve</button>
                      <button onClick={()=>handleResolve(r,"denied")} style={S.btn("danger")}>Deny</button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>}
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function Dashboard({ user, onLogout }) {
  const session = getSession();
  const [tab, setTab] = useState("credentials");
  const [showProfile, setShowProfile] = useState(false);
  const [currentUser, setCurrentUser] = useState(user);
  const [showInactivity, setShowInactivity] = useState(false);
  const [countdown, setCountdown] = useState(60);
  const [copyHistory, setCopyHistory] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [toasts, toast] = useToast();
  const lastActivity = useRef(Date.now());
  const warningShown = useRef(false);

  const isAdmin = session?.team==="admin";

  const refreshPending = useCallback(() => {
    if (!isAdmin) return;
    listRequests().then(rs => setPendingCount(rs.filter(r=>r.status==="pending").length)).catch(()=>{});
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

  const TABS = isAdmin ? ["credentials","users","audit","requests"] : ["credentials"];
  const TAB_LABELS = { credentials:"Credentials", users:"Users", audit:"Audit Log", requests:"Access Requests" };

  return (
    <div style={{ minHeight:"100vh", background:"#f0f2f5" }}>
      <style>{`@keyframes slideIn { from { transform:translateX(20px);opacity:0 } to { transform:none;opacity:1 } } * { box-sizing: border-box; }`}</style>
      <ToastContainer toasts={toasts} />

      <header style={{ background:"#0a0f1e", padding:"0 24px", height:64, display:"flex", alignItems:"center", justifyContent:"space-between",
        position:"sticky", top:0, zIndex:100, boxShadow:"0 2px 20px rgba(0,0,0,0.3)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:22 }}>🔐</span>
          <span style={{ color:"#fff", fontWeight:800, fontSize:18, letterSpacing:-0.5 }}>VaultAccess</span>
        </div>
        <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
          {TABS.map(t=>(
            <button key={t} onClick={()=>setTab(t)} style={{ background:tab===t?"rgba(245,158,11,0.15)":"transparent",
              border:"1px solid "+(tab===t?"rgba(245,158,11,0.4)":"transparent"), color:tab===t?"#f59e0b":"#94a3b8",
              borderRadius:8, padding:"6px 14px", cursor:"pointer", fontWeight:600, fontSize:13, display:"flex", alignItems:"center", gap:6 }}>
              {TAB_LABELS[t]}
              {t==="requests"&&pendingCount>0&&(
                <span style={{ background:"#dc2626", color:"#fff", borderRadius:"50%", minWidth:18, height:18, fontSize:10, fontWeight:800, display:"flex", alignItems:"center", justifyContent:"center", padding:"0 4px" }}>{pendingCount}</span>
              )}
            </button>
          ))}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <button onClick={()=>setShowProfile(p=>!p)} style={{ background:"linear-gradient(135deg,#f59e0b,#d97706)", border:"none",
            borderRadius:"50%", width:38, height:38, cursor:"pointer", color:"#fff", fontWeight:800, fontSize:14,
            display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>{currentUser.avatar}</button>
          <div style={{ color:"#fff" }}>
            <div style={{ fontSize:13, fontWeight:600 }}>{currentUser.name}</div>
            <div style={{ fontSize:11, color:"#64748b" }}>{session?.team}</div>
          </div>
          <button onClick={onLogout} style={{ ...S.btn("ghost"), borderColor:"rgba(255,255,255,0.15)", color:"#94a3b8", padding:"6px 12px", fontSize:12 }}>Sign Out</button>
        </div>
      </header>

      <main style={{ maxWidth:1400, margin:"0 auto", padding:24 }}>
        {tab==="credentials" && <CredentialsTab session={session} toast={toast} />}
        {tab==="users"&&isAdmin && <UsersTab session={session} toast={toast} />}
        {tab==="audit"&&isAdmin && <AuditTab session={session} toast={toast} />}
        {tab==="requests"&&isAdmin && <AccessRequestsTab session={session} toast={toast} onChange={refreshPending} />}
      </main>

      {showProfile && (
        <>
          <div onClick={()=>setShowProfile(false)} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.2)", zIndex:499 }} />
          <ProfilePanel session={session} currentUser={currentUser} onClose={()=>setShowProfile(false)}
            onUserUpdate={u=>setCurrentUser(u)} toast={toast} copyHistory={copyHistory} />
        </>
      )}

      {showInactivity && <InactivityModal countdown={countdown} onStay={()=>{ resetActivity(); }} onLogout={onLogout} />}
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function VaultAccess() {
  const [stage, setStage] = useState({ name:"loading" });

  useEffect(() => {
    (async () => {
      if (!isSupabaseConfigured) { setStage({ name:"unconfigured" }); return; }
      try {
        const { data } = await supabase.auth.getSession();
        if (data.session) {
          const user = await getMyProfile();
          if (user) {
            setSession({ userId:user.id, userName:user.name, team:user.team, loginAt:new Date().toISOString(), lastActivityAt:new Date().toISOString() });
            setStage({ name:"dashboard", user });
            return;
          }
        }
      } catch { /* fall through to login */ }
      setStage({ name:"login" });
    })();
  }, []);

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

  if (stage.name==="loading") return <Splash text="Starting VaultAccess…" />;
  if (stage.name==="unconfigured") return (
    <div style={{ minHeight:"100vh", background:"#060d1a", display:"flex", alignItems:"center", justifyContent:"center", padding:24 }}>
      <div style={{ background:"#0f1a2e", borderRadius:16, padding:32, maxWidth:480, color:"#e2e8f0", border:"1px solid rgba(245,158,11,0.2)" }}>
        <h2 style={{ color:"#f59e0b", marginBottom:12 }}>Backend not configured</h2>
        <p style={{ fontSize:14, color:"#94a3b8", lineHeight:1.6 }}>
          Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to a
          <code> .env.local</code> file (see <code>SETUP.md</code>), then restart the dev server.
        </p>
      </div>
    </div>
  );
  if (stage.name==="login") return <LoginScreen onLogin={handleLogin} />;
  if (stage.name==="totp") return <TOTPScreen user={stage.user} onVerify={u=>setStage({ name:"dashboard", user:u })} onBack={()=>setStage({ name:"login" })} />;
  if (stage.name==="dashboard") return <Dashboard user={stage.user} onLogout={handleLogout} />;
  return null;
}
