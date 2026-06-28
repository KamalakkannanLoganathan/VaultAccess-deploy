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
function useCountUp(target, duration = 800) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    const t0 = performance.now(); let raf;
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
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
  background:"linear-gradient(135deg, rgba(13,24,41,0.9) 0%, rgba(19,32,53,0.85) 100%)",
  backdropFilter:"blur(20px)", WebkitBackdropFilter:"blur(20px)",
  border:"1px solid rgba(255,255,255,0.08)", borderRadius:16,
  boxShadow:"0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.06)",
};
const fieldBox = { background:"rgba(0,0,0,0.25)", border:"1px solid var(--border-subtle)", borderRadius:8, padding:"8px 12px" };
const microLabel = { fontSize:10, fontWeight:600, letterSpacing:1.5, textTransform:"uppercase", color:"var(--text-muted)" };
const monoVal = (muted) => ({ fontFamily:"var(--font-mono)", fontSize:13, color: muted?"var(--text-muted)":"var(--text-primary)", wordBreak:"break-all", flex:1 });
const iconBtn = (active, disabled) => ({
  width:32, height:32, display:"inline-flex", alignItems:"center", justifyContent:"center", flexShrink:0,
  background: active?"var(--success-bg)":"rgba(255,255,255,0.05)",
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
      primary:   { background:"linear-gradient(135deg,#f5b800 0%,#d4960a 100%)", color:"#03070f", fontWeight:700, boxShadow:"0 4px 16px rgba(245,184,0,0.3)" },
      danger:    { background:"rgba(239,68,68,0.12)", color:"#f87171", border:"1px solid rgba(239,68,68,0.3)" },
      ghost:     { background:"rgba(255,255,255,0.05)", color:"var(--text-secondary)", border:"1px solid rgba(255,255,255,0.12)" },
      secondary: { background:"rgba(255,255,255,0.05)", color:"var(--text-secondary)", border:"1px solid rgba(255,255,255,0.12)" },
    };
    return { ...base, ...(variants[variant || "secondary"] || variants.secondary), ...(extra||{}) };
  },
  card: (extra) => ({ ...glass, padding:20, transition:"all 0.2s cubic-bezier(0.4,0,0.2,1)", ...(extra||{}) }),
  input: (extra) => ({ width:"100%", padding:"10px 14px", borderRadius:10,
    border:"1px solid var(--border-default)", fontSize:14, color:"var(--text-primary)", background:"rgba(0,0,0,0.3)",
    outline:"none", fontFamily:"var(--font-ui)", boxSizing:"border-box", ...(extra||{}) }),
  label: { fontSize:11, fontWeight:600, color:"var(--text-muted)", marginBottom:6, display:"block", textTransform:"uppercase", letterSpacing:1 },
  overlay: { position:"fixed", inset:0, background:"rgba(0,0,0,0.7)", backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)",
    zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center", padding:16 },
  modal: (extra) => ({ background:"var(--bg-elevated)", border:"1px solid var(--border-default)", borderTop:"2px solid var(--gold-bright)",
    borderRadius:20, boxShadow:"0 24px 80px rgba(0,0,0,0.6)", ...(extra||{}) }),
};

// ─── Global styles (CSS variables, keyframes, polish) ────────────────────────
function GlobalStyles() {
  return (
    <style>{`
      :root {
        --bg-void:#03070f; --bg-base:#080f1e; --bg-surface:#0d1829; --bg-elevated:#132035; --bg-highlight:#1a2d4a;
        --border-subtle:rgba(255,255,255,0.06); --border-default:rgba(255,255,255,0.10); --border-strong:rgba(255,255,255,0.18);
        --gold-bright:#f5b800; --gold-mid:#d4960a; --gold-dim:rgba(245,184,0,0.15); --gold-glow:rgba(245,184,0,0.25);
        --text-primary:#f0f4ff; --text-secondary:#8899b4; --text-muted:#4a5568; --text-gold:#f5b800;
        --success:#10b981; --success-bg:rgba(16,185,129,0.12); --warning:#f59e0b; --warning-bg:rgba(245,158,11,0.12);
        --danger:#ef4444; --danger-bg:rgba(239,68,68,0.12); --info:#60a5fa; --info-bg:rgba(96,165,250,0.12);
        --font-ui:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; --font-mono:'JetBrains Mono',monospace;
      }
      * { box-sizing:border-box; }
      body { font-family:var(--font-ui); color:var(--text-primary); background:var(--bg-base); }
      ::-webkit-scrollbar { width:6px; height:6px; }
      ::-webkit-scrollbar-track { background:transparent; }
      ::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.12); border-radius:3px; }
      ::-webkit-scrollbar-thumb:hover { background:rgba(255,255,255,0.22); }
      ::selection { background:rgba(245,184,0,0.25); color:#fff; }
      button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
        outline:2px solid rgba(245,184,0,0.5); outline-offset:2px;
      }
      input::placeholder, textarea::placeholder { color:var(--text-muted); }
      input, select, textarea { transition:border-color .15s ease, box-shadow .15s ease; }
      input:focus, select:focus, textarea:focus { border-color:var(--gold-bright) !important; box-shadow:0 0 0 3px var(--gold-dim); }
      select option { background:#132035; color:#f0f4ff; }
      .erc-card { transition:all 0.2s cubic-bezier(0.4,0,0.2,1); }
      .erc-card:hover { border-color:rgba(245,184,0,0.25); transform:translateY(-2px);
        box-shadow:0 8px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(245,184,0,0.15), inset 0 1px 0 rgba(255,255,255,0.08); }
      .erc-prim:hover { filter:brightness(1.1); box-shadow:0 6px 24px rgba(245,184,0,0.45); }
      .erc-prim:active { transform:scale(0.98); }
      .erc-ghost:hover { background:rgba(255,255,255,0.10) !important; color:var(--text-primary) !important; }
      .erc-pill:hover { border-color:var(--border-strong); color:var(--text-primary); }
      @keyframes ercFloat { 0%{transform:translate(0,0)} 50%{transform:translate(20px,-16px)} 100%{transform:translate(0,0)} }
      @keyframes ercShake { 0%{transform:translateX(0)} 25%{transform:translateX(-8px)} 75%{transform:translateX(8px)} 100%{transform:translateX(0)} }
      @keyframes ercFade { from{opacity:0} to{opacity:1} }
      @keyframes ercCardIn { from{opacity:0; transform:translateY(12px)} to{opacity:1; transform:translateY(0)} }
      @keyframes ercToastIn { from{opacity:0; transform:translateX(120%)} to{opacity:1; transform:translateX(0)} }
      @keyframes ercDrawerIn { from{transform:translateX(100%)} to{transform:translateX(0)} }
      @keyframes ercPulse { 0%{transform:scale(1)} 50%{transform:scale(1.15)} 100%{transform:scale(1)} }
      @keyframes ercSlideDown { from{opacity:0; transform:translateY(20px)} to{opacity:1; transform:translateY(0)} }
      .erc-page { animation:ercFade 0.15s ease; }
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
  const st = TEAM_STYLES[team] || { bg:"rgba(255,255,255,0.06)", color:"var(--text-secondary)", border:"var(--border-default)" };
  return (
    <span style={{ background:st.bg, color:st.color, border:"1px solid "+st.border,
      borderRadius:20, padding:small?"2px 8px":"3px 10px",
      fontSize:small?11:12, fontWeight:600, display:"inline-block", textTransform:"capitalize" }}>{team}</span>
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
  const dInput = { ...S.input(), background:"rgba(0,0,0,0.35)", borderColor: fieldErr ? "rgba(239,68,68,0.5)" : "var(--border-default)" };

  return (
    <div style={{ minHeight:"100vh", background:"var(--bg-void)", display:"flex", alignItems:"center",
      justifyContent:"center", flexDirection:"column", padding:20, position:"relative" }}>
      <Aurora />
      <div style={{ position:"relative", zIndex:1, width:"100%", maxWidth:440, display:"flex", flexDirection:"column", alignItems:"center" }}>
        <div style={{ textAlign:"center", marginBottom:28 }}>
          <div style={{ width:64, height:64, margin:"0 auto 16px", borderRadius:18, fontSize:34,
            background:"linear-gradient(135deg,#f5b800,#d4960a)", display:"flex", alignItems:"center", justifyContent:"center",
            boxShadow:"0 8px 32px rgba(245,184,0,0.4)" }}>🦅</div>
          <h1 style={{ color:"var(--text-primary)", fontSize:28, fontWeight:800, letterSpacing:-1 }}>Eagle RCM</h1>
          <p style={{ color:"var(--text-secondary)", fontSize:13, marginTop:6 }}>Credential intelligence for high-performing teams</p>
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
            fontSize:14, justifyContent:"center", opacity:busy?0.7:1 }}>{busy?"Signing in…":"Sign In"}</button>
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
function CredentialCard({ cred, session, onEdit, onDelete, onCopy, onCopyVerify, onFavToggle, isFav,
  requests, onRequestAccess, toast, onPatch, index }) {
  const [showPw, setShowPw] = useState(false);
  const [copied, setCopied] = useState(null);
  const hasAccess = canAccess(cred, session.team);
  const isAdmin = session.team === "admin";
  const age = daysSince(cred.updatedAt);
  const ageColor = age < 30 ? "var(--success)" : age < 60 ? "var(--warning)" : "var(--danger)";
  const catIcon = CAT_ICONS[cred.category] || CAT_ICONS.Default;
  const catTint = CAT_TINT[cred.category] || CAT_TINT.Default;
  const pendingReq = requests.find(r => r.credentialId===cred.id && r.requesterId===session.userId && r.status==="pending");
  const expiryDays = cred.passwordExpiryDays || 90;
  const daysLeft = expiryDays - age;

  const tr = evalTimeRestriction(cred.timeRestriction);
  const lockedByTime = tr.state === "expired";
  const cardExtra =
    tr.state === "expired" ? { borderLeft:"4px solid var(--danger)", background:"linear-gradient(135deg, rgba(239,68,68,0.06), rgba(19,32,53,0.85))" } :
    (tr.state === "outside" || tr.state === "wrongday" || tr.state === "expiring") ? { borderLeft:"4px solid var(--warning)" } :
    isFav ? { borderTop:"2px solid rgba(245,184,0,0.4)" } : {};

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
        {hasAccess ? <code style={monoVal(masked && !showPw)}>{value}</code> : <span style={{ fontSize:13, color:"var(--text-muted)", flex:1 }}>No access</span>}
        {hasAccess && (
          <div style={{ display:"flex", gap:6, flexShrink:0 }}>
            {showToggle && <button onClick={()=>setShowPw(p=>!p)} disabled={lockedByTime} style={iconBtn(false, lockedByTime)}>{showPw?"🙈":"👁"}</button>}
            <button onClick={()=>handleCopyField(field==="verify"?value:value, label, copyKey)} disabled={lockedByTime}
              style={iconBtn(copied===copyKey, lockedByTime)}>{copied===copyKey?"✓":"📋"}</button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="erc-card" style={{ ...S.card(), ...cardExtra, display:"flex", flexDirection:"column", gap:12,
      animation:`ercCardIn 0.3s ease-out both`, animationDelay:`${(index||0)*40}ms` }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:8 }}>
        <div style={{ display:"flex", gap:10, flex:1, minWidth:0 }}>
          <span style={{ width:36, height:36, borderRadius:"50%", background:catTint, display:"inline-flex",
            alignItems:"center", justifyContent:"center", fontSize:18, flexShrink:0 }}>{catIcon}</span>
          <div style={{ minWidth:0 }}>
            <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
              <span style={{ fontWeight:700, fontSize:15, color:"var(--text-primary)" }}>{cred.portal}</span>
              {cred.needsRotation && (
                <span style={{ background:"var(--danger-bg)", color:"#fca5a5", border:"1px solid rgba(239,68,68,0.3)",
                  borderRadius:20, padding:"2px 8px", fontSize:10, fontWeight:700 }}>Needs Rotation</span>
              )}
            </div>
            {cred.url && <a href={"https://"+cred.url} target="_blank" rel="noreferrer" style={{ color:"var(--text-secondary)", fontSize:12, textDecoration:"none" }}>🔗 {cred.url}</a>}
            {cred.client && (
              <div style={{ marginTop:3 }}>
                <span style={{ background:"var(--info-bg)", color:"var(--info)", border:"1px solid rgba(96,165,250,0.3)",
                  borderRadius:20, padding:"2px 9px", fontSize:11, fontWeight:600 }}>🏢 {cred.client}</span>
              </div>
            )}
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
          <span style={{ background:"rgba(255,255,255,0.05)", color:"var(--text-secondary)", border:"1px solid var(--border-subtle)",
            borderRadius:20, padding:"3px 10px", fontSize:11, fontWeight:600 }}>{cred.category}</span>
          <button onClick={()=>onFavToggle(cred.id)} style={{ background:"none", border:"none", cursor:"pointer", fontSize:20,
            color:isFav?"var(--gold-bright)":"var(--text-muted)", padding:0 }}>★</button>
        </div>
      </div>

      <div style={{ height:1, background:"var(--border-subtle)" }} />

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

      <FieldRow label="USERNAME" value={cred.username} field={cred.username} copyKey="user" />
      <FieldRow label="PASSWORD" value={showPw ? cred.password : "•".repeat(Math.min((cred.password||"").length, 16))}
        masked field={cred.password} copyKey="pass" showToggle />

      {hasVerify && (
        <div style={{ background:"var(--info-bg)", border:"1px solid rgba(96,165,250,0.12)", borderRadius:10, padding:"10px 12px", display:"flex", flexDirection:"column", gap:8 }}>
          <div style={{ ...microLabel, color:"var(--info)" }}>VERIFICATION</div>
          {[["📧","Email verification",cred.verifyEmail,"vEmail"],["💬","Text verification",cred.verifyText,"vText"],["🔐","Auth verification",cred.verifyAuth,"vAuth"]]
            .filter(([,,v])=>v).map(([icon,field,value,key])=>(
            <div key={key} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8 }}>
              <code style={monoVal(false)}>{icon} {value}</code>
              {hasAccess && (
                <button onClick={()=>handleCopyVerify(value, field, key)} disabled={lockedByTime} style={iconBtn(copied===key, lockedByTime)}>{copied===key?"✓":"📋"}</button>
              )}
            </div>
          ))}
        </div>
      )}

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

      {isAdmin && (
        <div style={{ display:"flex", gap:6, flexWrap:"wrap", borderTop:"1px solid var(--border-subtle)", paddingTop:8 }}>
          <button onClick={()=>onEdit(cred)} className="erc-ghost" style={{ ...S.btn("ghost"), padding:"5px 10px", fontSize:12 }}>✏️ Edit</button>
          <button onClick={()=>onDelete(cred)} style={{ ...S.btn("danger"), padding:"5px 10px", fontSize:12 }}>🗑️ Delete</button>
          <button onClick={()=>onPatch(cred.id,{ needsRotation:!cred.needsRotation })} className="erc-ghost"
            style={{ ...S.btn("ghost"), padding:"5px 10px", fontSize:12, color:cred.needsRotation?"#fca5a5":"var(--text-secondary)" }}>
            🔁 {cred.needsRotation?"Clear Rotation":"Flag Rotation"}
          </button>
          <select value={cred.passwordExpiryDays||90} onChange={e=>onPatch(cred.id,{ passwordExpiryDays:+e.target.value })}
            style={{ ...S.input(), width:"auto", padding:"5px 8px", fontSize:12 }}>
            {[30,60,90,180].map(d=><option key={d} value={d}>{d}d expiry</option>)}
          </select>
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
                {TEAMS.filter(t=>t!=="admin").map(t=>{ const on=selTeams.includes(t);
                  return (
                    <label key={t} style={{ display:"flex", alignItems:"center", gap:4, cursor:"pointer", padding:"5px 12px",
                      border:"1px solid "+(on?"var(--info)":"var(--border-default)"), borderRadius:20, fontSize:12,
                      background:on?"var(--info-bg)":"rgba(0,0,0,0.3)", color:on?"var(--info)":"var(--text-secondary)" }}>
                      <input type="checkbox" checked={on} onChange={()=>toggleTeam(t)} style={{ display:"none" }} />{t}
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
  const [form, setForm] = useState(user
    ? { name:user.name, username:user.username, team:user.team, password:"" }
    : { name:"", username:"", password:"", team:"engineering" });
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
  const st = TEAM_STYLES[form.team] || TEAM_STYLES.engineering;

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
            <label style={S.label}>Team</label>
            <select value={form.team} onChange={e=>set("team",e.target.value)} style={S.input()}>
              {TEAMS.map(t=><option key={t} value={t}>{t}</option>)}
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
  const pill = (c,label) => <span style={{ background:c+"22", color:c, border:"1px solid "+c+"55", borderRadius:20, padding:"3px 10px", fontSize:12, fontWeight:600 }}>{label}</span>;

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal(), padding:28, width:"95vw", maxWidth:780, maxHeight:"85vh", overflowY:"auto" }}>
        <h3 style={{ fontWeight:700, marginBottom:12, color:"var(--text-primary)", fontSize:18 }}>Import Preview</h3>
        <div style={{ display:"flex", gap:8, marginBottom:16 }}>
          {pill("#10b981", `${valid} valid`)}{pill("#ef4444", `${errs} errors`)}{pill("#f59e0b", `${dups} duplicates`)}
        </div>
        <div style={{ maxHeight:340, overflowY:"auto", marginBottom:16, border:"1px solid var(--border-subtle)", borderRadius:12 }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
            <thead>
              <tr>{["Status","Portal","URL","Username","Category","Teams"].map(h=>(
                <th key={h} style={{ background:"rgba(0,0,0,0.3)", padding:"10px", textAlign:"left", color:"var(--text-muted)",
                  borderBottom:"1px solid var(--border-default)", fontWeight:600, position:"sticky", top:0, textTransform:"uppercase", letterSpacing:1, fontSize:10 }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {processed.map((r,i)=>(
                <tr key={i} style={{ background:r._status==="valid"?"rgba(16,185,129,0.06)":r._status==="error"?"rgba(239,68,68,0.06)":"rgba(245,158,11,0.06)", color:"var(--text-secondary)" }}>
                  <td style={{ padding:"7px 10px", fontWeight:600, fontStyle:r._status==="error"?"italic":"normal",
                    color:r._status==="valid"?"var(--success)":r._status==="error"?"#fca5a5":"#fcd34d" }}>
                    {r._status==="valid"?"● Valid":r._status==="error"?("● "+r._errors.join(",")):"● Will overwrite"}
                  </td>
                  <td style={{ padding:"7px 10px" }}>{r.Portal}</td>
                  <td style={{ padding:"7px 10px" }}>{r.URL}</td>
                  <td style={{ padding:"7px 10px" }}>{r.Username}</td>
                  <td style={{ padding:"7px 10px" }}>{r.Category}</td>
                  <td style={{ padding:"7px 10px" }}>{r.Teams}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
          <button onClick={onClose} className="erc-ghost" style={S.btn("ghost")}>Cancel</button>
          <button onClick={()=>onConfirm(processed)} className="erc-prim" style={S.btn("primary")}>Import {valid} Valid Row(s)</button>
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

// ─── Profile Drawer ──────────────────────────────────────────────────────────
function ProfilePanel({ session, currentUser, onClose, onUserUpdate, toast, copyHistory }) {
  const [section, setSection] = useState("main");
  const [cpForm, setCpForm] = useState({ current:"", newPw:"", confirm:"" });
  const [cpError, setCpError] = useState("");
  const [busy, setBusy] = useState(false);
  const [myRequests, setMyRequests] = useState([]);
  const st = TEAM_STYLES[currentUser.team] || TEAM_STYLES.engineering;

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
        <div style={{ marginBottom:8 }}>
          <h4 style={heading}>Change Password</h4>
          {[["Current Password","current"],["New Password","newPw"],["Confirm New","confirm"]].map(([lbl,key])=>(
            <div key={key} style={{ marginBottom:10 }}>
              <label style={S.label}>{lbl}</label>
              <input type="password" value={cpForm[key]} onChange={e=>setCpForm(p=>({...p,[key]:e.target.value}))} style={S.input()} />
            </div>
          ))}
          {cpForm.newPw && <StrengthBar password={cpForm.newPw} />}
          {cpError && <p style={{ color:"#fca5a5", fontSize:13, marginTop:6 }}>{cpError}</p>}
          <button onClick={handleChangePw} disabled={busy} className="erc-prim" style={{ ...S.btn("primary"), marginTop:10, width:"100%", justifyContent:"center", opacity:busy?0.7:1 }}>Update Password</button>
        </div>
        <Divider />

        <div style={{ marginBottom:8 }}>
          <h4 style={{ ...heading, color:"var(--text-gold)" }}>📋 Session copy history</h4>
          {copyHistory.length>0 ? copyHistory.map((item,i)=>(
            <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 12px",
              background:"rgba(0,0,0,0.25)", border:"1px solid var(--border-subtle)", borderRadius:8, marginBottom:6, fontSize:13 }}>
              <span style={{ color:"var(--text-primary)" }}><strong>{item.portal}</strong> <span style={{ color:"var(--text-muted)" }}>· {item.field}</span></span>
              <span style={{ color:"var(--text-muted)", fontSize:11 }}>{timeAgo(item.time)}</span>
            </div>
          )) : <p style={{ color:"var(--text-muted)", fontSize:13, fontStyle:"italic" }}>Nothing copied this session</p>}
        </div>
        <Divider />

        <div style={{ marginBottom:8 }}>
          <h4 style={heading}>Two-Factor Authentication</h4>
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
        </div>

        {myRequests.length>0 && (<><Divider /><div>
          <h4 style={heading}>My Access Requests</h4>
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
        </div></>)}
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
            {categories.map(cat=>(
              <React.Fragment key={cat}>
                <tr>
                  <td colSpan={teams.length+1} style={{ background:"rgba(0,0,0,0.25)", padding:"6px 14px", fontWeight:700, color:"var(--text-muted)", fontSize:10, letterSpacing:1.5, textTransform:"uppercase" }}>{cat}</td>
                </tr>
                {creds.filter(c=>c.category===cat).map((cred,i)=>(
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
        justifyContent:"center", fontSize:34, margin:"0 auto 16px" }}>{icon}</div>
      <div style={{ fontSize:16, fontWeight:600, color:"var(--text-primary)", marginBottom:6 }}>{title}</div>
      <div style={{ fontSize:13, color:"var(--text-secondary)", marginBottom:action?18:0 }}>{sub}</div>
      {action}
    </div>
  );
}

// ─── Loading splash ───────────────────────────────────────────────────────────
function Splash({ text }) {
  return (
    <div style={{ minHeight:"100vh", background:"var(--bg-void)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", color:"var(--text-secondary)", gap:14 }}>
      <div style={{ width:60, height:60, borderRadius:16, fontSize:32, background:"linear-gradient(135deg,#f5b800,#d4960a)",
        display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"0 8px 32px rgba(245,184,0,0.4)" }}>🦅</div>
      <div style={{ fontSize:14 }}>{text||"Loading…"}</div>
    </div>
  );
}

// ─── Stat Card ───────────────────────────────────────────────────────────────
function StatCard({ icon, val, label, descriptor, accent }) {
  const num = useCountUp(typeof val === "number" ? val : 0);
  const display = typeof val === "number" ? num : val;
  return (
    <div style={{ ...glass, padding:20, flex:1, minWidth:150, position:"relative", overflow:"hidden" }}>
      <div style={{ position:"absolute", left:0, top:12, bottom:12, width:3, borderRadius:3, background:accent }} />
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10, paddingLeft:8 }}>
        <span style={{ fontSize:20 }}>{icon}</span>
        <span style={microLabel}>{label}</span>
      </div>
      <div style={{ fontSize:36, fontWeight:800, color:"var(--text-primary)", lineHeight:1, paddingLeft:8 }}>{display}</div>
      <div style={{ fontSize:12, color:"var(--text-muted)", marginTop:6, paddingLeft:8 }}>{descriptor}</div>
    </div>
  );
}

// ─── Glass toolbar wrapper ───────────────────────────────────────────────────
const toolbar = { background:"rgba(8,15,30,0.8)", border:"1px solid var(--border-subtle)", borderRadius:14, padding:"12px 16px",
  display:"flex", gap:10, flexWrap:"wrap", alignItems:"center", marginBottom:16 };

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
  const [warnDismissed, setWarnDismissed] = useState(false);

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
    XLSX.writeFile(wb,"EagleRCM-Export.xlsx"); toast("Exported!","success");
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
    XLSX.writeFile(wb,"EagleRCM-Template.xlsx"); toast("Template downloaded!","success");
  };

  const stats = {
    accessible: accessible.length,
    categories: new Set(accessible.map(c=>c.category)).size,
    clientsCount: new Set(creds.map(c=>c.client||"").filter(Boolean)).size,
    restricted: restrictedCount,
    team: accessible.filter(c=>c.teams!=="all"&&Array.isArray(c.teams)&&c.teams.includes(session.team)).length,
    total: creds.length,
  };

  const catPill = (active) => ({ padding:"6px 14px", fontSize:13, borderRadius:20, cursor:"pointer", fontWeight: active?600:500,
    border:"1px solid "+(active?"var(--gold-bright)":"var(--border-default)"), background:active?"var(--gold-dim)":"transparent",
    color:active?"var(--gold-bright)":"var(--text-secondary)", transition:"all .15s ease" });

  if (loading) return <Splash text="Loading credentials…" />;

  return (
    <div className="erc-page">
      {(rotationWarning.length>0 || expiredCount>0) && !warnDismissed && (
        <div style={{ background:"linear-gradient(90deg, rgba(245,158,11,0.12) 0%, rgba(245,158,11,0.06) 100%)",
          borderLeft:"3px solid var(--warning)", border:"1px solid rgba(245,158,11,0.25)", borderRadius:12, padding:"14px 18px",
          marginBottom:20, display:"flex", alignItems:"center", gap:12 }}>
          <span style={{ width:32, height:32, borderRadius:"50%", background:"rgba(245,158,11,0.2)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>⚠️</span>
          <span style={{ color:"#fcd34d", fontWeight:600, fontSize:14, flex:1 }}>
            {rotationWarning.length>0 && `${rotationWarning.length} credential(s) need rotation or expiring within 7 days.`}
            {rotationWarning.length>0 && expiredCount>0 && " "}
            {expiredCount>0 && `${expiredCount} time-restricted credential(s) have expired.`}
          </span>
          <button onClick={()=>setWarnDismissed(true)} style={{ background:"none", border:"none", color:"var(--text-muted)", cursor:"pointer", fontSize:16 }}>✕</button>
        </div>
      )}

      <div style={{ display:"flex", gap:14, marginBottom:24, flexWrap:"wrap" }}>
        <StatCard icon="🔑" val={stats.accessible} label="Accessible" descriptor="credentials you can use" accent="var(--gold-bright)" />
        <StatCard icon="📂" val={stats.categories} label="Categories" descriptor="distinct types" accent="var(--info)" />
        <StatCard icon="🏢" val={stats.clientsCount} label="Clients" descriptor="organisations" accent="#a78bfa" />
        <StatCard icon="⏰" val={stats.restricted} label="Restricted" descriptor="time-limited now" accent="var(--danger)" />
        <StatCard icon="👥" val={stats.team} label={"Team · "+session.team} descriptor="team-scoped" accent={(TEAM_STYLES[session.team]||TEAM_STYLES.engineering).color} />
        {isAdmin && <StatCard icon="📊" val={stats.total} label="Total" descriptor="across the vault" accent="var(--success)" />}
      </div>

      {recentViewed.length>0 && (
        <div style={{ marginBottom:20 }}>
          <div style={{ ...microLabel, color:"var(--text-gold)", marginBottom:8 }}>🕘 Recently viewed</div>
          <div style={{ display:"flex", gap:10, overflowX:"auto", paddingBottom:4 }}>
            {recentViewed.map(c=>(
              <div key={c.id} className="erc-card" style={{ ...glass, height:44, display:"flex", alignItems:"center", gap:8, padding:"0 14px",
                whiteSpace:"nowrap", fontSize:13, fontWeight:600, color:"var(--text-primary)", flexShrink:0 }}>
                {CAT_ICONS[c.category]||"🔑"} {c.portal} <span style={{ color:"var(--text-muted)", fontWeight:400 }}>· {timeAgo(c.updatedAt)}</span>
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
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(360px,1fr))", gap:16 }}>
            {pinned.map((c,i)=>(
              <CredentialCard key={c.id} index={i} cred={c} session={session} onEdit={setEditCred} onDelete={setDeleteCredState}
                onCopy={handleCopy} onCopyVerify={handleCopyVerify} onFavToggle={handleFavToggle} isFav={true} requests={requests}
                onRequestAccess={setRequestCred} toast={toast} onPatch={handlePatch} />
            ))}
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
        <button onClick={()=>setRestrictedOnly(v=>!v)} style={catPill(restrictedOnly)}>⏰ Time-Restricted</button>
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

      <div style={{ display:"flex", gap:8, marginBottom:10, flexWrap:"wrap", alignItems:"center" }}>
        <span style={microLabel}>Category</span>
        {categories.map(c=>(<button key={c} className="erc-pill" onClick={()=>setCatFilter(c)} style={catPill(catFilter===c)}>{c}</button>))}
      </div>

      {clients.length>1 && (
        <div style={{ display:"flex", gap:8, marginBottom:18, flexWrap:"wrap", alignItems:"center" }}>
          <span style={microLabel}>Client</span>
          {clients.map(cl=>(<button key={cl} className="erc-pill" onClick={()=>setClientFilter(cl)} style={catPill(clientFilter===cl)}>{cl==="All"?"All Clients":"🏢 "+cl}</button>))}
        </div>
      )}

      <div style={{ fontSize:13, color:"var(--text-muted)", marginBottom:14 }}>{filtered.length} credential(s) found</div>

      {filtered.length===0 ? (
        search||catFilter!=="All"||clientFilter!=="All"||restrictedOnly
          ? <EmptyState icon="🔍" title="Nothing matched" sub="Try different search terms or clear filters" />
          : <EmptyState icon="🔑" title="No credentials yet" sub="Add your first credential to get started"
              action={isAdmin && <button onClick={()=>setShowAdd(true)} className="erc-prim" style={S.btn("primary")}>+ Add Credential</button>} />
      ) : (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(360px,1fr))", gap:16 }}>
          {unpinned.map((c,i)=>(
            <CredentialCard key={c.id} index={i} cred={c} session={session} onEdit={setEditCred} onDelete={setDeleteCredState}
              onCopy={handleCopy} onCopyVerify={handleCopyVerify} onFavToggle={handleFavToggle} isFav={false} requests={requests}
              onRequestAccess={setRequestCred} toast={toast} onPatch={handlePatch} />
          ))}
        </div>
      )}

      {(editCred||showAdd) && (
        <CredModal cred={editCred} onSave={handleSave} onClose={()=>{ setEditCred(null); setShowAdd(false); }} session={session} />
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

  const teamPill = (active) => ({ ...S.btn(active?"primary":"ghost"), padding:"6px 14px", fontSize:13 });

  if (loading) return <Splash text="Loading users…" />;

  return (
    <div className="erc-page">
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16, flexWrap:"wrap", gap:10 }}>
        <div style={{ fontWeight:700, color:"var(--text-primary)", fontSize:20 }}>
          Users <span style={{ color:"var(--text-muted)", fontSize:14, fontWeight:400 }}>({users.length})</span>
        </div>
        <div style={{ display:"flex", gap:8 }}>
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
              {["All",...TEAMS].map(t=>(<button key={t} onClick={()=>setTeamFilter(t)} style={teamPill(teamFilter===t)}>{t}</button>))}
            </div>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))", gap:16 }}>
            {filtered.map((u,i)=>{
              const accessCount=creds.filter(c=>canAccess(c,u.team)).length;
              const st=TEAM_STYLES[u.team]||TEAM_STYLES.engineering;
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
    add:"#10b981", approve:"#10b981", add_user:"#10b981", bulk_import:"#10b981",
    login:"#60a5fa", view:"#60a5fa", copy:"#60a5fa", copy_verify:"#60a5fa", logout:"#60a5fa",
    edit:"#f59e0b", access_request:"#f59e0b", edit_user:"#f59e0b", password_changed:"#f59e0b",
    delete:"#ef4444", deny:"#ef4444", login_failed:"#ef4444", remove_user:"#ef4444",
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
            {filtered.map(r=>{ const st=TEAM_STYLES[r.requesterTeam]||TEAM_STYLES.engineering;
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
  const st = TEAM_STYLES[currentUser.team] || TEAM_STYLES.engineering;

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

  const gridBg = {
    minHeight:"100vh", background:"var(--bg-base)",
    backgroundImage:"linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)",
    backgroundSize:"40px 40px",
  };

  return (
    <div style={gridBg}>
      <GlobalStyles />
      <ToastContainer toasts={toasts} />

      <header style={{ background:"rgba(8,15,30,0.95)", backdropFilter:"blur(20px)", WebkitBackdropFilter:"blur(20px)",
        padding:"0 24px", height:64, display:"flex", alignItems:"center", justifyContent:"space-between",
        position:"sticky", top:0, zIndex:100, borderBottom:"1px solid var(--border-subtle)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ width:32, height:32, borderRadius:9, background:"linear-gradient(135deg,#f5b800,#d4960a)", display:"inline-flex",
            alignItems:"center", justifyContent:"center", fontSize:18, boxShadow:"0 2px 12px rgba(245,184,0,0.35)" }}>🦅</span>
          <span style={{ color:"var(--text-primary)", fontWeight:700, fontSize:16, letterSpacing:-0.3 }}>Eagle RCM</span>
        </div>

        {TABS.length>1 && (
          <div style={{ display:"flex", gap:4, background:"rgba(0,0,0,0.3)", border:"1px solid var(--border-subtle)", borderRadius:12, padding:4 }}>
            {TABS.map(t=>{ const on=tab===t;
              return (
                <button key={t} onClick={()=>setTab(t)} style={{ display:"flex", alignItems:"center", gap:6, padding:"6px 14px", fontSize:13, fontWeight:on?600:500, cursor:"pointer",
                  borderRadius:9, border:"none", transition:"all 0.2s ease",
                  background:on?"var(--bg-elevated)":"transparent", color:on?"var(--text-primary)":"var(--text-muted)",
                  boxShadow:on?"0 2px 8px rgba(0,0,0,0.4)":"none" }}>
                  {TAB_LABELS[t]}
                  {t==="requests"&&pendingCount>0&&(<span style={{ width:6, height:6, borderRadius:"50%", background:"var(--gold-bright)" }} />)}
                </button>
              ); })}
          </div>
        )}

        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          {isAdmin && pendingCount>0 && (
            <div style={{ position:"relative", fontSize:18, cursor:"default" }} title={`${pendingCount} pending request(s)`}>🔔
              <span style={{ position:"absolute", top:-2, right:-2, width:8, height:8, borderRadius:"50%", background:"var(--gold-bright)" }} />
            </div>
          )}
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
        {tab==="credentials" && <CredentialsTab session={session} toast={toast} />}
        {tab==="users"&&isAdmin && <UsersTab session={session} toast={toast} />}
        {tab==="audit"&&isAdmin && <AuditTab session={session} toast={toast} />}
        {tab==="requests"&&isAdmin && <AccessRequestsTab session={session} toast={toast} onChange={refreshPending} />}
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
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function EagleRCM() {
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
  if (stage.name==="login") return <><GlobalStyles /><LoginScreen onLogin={handleLogin} /></>;
  if (stage.name==="totp") return <><GlobalStyles /><TOTPScreen user={stage.user} onVerify={u=>setStage({ name:"dashboard", user:u })} onBack={()=>setStage({ name:"login" })} /></>;
  if (stage.name==="dashboard") return <Dashboard user={stage.user} onLogout={handleLogout} />;
  return null;
}
