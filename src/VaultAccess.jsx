import { useState, useEffect } from "react";

const TEAMS = ["engineering", "marketing", "design", "ops"];
const CATEGORIES = ["Development", "Infrastructure", "Design", "Marketing", "Communication", "Finance", "HR", "Other"];

const DEFAULT_USERS = [
  { id: "1", name: "Alex Chen", username: "alex", password: "admin123", team: "admin", avatar: "AC" },
  { id: "2", name: "Sam Rivera", username: "sam", password: "eng123", team: "engineering", avatar: "SR" },
  { id: "3", name: "Morgan Lee", username: "morgan", password: "mkt123", team: "marketing", avatar: "ML" },
  { id: "4", name: "Jordan Park", username: "jordan", password: "des123", team: "design", avatar: "JP" },
  { id: "5", name: "Casey Kim", username: "casey", password: "ops123", team: "ops", avatar: "CK" },
];

const DEFAULT_CREDENTIALS = [
  { id: "1", portal: "GitHub", url: "github.com", username: "org-dev-team", password: "ghp_K9mX2pQrTs8vL4nW", category: "Development", teams: ["engineering"], addedBy: "Alex Chen", addedAt: "2025-01-15" },
  { id: "2", portal: "AWS Console", url: "console.aws.amazon.com", username: "aws-devops@company.com", password: "Aws#2024!Secure", category: "Infrastructure", teams: ["engineering"], addedBy: "Alex Chen", addedAt: "2025-02-03" },
  { id: "3", portal: "Figma", url: "figma.com", username: "design@company.com", password: "Fig@Creative24!", category: "Design", teams: ["design", "marketing"], addedBy: "Alex Chen", addedAt: "2025-01-28" },
  { id: "4", portal: "HubSpot", url: "app.hubspot.com", username: "marketing@company.com", password: "Hub$pot2024!", category: "Marketing", teams: ["marketing"], addedBy: "Alex Chen", addedAt: "2025-03-10" },
  { id: "5", portal: "Google Workspace", url: "workspace.google.com", username: "admin@company.com", password: "GWs@Admin2024", category: "Communication", teams: "all", addedBy: "Alex Chen", addedAt: "2025-01-01" },
  { id: "6", portal: "Notion", url: "notion.so", username: "team@company.com", password: "N0tion$Team!", category: "Communication", teams: "all", addedBy: "Alex Chen", addedAt: "2025-01-01" },
  { id: "7", portal: "Jira", url: "company.atlassian.net", username: "jira-admin@company.com", password: "Jira#Mgmt2025", category: "Development", teams: ["engineering"], addedBy: "Alex Chen", addedAt: "2025-02-20" },
  { id: "8", portal: "Salesforce", url: "login.salesforce.com", username: "sales@company.com", password: "Sf@Sales2025!", category: "Marketing", teams: ["marketing"], addedBy: "Alex Chen", addedAt: "2025-03-05" },
  { id: "9", portal: "Adobe Creative Cloud", url: "creativecloud.adobe.com", username: "design@company.com", password: "Adobe#CC2025!", category: "Design", teams: ["design"], addedBy: "Alex Chen", addedAt: "2025-01-18" },
  { id: "10", portal: "Datadog", url: "app.datadoghq.com", username: "monitoring@company.com", password: "D@tadog!Ops25", category: "Infrastructure", teams: ["ops", "engineering"], addedBy: "Alex Chen", addedAt: "2025-02-14" },
];

const teamBadge = {
  admin:       { bg: "#fef3c7", text: "#92400e", border: "#fde68a" },
  engineering: { bg: "#dbeafe", text: "#1e40af", border: "#bfdbfe" },
  marketing:   { bg: "#fce7f3", text: "#9d174d", border: "#fbcfe8" },
  design:      { bg: "#ede9fe", text: "#6d28d9", border: "#ddd6fe" },
  ops:         { bg: "#dcfce7", text: "#166534", border: "#bbf7d0" },
};

// ─── localStorage helpers (replaces window.storage) ─────────────────────────
const storage = {
  get: (key) => {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; }
  },
  set: (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
};

const CategoryIcon = ({ category }) => {
  const icons = { Development: "💻", Infrastructure: "🖥️", Design: "🎨", Marketing: "📣", Communication: "💬", Finance: "💰", HR: "👥", Other: "📁" };
  return <span>{icons[category] || "📁"}</span>;
};

export default function VaultAccess() {
  const [screen, setScreen]                 = useState("login");
  const [currentUser, setCurrentUser]       = useState(null);
  const [users, setUsers]                   = useState(DEFAULT_USERS);
  const [credentials, setCredentials]       = useState(DEFAULT_CREDENTIALS);
  const [loginUsername, setLoginUsername]   = useState("");
  const [loginPassword, setLoginPassword]   = useState("");
  const [loginError, setLoginError]         = useState("");
  const [showLoginPass, setShowLoginPass]   = useState(false);
  const [searchQuery, setSearchQuery]       = useState("");
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [revealedPasswords, setRevealedPasswords] = useState({});
  const [copiedId, setCopiedId]             = useState(null);
  const [showModal, setShowModal]           = useState(false);
  const [editingCred, setEditingCred]       = useState(null);
  const [activeTab, setActiveTab]           = useState("credentials");
  const [form, setForm]                     = useState({ portal: "", url: "", username: "", password: "", category: "Development", teams: [] });
  const [formReveal, setFormReveal]         = useState(false);
  const [deleteConfirm, setDeleteConfirm]   = useState(null);
  const [toast, setToast]                   = useState(null);

  // Load persisted data on mount
  useEffect(() => {
    const savedCreds = storage.get("vault_credentials");
    const savedUsers = storage.get("vault_users");
    if (savedCreds) setCredentials(savedCreds);
    if (savedUsers) setUsers(savedUsers);
  }, []);

  const showToast = (msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2500);
  };

  const saveCredentials = (creds) => { setCredentials(creds); storage.set("vault_credentials", creds); };
  const saveUsers       = (u)     => { setUsers(u);           storage.set("vault_users", u); };

  const handleLogin = () => {
    const user = users.find(u => u.username === loginUsername.trim() && u.password === loginPassword);
    if (user) {
      setCurrentUser(user); setScreen("dashboard"); setLoginError("");
      setLoginUsername(""); setLoginPassword("");
    } else {
      setLoginError("Invalid credentials. Please try again.");
    }
  };

  const visibleCredentials = credentials.filter(cred => {
    const teamMatch   = currentUser?.team === "admin" || cred.teams === "all" || (Array.isArray(cred.teams) && cred.teams.includes(currentUser?.team));
    const search      = searchQuery.toLowerCase();
    const searchMatch = !searchQuery || cred.portal.toLowerCase().includes(search) || cred.username.toLowerCase().includes(search) || cred.category.toLowerCase().includes(search) || (cred.url || "").toLowerCase().includes(search);
    const catMatch    = selectedCategory === "All" || cred.category === selectedCategory;
    return teamMatch && searchMatch && catMatch;
  });

  const allCategories  = ["All", ...new Set(credentials.map(c => c.category).filter(Boolean))];
  const toggleReveal   = (id) => setRevealedPasswords(p => ({ ...p, [id]: !p[id] }));

  const copy = async (text, id) => {
    try { await navigator.clipboard.writeText(text); setCopiedId(id); showToast("Copied to clipboard"); setTimeout(() => setCopiedId(null), 2000); }
    catch { showToast("Copy failed", "error"); }
  };

  const openAdd = () => {
    setEditingCred(null);
    setForm({ portal: "", url: "", username: "", password: "", category: "Development", teams: [] });
    setFormReveal(false); setShowModal(true);
  };

  const openEdit = (cred) => {
    setEditingCred(cred);
    setForm({ portal: cred.portal, url: cred.url || "", username: cred.username, password: cred.password, category: cred.category, teams: cred.teams === "all" ? ["all"] : [...(cred.teams || [])] });
    setFormReveal(false); setShowModal(true);
  };

  const handleSave = () => {
    if (!form.portal.trim() || !form.username.trim() || !form.password.trim()) return;
    const teams = form.teams.includes("all") ? "all" : form.teams;
    if (editingCred) {
      saveCredentials(credentials.map(c => c.id === editingCred.id ? { ...c, ...form, teams } : c));
      showToast(`"${form.portal}" updated`);
    } else {
      saveCredentials([...credentials, { id: Date.now().toString(), ...form, teams, addedBy: currentUser.name, addedAt: new Date().toISOString().split("T")[0] }]);
      showToast(`"${form.portal}" added`);
    }
    setShowModal(false);
  };

  const handleDelete = (id) => {
    const cred = credentials.find(c => c.id === id);
    saveCredentials(credentials.filter(c => c.id !== id));
    setDeleteConfirm(null); showToast(`"${cred?.portal}" removed`, "error");
  };

  const toggleTeamInForm = (team) => {
    setForm(f => {
      if (team === "all") return { ...f, teams: f.teams.includes("all") ? [] : ["all"] };
      const filtered = f.teams.filter(t => t !== "all");
      return { ...f, teams: filtered.includes(team) ? filtered.filter(t => t !== team) : [...filtered, team] };
    });
  };

  const s = {
    root:  { fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", minHeight: "100vh", background: "#f0f2f5" },
    header:{ background: "#0a0f1e", borderBottom: "1px solid #1a2332", padding: "0 28px", display: "flex", alignItems: "center", justifyContent: "space-between", height: "58px", position: "sticky", top: 0, zIndex: 10 },
    main:  { padding: "28px", maxWidth: "1200px", margin: "0 auto" },
    label: { display: "block", fontSize: "11px", fontWeight: "600", color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: "5px" },
    input: { width: "100%", padding: "9px 12px", border: "1px solid #e5e9f0", borderRadius: "8px", fontSize: "14px", outline: "none", boxSizing: "border-box", color: "#0f172a" },
    btn:   { padding: "9px 18px", borderRadius: "8px", border: "none", fontSize: "13px", fontWeight: "600", cursor: "pointer" },
    pill:  (active) => ({ padding: "5px 14px", borderRadius: "20px", border: `1px solid ${active ? "#f59e0b" : "#e5e9f0"}`, background: active ? "#fef9ee" : "white", color: active ? "#92400e" : "#64748b", fontSize: "12px", fontWeight: active ? "600" : "400", cursor: "pointer", whiteSpace: "nowrap" }),
    mono:  { fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace" },
  };

  // ─── LOGIN ──────────────────────────────────────────────────────────────────
  if (screen === "login") {
    return (
      <div style={{ minHeight: "100vh", background: "#060d1a", display: "flex", alignItems: "center", justifyContent: "center", padding: "2rem", fontFamily: "'Inter', sans-serif" }}>
        <div style={{ width: "100%", maxWidth: "420px" }}>
          <div style={{ textAlign: "center", marginBottom: "2.5rem" }}>
            <div style={{ width: "60px", height: "60px", background: "linear-gradient(135deg, #f59e0b 0%, #d97706 100%)", borderRadius: "16px", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: "28px" }}>🔐</div>
            <h1 style={{ color: "white", fontSize: "28px", fontWeight: "800", margin: 0, letterSpacing: "-0.5px" }}>VaultAccess</h1>
            <p style={{ color: "#475569", margin: "8px 0 0", fontSize: "14px" }}>Secure team credential management</p>
          </div>
          <div style={{ background: "#0f1a2e", borderRadius: "16px", padding: "28px", border: "1px solid #1e2d45" }}>
            <div style={{ marginBottom: "18px" }}>
              <label style={{ display: "block", color: "#64748b", fontSize: "11px", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: "7px" }}>Username</label>
              <input type="text" value={loginUsername} onChange={e => { setLoginUsername(e.target.value); setLoginError(""); }} onKeyDown={e => e.key === "Enter" && handleLogin()} placeholder="Enter your username" style={{ width: "100%", padding: "11px 14px", background: "#060d1a", border: `1px solid ${loginError ? "#7f1d1d" : "#1e2d45"}`, borderRadius: "9px", color: "white", fontSize: "14px", outline: "none", boxSizing: "border-box" }} />
            </div>
            <div style={{ marginBottom: "20px" }}>
              <label style={{ display: "block", color: "#64748b", fontSize: "11px", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: "7px" }}>Password</label>
              <div style={{ position: "relative" }}>
                <input type={showLoginPass ? "text" : "password"} value={loginPassword} onChange={e => { setLoginPassword(e.target.value); setLoginError(""); }} onKeyDown={e => e.key === "Enter" && handleLogin()} placeholder="Enter your password" style={{ width: "100%", padding: "11px 42px 11px 14px", background: "#060d1a", border: `1px solid ${loginError ? "#7f1d1d" : "#1e2d45"}`, borderRadius: "9px", color: "white", fontSize: "14px", outline: "none", boxSizing: "border-box" }} />
                <button onClick={() => setShowLoginPass(p => !p)} style={{ position: "absolute", right: "12px", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#475569", fontSize: "16px", padding: 0 }}>{showLoginPass ? "🙈" : "👁️"}</button>
              </div>
            </div>
            {loginError && <div style={{ background: "rgba(127,29,29,0.4)", border: "1px solid #7f1d1d", borderRadius: "8px", padding: "10px 14px", color: "#fca5a5", fontSize: "13px", marginBottom: "18px" }}>⚠️ {loginError}</div>}
            <button onClick={handleLogin} style={{ width: "100%", padding: "12px", background: "linear-gradient(135deg, #f59e0b, #d97706)", border: "none", borderRadius: "9px", color: "#0f172a", fontSize: "14px", fontWeight: "700", cursor: "pointer" }}>Sign In →</button>
          </div>
        </div>
      </div>
    );
  }

  // ─── DASHBOARD ──────────────────────────────────────────────────────────────
  const isAdmin    = currentUser.team === "admin";
  const userBadge  = teamBadge[currentUser.team] || teamBadge.engineering;

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{ width: "32px", height: "32px", background: "linear-gradient(135deg, #f59e0b, #d97706)", borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "16px" }}>🔐</div>
          <span style={{ color: "white", fontWeight: "700", fontSize: "16px", letterSpacing: "-0.3px" }}>VaultAccess</span>
        </div>
        {isAdmin && (
          <div style={{ display: "flex", gap: "4px", background: "#111827", borderRadius: "8px", padding: "4px" }}>
            {["credentials", "users"].map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{ padding: "6px 16px", borderRadius: "6px", border: "none", cursor: "pointer", background: activeTab === tab ? "#1e2d45" : "transparent", color: activeTab === tab ? "white" : "#475569", fontSize: "13px", fontWeight: "500", textTransform: "capitalize" }}>
                {tab === "credentials" ? "🔑 Credentials" : "👥 Users"}
              </button>
            ))}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ color: "white", fontSize: "13px", fontWeight: "600" }}>{currentUser.name}</div>
            <div style={{ fontSize: "11px", color: "#475569", textTransform: "capitalize" }}>{currentUser.team}</div>
          </div>
          <div style={{ width: "36px", height: "36px", background: userBadge.bg, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: userBadge.text, fontSize: "11px", fontWeight: "700", border: `2px solid ${userBadge.border}` }}>{currentUser.avatar}</div>
          <button onClick={() => { setScreen("login"); setCurrentUser(null); setRevealedPasswords({}); }} style={{ background: "transparent", border: "1px solid #1e2d45", borderRadius: "7px", color: "#64748b", padding: "6px 12px", fontSize: "12px", cursor: "pointer" }}>Sign out</button>
        </div>
      </div>

      {toast && (
        <div style={{ position: "fixed", top: "70px", right: "24px", zIndex: 99, background: toast.type === "error" ? "#fee2e2" : "#dcfce7", color: toast.type === "error" ? "#991b1b" : "#166534", border: `1px solid ${toast.type === "error" ? "#fca5a5" : "#86efac"}`, borderRadius: "8px", padding: "10px 16px", fontSize: "13px", fontWeight: "600", boxShadow: "0 4px 12px rgba(0,0,0,0.15)" }}>
          {toast.type === "error" ? "🗑️" : "✅"} {toast.msg}
        </div>
      )}

      <div style={s.main}>
        {(activeTab === "credentials" || !isAdmin) && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "14px", marginBottom: "24px" }}>
              {[
                { label: "Accessible Credentials", value: visibleCredentials.length, icon: "🔑", color: "#fef9ee", border: "#fde68a" },
                { label: "Categories", value: new Set(visibleCredentials.map(c => c.category)).size, icon: "📂", color: "#eff6ff", border: "#bfdbfe" },
                { label: "Team", value: currentUser.team, icon: "👥", color: userBadge.bg, border: userBadge.border },
                ...(isAdmin ? [{ label: "Total Entries", value: credentials.length, icon: "📋", color: "#f0fdf4", border: "#bbf7d0" }] : []),
              ].map((stat, i) => (
                <div key={i} style={{ background: stat.color, borderRadius: "12px", padding: "16px 18px", border: `1px solid ${stat.border}` }}>
                  <div style={{ fontSize: "22px", marginBottom: "6px" }}>{stat.icon}</div>
                  <div style={{ fontSize: "22px", fontWeight: "800", color: "#0f172a", lineHeight: 1 }}>{stat.value}</div>
                  <div style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>{stat.label}</div>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: "12px", marginBottom: "20px", alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: "220px", position: "relative" }}>
                <span style={{ position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)", color: "#94a3b8" }}>🔍</span>
                <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search portals, usernames, URLs..." style={{ ...s.input, paddingLeft: "36px", background: "white" }} />
              </div>
              <div style={{ display: "flex", gap: "7px", flexWrap: "wrap" }}>
                {allCategories.map(cat => <button key={cat} onClick={() => setSelectedCategory(cat)} style={s.pill(selectedCategory === cat)}>{cat}</button>)}
              </div>
              {isAdmin && <button onClick={openAdd} style={{ ...s.btn, background: "linear-gradient(135deg, #f59e0b, #d97706)", color: "#0f172a", padding: "9px 20px", whiteSpace: "nowrap" }}>+ Add Credential</button>}
            </div>

            <div style={{ marginBottom: "14px", color: "#64748b", fontSize: "13px" }}>{visibleCredentials.length} credential{visibleCredentials.length !== 1 ? "s" : ""}{searchQuery ? ` matching "${searchQuery}"` : ""}</div>

            {visibleCredentials.length === 0 ? (
              <div style={{ textAlign: "center", padding: "4rem 2rem", background: "white", borderRadius: "16px", border: "1px solid #e5e9f0" }}>
                <div style={{ fontSize: "52px", marginBottom: "12px" }}>🔒</div>
                <p style={{ color: "#475569", fontSize: "15px", margin: 0 }}>No credentials found</p>
                <p style={{ color: "#94a3b8", fontSize: "13px" }}>Try adjusting your search or filters</p>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: "16px" }}>
                {visibleCredentials.map(cred => {
                  const revealed = revealedPasswords[cred.id];
                  return (
                    <div key={cred.id} style={{ background: "white", borderRadius: "14px", border: "1px solid #e5e9f0", padding: "20px", transition: "box-shadow 0.15s" }} onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 20px rgba(0,0,0,0.08)"} onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "14px" }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <span style={{ fontSize: "18px" }}><CategoryIcon category={cred.category} /></span>
                            <span style={{ fontWeight: "700", fontSize: "16px", color: "#0f172a" }}>{cred.portal}</span>
                          </div>
                          {cred.url && <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "2px", marginLeft: "26px" }}>{cred.url}</div>}
                        </div>
                        <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                          <span style={{ padding: "3px 9px", borderRadius: "20px", fontSize: "11px", fontWeight: "600", background: "#f8fafc", color: "#64748b", border: "1px solid #e5e9f0" }}>{cred.category}</span>
                          {isAdmin && (
                            <>
                              <button onClick={() => openEdit(cred)} style={{ background: "#f8fafc", border: "1px solid #e5e9f0", borderRadius: "7px", width: "30px", height: "30px", cursor: "pointer", fontSize: "13px", display: "flex", alignItems: "center", justifyContent: "center" }}>✏️</button>
                              <button onClick={() => setDeleteConfirm(cred.id)} style={{ background: "#fff5f5", border: "1px solid #fecaca", borderRadius: "7px", width: "30px", height: "30px", cursor: "pointer", fontSize: "13px", display: "flex", alignItems: "center", justifyContent: "center" }}>🗑️</button>
                            </>
                          )}
                        </div>
                      </div>
                      <div style={{ marginBottom: "10px" }}>
                        <label style={s.label}>Username / Email</label>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <code style={{ ...s.mono, flex: 1, fontSize: "13px", color: "#1e293b", background: "#f8fafc", padding: "7px 10px", borderRadius: "7px", border: "1px solid #e5e9f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>{cred.username}</code>
                          <button onClick={() => copy(cred.username, `u-${cred.id}`)} style={{ background: copiedId === `u-${cred.id}` ? "#dcfce7" : "#f8fafc", border: `1px solid ${copiedId === `u-${cred.id}` ? "#86efac" : "#e5e9f0"}`, borderRadius: "7px", width: "32px", height: "32px", cursor: "pointer", fontSize: "14px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{copiedId === `u-${cred.id}` ? "✓" : "📋"}</button>
                        </div>
                      </div>
                      <div style={{ marginBottom: "14px" }}>
                        <label style={s.label}>Password</label>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <code style={{ ...s.mono, flex: 1, fontSize: "13px", color: revealed ? "#1e293b" : "#94a3b8", background: "#f8fafc", padding: "7px 10px", borderRadius: "7px", border: "1px solid #e5e9f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block", letterSpacing: revealed ? "normal" : "3px" }}>{revealed ? cred.password : "••••••••••••"}</code>
                          <button onClick={() => toggleReveal(cred.id)} style={{ background: revealed ? "#fef9ee" : "#f8fafc", border: `1px solid ${revealed ? "#fde68a" : "#e5e9f0"}`, borderRadius: "7px", width: "32px", height: "32px", cursor: "pointer", fontSize: "14px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{revealed ? "🙈" : "👁️"}</button>
                          <button onClick={() => copy(cred.password, `p-${cred.id}`)} style={{ background: copiedId === `p-${cred.id}` ? "#dcfce7" : "#f8fafc", border: `1px solid ${copiedId === `p-${cred.id}` ? "#86efac" : "#e5e9f0"}`, borderRadius: "7px", width: "32px", height: "32px", cursor: "pointer", fontSize: "14px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{copiedId === `p-${cred.id}` ? "✓" : "📋"}</button>
                        </div>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
                          {cred.teams === "all" ? (
                            <span style={{ padding: "3px 9px", borderRadius: "20px", fontSize: "11px", background: "#dcfce7", color: "#166534", fontWeight: "600", border: "1px solid #bbf7d0" }}>🌐 All teams</span>
                          ) : (
                            (cred.teams || []).map(t => {
                              const b = teamBadge[t] || teamBadge.engineering;
                              return <span key={t} style={{ padding: "3px 9px", borderRadius: "20px", fontSize: "11px", background: b.bg, color: b.text, fontWeight: "500", border: `1px solid ${b.border}` }}>{t}</span>;
                            })
                          )}
                        </div>
                        <div style={{ fontSize: "11px", color: "#cbd5e1" }}>{cred.addedAt}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {activeTab === "users" && isAdmin && (
          <div>
            <div style={{ marginBottom: "20px" }}>
              <h2 style={{ margin: 0, fontSize: "20px", fontWeight: "700", color: "#0f172a" }}>Team Members</h2>
              <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: "14px" }}>{users.length} accounts</p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "14px" }}>
              {users.map(u => {
                const b = teamBadge[u.team] || teamBadge.engineering;
                const myCredCount = credentials.filter(c => c.teams === "all" || (Array.isArray(c.teams) && c.teams.includes(u.team)) || u.team === "admin").length;
                return (
                  <div key={u.id} style={{ background: "white", borderRadius: "14px", border: "1px solid #e5e9f0", padding: "20px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "14px" }}>
                      <div style={{ width: "46px", height: "46px", background: b.bg, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: b.text, fontSize: "14px", fontWeight: "700", border: `2px solid ${b.border}` }}>{u.avatar}</div>
                      <div>
                        <div style={{ fontWeight: "700", fontSize: "15px", color: "#0f172a" }}>{u.name}</div>
                        <span style={{ padding: "2px 9px", borderRadius: "20px", fontSize: "11px", background: b.bg, color: b.text, fontWeight: "600", border: `1px solid ${b.border}` }}>{u.team}</span>
                      </div>
                    </div>
                    <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "12px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", marginBottom: "6px" }}>
                        <span style={{ color: "#64748b" }}>Username</span>
                        <code style={{ ...s.mono, color: "#0f172a", fontSize: "13px" }}>{u.username}</code>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", marginBottom: "6px" }}>
                        <span style={{ color: "#64748b" }}>Credentials access</span>
                        <span style={{ fontWeight: "700", color: "#0f172a" }}>{myCredCount}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                        <span style={{ color: "#64748b" }}>Role</span>
                        <span style={{ fontWeight: "600", color: u.team === "admin" ? "#d97706" : "#475569" }}>{u.team === "admin" ? "🔧 Admin" : "👤 Member"}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {showModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(10,15,30,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: "1rem" }}>
          <div style={{ background: "white", borderRadius: "18px", padding: "28px", width: "100%", maxWidth: "500px", maxHeight: "90vh", overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "22px" }}>
              <h2 style={{ margin: 0, fontSize: "18px", fontWeight: "700", color: "#0f172a" }}>{editingCred ? "✏️ Edit Credential" : "➕ New Credential"}</h2>
              <button onClick={() => setShowModal(false)} style={{ background: "#f8fafc", border: "1px solid #e5e9f0", borderRadius: "8px", width: "32px", height: "32px", cursor: "pointer", color: "#64748b", fontSize: "16px" }}>✕</button>
            </div>
            {[{ label: "Portal Name *", key: "portal", placeholder: "GitHub, AWS Console, Figma..." }, { label: "URL (optional)", key: "url", placeholder: "github.com" }, { label: "Username / Email *", key: "username", placeholder: "user@example.com" }].map(field => (
              <div key={field.key} style={{ marginBottom: "14px" }}>
                <label style={s.label}>{field.label}</label>
                <input type="text" value={form[field.key]} onChange={e => setForm(f => ({ ...f, [field.key]: e.target.value }))} placeholder={field.placeholder} style={s.input} />
              </div>
            ))}
            <div style={{ marginBottom: "14px" }}>
              <label style={s.label}>Password *</label>
              <div style={{ position: "relative" }}>
                <input type={formReveal ? "text" : "password"} value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="Enter password" style={{ ...s.input, paddingRight: "42px", fontFamily: formReveal ? "monospace" : "inherit" }} />
                <button onClick={() => setFormReveal(p => !p)} style={{ position: "absolute", right: "10px", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#94a3b8", fontSize: "16px" }}>{formReveal ? "🙈" : "👁️"}</button>
              </div>
            </div>
            <div style={{ marginBottom: "14px" }}>
              <label style={s.label}>Category</label>
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} style={{ ...s.input, cursor: "pointer" }}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select>
            </div>
            <div style={{ marginBottom: "22px" }}>
              <label style={s.label}>Team Access</label>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button onClick={() => toggleTeamInForm("all")} style={s.pill(form.teams.includes("all"))}>🌐 All teams</button>
                {TEAMS.map(team => {
                  const b = teamBadge[team]; const active = form.teams.includes(team);
                  return <button key={team} onClick={() => toggleTeamInForm(team)} style={{ padding: "5px 14px", borderRadius: "20px", border: `1px solid ${active ? b.border : "#e5e9f0"}`, background: active ? b.bg : "white", color: active ? b.text : "#64748b", fontSize: "12px", fontWeight: active ? "600" : "400", cursor: "pointer" }}>{team}</button>;
                })}
              </div>
              {form.teams.length === 0 && <p style={{ color: "#f97316", fontSize: "12px", margin: "6px 0 0" }}>⚠️ Select at least one team</p>}
            </div>
            <div style={{ display: "flex", gap: "10px" }}>
              <button onClick={() => setShowModal(false)} style={{ ...s.btn, flex: 1, background: "#f8fafc", border: "1px solid #e5e9f0", color: "#475569" }}>Cancel</button>
              <button onClick={handleSave} disabled={!form.portal.trim() || !form.username.trim() || !form.password.trim()} style={{ ...s.btn, flex: 2, background: form.portal && form.username && form.password ? "linear-gradient(135deg, #f59e0b, #d97706)" : "#e5e9f0", color: form.portal && form.username && form.password ? "#0f172a" : "#94a3b8", fontWeight: "700" }}>
                {editingCred ? "Save Changes" : "Add Credential"}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(10,15,30,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div style={{ background: "white", borderRadius: "16px", padding: "28px", maxWidth: "380px", width: "90%", textAlign: "center" }}>
            <div style={{ fontSize: "40px", marginBottom: "12px" }}>⚠️</div>
            <h3 style={{ margin: "0 0 8px", fontSize: "17px", fontWeight: "700", color: "#0f172a" }}>Delete credential?</h3>
            <p style={{ color: "#64748b", fontSize: "14px", margin: "0 0 22px" }}>This will permanently remove <strong>"{credentials.find(c => c.id === deleteConfirm)?.portal}"</strong> from the vault.</p>
            <div style={{ display: "flex", gap: "10px" }}>
              <button onClick={() => setDeleteConfirm(null)} style={{ ...s.btn, flex: 1, background: "#f8fafc", border: "1px solid #e5e9f0", color: "#475569" }}>Cancel</button>
              <button onClick={() => handleDelete(deleteConfirm)} style={{ ...s.btn, flex: 1, background: "#ef4444", color: "white", fontWeight: "700" }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
