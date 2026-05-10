import { useState, useEffect } from "react";

const TEAMS = ["engineering", "marketing", "design", "ops"];
const CATEGORIES = ["Development", "Infrastructure", "Design", "Marketing", "Communication", "Finance", "HR", "Other"];
const ALL_TEAM_OPTIONS = ["admin", ...TEAMS];

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

const storage = {
  get: (key) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};

const getInitials = (name) => name.trim().split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
const CategoryIcon = ({ cat }) => ({ Development:"💻", Infrastructure:"🖥️", Design:"🎨", Marketing:"📣", Communication:"💬", Finance:"💰", HR:"👥", Other:"📁" }[cat] || "📁");

export default function VaultAccess() {
  const [screen, setScreen]                       = useState("login");
  const [currentUser, setCurrentUser]             = useState(null);
  const [users, setUsers]                         = useState(DEFAULT_USERS);
  const [credentials, setCredentials]             = useState(DEFAULT_CREDENTIALS);
  const [loginUsername, setLoginUsername]         = useState("");
  const [loginPassword, setLoginPassword]         = useState("");
  const [loginError, setLoginError]               = useState("");
  const [showLoginPass, setShowLoginPass]         = useState(false);
  const [searchQuery, setSearchQuery]             = useState("");
  const [selectedCategory, setSelectedCategory]   = useState("All");
  const [revealedPw, setRevealedPw]               = useState({});
  const [copiedId, setCopiedId]                   = useState(null);
  const [activeTab, setActiveTab]                 = useState("credentials");
  const [toast, setToast]                         = useState(null);

  // Credential modal state
  const [showCredModal, setShowCredModal]         = useState(false);
  const [editingCred, setEditingCred]             = useState(null);
  const [credForm, setCredForm]                   = useState({ portal:"", url:"", username:"", password:"", category:"Development", teams:[] });
  const [credReveal, setCredReveal]               = useState(false);
  const [delCred, setDelCred]                     = useState(null);

  // User modal state
  const [showUserModal, setShowUserModal]         = useState(false);
  const [editingUser, setEditingUser]             = useState(null);
  const [userForm, setUserForm]                   = useState({ name:"", username:"", password:"", team:"engineering" });
  const [userReveal, setUserReveal]               = useState(false);
  const [delUser, setDelUser]                     = useState(null);

  useEffect(() => {
    const c = storage.get("vault_creds"); if (c) setCredentials(c);
    const u = storage.get("vault_users"); if (u) setUsers(u);
  }, []);

  const showToast = (msg, type = "success") => { setToast({ msg, type }); setTimeout(() => setToast(null), 2500); };
  const saveCreds = (c) => { setCredentials(c); storage.set("vault_creds", c); };
  const saveUsers = (u) => { setUsers(u);       storage.set("vault_users", u); };

  const handleLogin = () => {
    const user = users.find(u => u.username === loginUsername.trim() && u.password === loginPassword);
    if (user) { setCurrentUser(user); setScreen("dashboard"); setLoginError(""); setLoginUsername(""); setLoginPassword(""); }
    else setLoginError("Invalid credentials. Please try again.");
  };

  const visible = credentials.filter(c => {
    const teamOk   = currentUser?.team === "admin" || c.teams === "all" || (Array.isArray(c.teams) && c.teams.includes(currentUser?.team));
    const s        = searchQuery.toLowerCase();
    const searchOk = !s || c.portal.toLowerCase().includes(s) || c.username.toLowerCase().includes(s) || c.category.toLowerCase().includes(s) || (c.url||"").toLowerCase().includes(s);
    const catOk    = selectedCategory === "All" || c.category === selectedCategory;
    return teamOk && searchOk && catOk;
  });

  const categories = ["All", ...new Set(credentials.map(c => c.category).filter(Boolean))];
  const copy = async (text, id) => { try { await navigator.clipboard.writeText(text); setCopiedId(id); showToast("Copied!"); setTimeout(()=>setCopiedId(null),2000); } catch { showToast("Copy failed","error"); } };

  // ── Credential handlers ──────────────────────────────────────────────────
  const openAddCred  = () => { setEditingCred(null); setCredForm({portal:"",url:"",username:"",password:"",category:"Development",teams:[]}); setCredReveal(false); setShowCredModal(true); };
  const openEditCred = (c) => { setEditingCred(c); setCredForm({portal:c.portal,url:c.url||"",username:c.username,password:c.password,category:c.category,teams:c.teams==="all"?["all"]:[...(c.teams||[])]}); setCredReveal(false); setShowCredModal(true); };
  const saveCred = () => {
    if (!credForm.portal.trim()||!credForm.username.trim()||!credForm.password.trim()) return;
    const teams = credForm.teams.includes("all") ? "all" : credForm.teams;
    if (editingCred) { saveCreds(credentials.map(c => c.id===editingCred.id ? {...c,...credForm,teams} : c)); showToast(`"${credForm.portal}" updated`); }
    else { saveCreds([...credentials,{id:Date.now().toString(),...credForm,teams,addedBy:currentUser.name,addedAt:new Date().toISOString().split("T")[0]}]); showToast(`"${credForm.portal}" added`); }
    setShowCredModal(false);
  };
  const deleteCred = (id) => { const c=credentials.find(x=>x.id===id); saveCreds(credentials.filter(x=>x.id!==id)); setDelCred(null); showToast(`"${c?.portal}" removed`,"error"); };
  const toggleCredTeam = (team) => setCredForm(f => {
    if (team==="all") return {...f, teams: f.teams.includes("all")?[]:["all"]};
    const t = f.teams.filter(x=>x!=="all");
    return {...f, teams: t.includes(team)?t.filter(x=>x!==team):[...t,team]};
  });

  // ── User handlers ────────────────────────────────────────────────────────
  const openAddUser  = () => { setEditingUser(null); setUserForm({name:"",username:"",password:"",team:"engineering"}); setUserReveal(false); setShowUserModal(true); };
  const openEditUser = (u) => { setEditingUser(u); setUserForm({name:u.name,username:u.username,password:u.password,team:u.team}); setUserReveal(false); setShowUserModal(true); };
  const saveUser = () => {
    if (!userForm.name.trim()||!userForm.username.trim()||!userForm.password.trim()) return;
    if (users.find(u => u.username===userForm.username.trim() && u.id!==editingUser?.id)) { showToast("Username already taken","error"); return; }
    const avatar = getInitials(userForm.name);
    if (editingUser) {
      const updated = users.map(u => u.id===editingUser.id ? {...u,...userForm,username:userForm.username.trim(),avatar} : u);
      saveUsers(updated);
      if (currentUser.id===editingUser.id) setCurrentUser(p => ({...p,...userForm,username:userForm.username.trim(),avatar}));
      showToast(`${userForm.name} updated`);
    } else {
      saveUsers([...users,{id:Date.now().toString(),...userForm,username:userForm.username.trim(),avatar}]);
      showToast(`${userForm.name} added`);
    }
    setShowUserModal(false);
  };
  const deleteUser = (id) => { const u=users.find(x=>x.id===id); saveUsers(users.filter(x=>x.id!==id)); setDelUser(null); showToast(`${u?.name} removed`,"error"); };

  // ── Shared styles ────────────────────────────────────────────────────────
  const S = {
    root:    { fontFamily:"'Inter',-apple-system,BlinkMacSystemFont,sans-serif", minHeight:"100vh", background:"#f0f2f5" },
    header:  { background:"#0a0f1e", padding:"0 28px", display:"flex", alignItems:"center", justifyContent:"space-between", height:"58px", position:"sticky", top:0, zIndex:10, borderBottom:"1px solid #1a2332" },
    main:    { padding:"28px", maxWidth:"1200px", margin:"0 auto" },
    lbl:     { display:"block", fontSize:"11px", fontWeight:"600", color:"#94a3b8", textTransform:"uppercase", letterSpacing:"0.6px", marginBottom:"5px" },
    inp:     { width:"100%", padding:"9px 12px", border:"1px solid #e5e9f0", borderRadius:"8px", fontSize:"14px", outline:"none", boxSizing:"border-box", color:"#0f172a" },
    btn:     { padding:"9px 18px", borderRadius:"8px", border:"none", fontSize:"13px", fontWeight:"600", cursor:"pointer" },
    pill:    (a) => ({ padding:"5px 14px", borderRadius:"20px", border:`1px solid ${a?"#f59e0b":"#e5e9f0"}`, background:a?"#fef9ee":"white", color:a?"#92400e":"#64748b", fontSize:"12px", fontWeight:a?"600":"400", cursor:"pointer", whiteSpace:"nowrap" }),
    mono:    { fontFamily:"'JetBrains Mono','Fira Code','Courier New',monospace" },
    overlay: { position:"fixed", inset:0, background:"rgba(10,15,30,0.6)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:50, padding:"1rem" },
    modal:   { background:"white", borderRadius:"18px", padding:"28px", width:"100%", maxWidth:"500px", maxHeight:"90vh", overflowY:"auto" },
  };

  // ─── LOGIN ───────────────────────────────────────────────────────────────
  if (screen === "login") return (
    <div style={{minHeight:"100vh",background:"#060d1a",display:"flex",alignItems:"center",justifyContent:"center",padding:"2rem",fontFamily:"'Inter',sans-serif"}}>
      <div style={{width:"100%",maxWidth:"420px"}}>
        <div style={{textAlign:"center",marginBottom:"2.5rem"}}>
          <div style={{width:"60px",height:"60px",background:"linear-gradient(135deg,#f59e0b,#d97706)",borderRadius:"16px",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px",fontSize:"28px"}}>🔐</div>
          <h1 style={{color:"white",fontSize:"28px",fontWeight:"800",margin:0,letterSpacing:"-0.5px"}}>VaultAccess</h1>
          <p style={{color:"#475569",margin:"8px 0 0",fontSize:"14px"}}>Secure team credential management</p>
        </div>
        <div style={{background:"#0f1a2e",borderRadius:"16px",padding:"28px",border:"1px solid #1e2d45"}}>
          <div style={{marginBottom:"18px"}}>
            <label style={{display:"block",color:"#64748b",fontSize:"11px",fontWeight:"600",textTransform:"uppercase",letterSpacing:"0.6px",marginBottom:"7px"}}>Username</label>
            <input type="text" value={loginUsername} onChange={e=>{setLoginUsername(e.target.value);setLoginError("");}} onKeyDown={e=>e.key==="Enter"&&handleLogin()} placeholder="Enter your username" style={{width:"100%",padding:"11px 14px",background:"#060d1a",border:`1px solid ${loginError?"#7f1d1d":"#1e2d45"}`,borderRadius:"9px",color:"white",fontSize:"14px",outline:"none",boxSizing:"border-box"}}/>
          </div>
          <div style={{marginBottom:"20px"}}>
            <label style={{display:"block",color:"#64748b",fontSize:"11px",fontWeight:"600",textTransform:"uppercase",letterSpacing:"0.6px",marginBottom:"7px"}}>Password</label>
            <div style={{position:"relative"}}>
              <input type={showLoginPass?"text":"password"} value={loginPassword} onChange={e=>{setLoginPassword(e.target.value);setLoginError("");}} onKeyDown={e=>e.key==="Enter"&&handleLogin()} placeholder="Enter your password" style={{width:"100%",padding:"11px 42px 11px 14px",background:"#060d1a",border:`1px solid ${loginError?"#7f1d1d":"#1e2d45"}`,borderRadius:"9px",color:"white",fontSize:"14px",outline:"none",boxSizing:"border-box"}}/>
              <button onClick={()=>setShowLoginPass(p=>!p)} style={{position:"absolute",right:"12px",top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",color:"#475569",fontSize:"16px",padding:0}}>{showLoginPass?"🙈":"👁️"}</button>
            </div>
          </div>
          {loginError && <div style={{background:"rgba(127,29,29,0.4)",border:"1px solid #7f1d1d",borderRadius:"8px",padding:"10px 14px",color:"#fca5a5",fontSize:"13px",marginBottom:"18px"}}>⚠️ {loginError}</div>}
          <button onClick={handleLogin} style={{width:"100%",padding:"12px",background:"linear-gradient(135deg,#f59e0b,#d97706)",border:"none",borderRadius:"9px",color:"#0f172a",fontSize:"14px",fontWeight:"700",cursor:"pointer"}}>Sign In →</button>
        </div>
      </div>
    </div>
  );

  // ─── DASHBOARD ───────────────────────────────────────────────────────────
  const isAdmin = currentUser.team === "admin";
  const ub = teamBadge[currentUser.team] || teamBadge.engineering;

  return (
    <div style={S.root}>
      {/* Header */}
      <div style={S.header}>
        <div style={{display:"flex",alignItems:"center",gap:"10px"}}>
          <div style={{width:"32px",height:"32px",background:"linear-gradient(135deg,#f59e0b,#d97706)",borderRadius:"8px",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"16px"}}>🔐</div>
          <span style={{color:"white",fontWeight:"700",fontSize:"16px",letterSpacing:"-0.3px"}}>VaultAccess</span>
        </div>
        {isAdmin && (
          <div style={{display:"flex",gap:"4px",background:"#111827",borderRadius:"8px",padding:"4px"}}>
            {["credentials","users"].map(tab=>(
              <button key={tab} onClick={()=>setActiveTab(tab)} style={{padding:"6px 16px",borderRadius:"6px",border:"none",cursor:"pointer",background:activeTab===tab?"#1e2d45":"transparent",color:activeTab===tab?"white":"#475569",fontSize:"13px",fontWeight:"500"}}>
                {tab==="credentials"?"🔑 Credentials":"👥 Users"}
              </button>
            ))}
          </div>
        )}
        <div style={{display:"flex",alignItems:"center",gap:"12px"}}>
          <div style={{textAlign:"right"}}>
            <div style={{color:"white",fontSize:"13px",fontWeight:"600"}}>{currentUser.name}</div>
            <div style={{fontSize:"11px",color:"#475569",textTransform:"capitalize"}}>{currentUser.team}</div>
          </div>
          <div style={{width:"36px",height:"36px",background:ub.bg,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",color:ub.text,fontSize:"11px",fontWeight:"700",border:`2px solid ${ub.border}`}}>{currentUser.avatar}</div>
          <button onClick={()=>{setScreen("login");setCurrentUser(null);setRevealedPw({});}} style={{background:"transparent",border:"1px solid #1e2d45",borderRadius:"7px",color:"#64748b",padding:"6px 12px",fontSize:"12px",cursor:"pointer"}}>Sign out</button>
        </div>
      </div>

      {/* Toast */}
      {toast && <div style={{position:"fixed",top:"70px",right:"24px",zIndex:99,background:toast.type==="error"?"#fee2e2":"#dcfce7",color:toast.type==="error"?"#991b1b":"#166534",border:`1px solid ${toast.type==="error"?"#fca5a5":"#86efac"}`,borderRadius:"8px",padding:"10px 16px",fontSize:"13px",fontWeight:"600",boxShadow:"0 4px 12px rgba(0,0,0,0.15)"}}>
        {toast.type==="error"?"⚠️":"✅"} {toast.msg}
      </div>}

      <div style={S.main}>

        {/* ── CREDENTIALS TAB ─────────────────────────────────────────────── */}
        {(activeTab==="credentials"||!isAdmin) && (<>
          {/* Stats */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:"14px",marginBottom:"24px"}}>
            {[
              {label:"Accessible",value:visible.length,icon:"🔑",color:"#fef9ee",border:"#fde68a"},
              {label:"Categories",value:new Set(visible.map(c=>c.category)).size,icon:"📂",color:"#eff6ff",border:"#bfdbfe"},
              {label:"Team",value:currentUser.team,icon:"👥",color:ub.bg,border:ub.border},
              ...(isAdmin?[{label:"Total",value:credentials.length,icon:"📋",color:"#f0fdf4",border:"#bbf7d0"}]:[]),
            ].map((st,i)=>(
              <div key={i} style={{background:st.color,borderRadius:"12px",padding:"16px 18px",border:`1px solid ${st.border}`}}>
                <div style={{fontSize:"22px",marginBottom:"6px"}}>{st.icon}</div>
                <div style={{fontSize:"22px",fontWeight:"800",color:"#0f172a",lineHeight:1}}>{st.value}</div>
                <div style={{fontSize:"12px",color:"#64748b",marginTop:"4px"}}>{st.label}</div>
              </div>
            ))}
          </div>

          {/* Search + filters */}
          <div style={{display:"flex",gap:"12px",marginBottom:"20px",alignItems:"center",flexWrap:"wrap"}}>
            <div style={{flex:1,minWidth:"220px",position:"relative"}}>
              <span style={{position:"absolute",left:"12px",top:"50%",transform:"translateY(-50%)",color:"#94a3b8"}}>🔍</span>
              <input type="text" value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} placeholder="Search portals, usernames, URLs…" style={{...S.inp,paddingLeft:"36px",background:"white"}}/>
            </div>
            <div style={{display:"flex",gap:"7px",flexWrap:"wrap"}}>
              {categories.map(cat=><button key={cat} onClick={()=>setSelectedCategory(cat)} style={S.pill(selectedCategory===cat)}>{cat}</button>)}
            </div>
            {isAdmin && <button onClick={openAddCred} style={{...S.btn,background:"linear-gradient(135deg,#f59e0b,#d97706)",color:"#0f172a",padding:"9px 20px",whiteSpace:"nowrap"}}>+ Add Credential</button>}
          </div>

          <div style={{marginBottom:"14px",color:"#64748b",fontSize:"13px"}}>{visible.length} credential{visible.length!==1?"s":""}{searchQuery?` matching "${searchQuery}"`:""}</div>

          {visible.length===0 ? (
            <div style={{textAlign:"center",padding:"4rem 2rem",background:"white",borderRadius:"16px",border:"1px solid #e5e9f0"}}>
              <div style={{fontSize:"52px",marginBottom:"12px"}}>🔒</div>
              <p style={{color:"#475569",fontSize:"15px",margin:0}}>No credentials found</p>
            </div>
          ) : (
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(340px,1fr))",gap:"16px"}}>
              {visible.map(cred=>{
                const rev = revealedPw[cred.id];
                return (
                  <div key={cred.id} style={{background:"white",borderRadius:"14px",border:"1px solid #e5e9f0",padding:"20px",transition:"box-shadow 0.15s"}} onMouseEnter={e=>e.currentTarget.style.boxShadow="0 4px 20px rgba(0,0,0,0.08)"} onMouseLeave={e=>e.currentTarget.style.boxShadow="none"}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:"14px"}}>
                      <div style={{flex:1}}>
                        <div style={{display:"flex",alignItems:"center",gap:"8px"}}>
                          <span style={{fontSize:"18px"}}><CategoryIcon cat={cred.category}/></span>
                          <span style={{fontWeight:"700",fontSize:"16px",color:"#0f172a"}}>{cred.portal}</span>
                        </div>
                        {cred.url&&<div style={{fontSize:"12px",color:"#94a3b8",marginTop:"2px",marginLeft:"26px"}}>{cred.url}</div>}
                      </div>
                      <div style={{display:"flex",gap:"4px",alignItems:"center"}}>
                        <span style={{padding:"3px 9px",borderRadius:"20px",fontSize:"11px",fontWeight:"600",background:"#f8fafc",color:"#64748b",border:"1px solid #e5e9f0"}}>{cred.category}</span>
                        {isAdmin&&<>
                          <button onClick={()=>openEditCred(cred)} style={{background:"#f8fafc",border:"1px solid #e5e9f0",borderRadius:"7px",width:"30px",height:"30px",cursor:"pointer",fontSize:"13px",display:"flex",alignItems:"center",justifyContent:"center"}}>✏️</button>
                          <button onClick={()=>setDelCred(cred.id)} style={{background:"#fff5f5",border:"1px solid #fecaca",borderRadius:"7px",width:"30px",height:"30px",cursor:"pointer",fontSize:"13px",display:"flex",alignItems:"center",justifyContent:"center"}}>🗑️</button>
                        </>}
                      </div>
                    </div>
                    {/* Username */}
                    <div style={{marginBottom:"10px"}}>
                      <label style={S.lbl}>Username / Email</label>
                      <div style={{display:"flex",alignItems:"center",gap:"8px"}}>
                        <code style={{...S.mono,flex:1,fontSize:"13px",color:"#1e293b",background:"#f8fafc",padding:"7px 10px",borderRadius:"7px",border:"1px solid #e5e9f0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",display:"block"}}>{cred.username}</code>
                        <button onClick={()=>copy(cred.username,`u-${cred.id}`)} style={{background:copiedId===`u-${cred.id}`?"#dcfce7":"#f8fafc",border:`1px solid ${copiedId===`u-${cred.id}`?"#86efac":"#e5e9f0"}`,borderRadius:"7px",width:"32px",height:"32px",cursor:"pointer",fontSize:"14px",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{copiedId===`u-${cred.id}`?"✓":"📋"}</button>
                      </div>
                    </div>
                    {/* Password */}
                    <div style={{marginBottom:"14px"}}>
                      <label style={S.lbl}>Password</label>
                      <div style={{display:"flex",alignItems:"center",gap:"8px"}}>
                        <code style={{...S.mono,flex:1,fontSize:"13px",color:rev?"#1e293b":"#94a3b8",background:"#f8fafc",padding:"7px 10px",borderRadius:"7px",border:"1px solid #e5e9f0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",display:"block",letterSpacing:rev?"normal":"3px"}}>{rev?cred.password:"••••••••••••"}</code>
                        <button onClick={()=>setRevealedPw(p=>({...p,[cred.id]:!p[cred.id]}))} style={{background:rev?"#fef9ee":"#f8fafc",border:`1px solid ${rev?"#fde68a":"#e5e9f0"}`,borderRadius:"7px",width:"32px",height:"32px",cursor:"pointer",fontSize:"14px",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{rev?"🙈":"👁️"}</button>
                        <button onClick={()=>copy(cred.password,`p-${cred.id}`)} style={{background:copiedId===`p-${cred.id}`?"#dcfce7":"#f8fafc",border:`1px solid ${copiedId===`p-${cred.id}`?"#86efac":"#e5e9f0"}`,borderRadius:"7px",width:"32px",height:"32px",cursor:"pointer",fontSize:"14px",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{copiedId===`p-${cred.id}`?"✓":"📋"}</button>
                      </div>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <div style={{display:"flex",gap:"5px",flexWrap:"wrap"}}>
                        {cred.teams==="all"
                          ? <span style={{padding:"3px 9px",borderRadius:"20px",fontSize:"11px",background:"#dcfce7",color:"#166534",fontWeight:"600",border:"1px solid #bbf7d0"}}>🌐 All teams</span>
                          : (cred.teams||[]).map(t=>{ const b=teamBadge[t]||teamBadge.engineering; return <span key={t} style={{padding:"3px 9px",borderRadius:"20px",fontSize:"11px",background:b.bg,color:b.text,fontWeight:"500",border:`1px solid ${b.border}`}}>{t}</span>; })}
                      </div>
                      <div style={{fontSize:"11px",color:"#cbd5e1"}}>{cred.addedAt}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>)}

        {/* ── USERS TAB ───────────────────────────────────────────────────── */}
        {activeTab==="users"&&isAdmin&&(
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"20px"}}>
              <div>
                <h2 style={{margin:0,fontSize:"20px",fontWeight:"700",color:"#0f172a"}}>Team Members</h2>
                <p style={{margin:"4px 0 0",color:"#64748b",fontSize:"14px"}}>{users.length} accounts</p>
              </div>
              <button onClick={openAddUser} style={{...S.btn,background:"linear-gradient(135deg,#f59e0b,#d97706)",color:"#0f172a",padding:"9px 20px"}}>+ Add User</button>
            </div>

            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:"14px"}}>
              {users.map(u=>{
                const b = teamBadge[u.team]||teamBadge.engineering;
                const credCount = credentials.filter(c=>u.team==="admin"||c.teams==="all"||(Array.isArray(c.teams)&&c.teams.includes(u.team))).length;
                const isSelf = u.id===currentUser.id;
                return (
                  <div key={u.id} style={{background:"white",borderRadius:"14px",border:`1px solid ${isSelf?"#fde68a":"#e5e9f0"}`,padding:"20px",position:"relative"}}>
                    {isSelf&&<span style={{position:"absolute",top:"14px",right:"14px",fontSize:"10px",fontWeight:"700",background:"#fef3c7",color:"#92400e",padding:"2px 8px",borderRadius:"20px",border:"1px solid #fde68a"}}>You</span>}
                    <div style={{display:"flex",alignItems:"center",gap:"12px",marginBottom:"14px"}}>
                      <div style={{width:"48px",height:"48px",background:b.bg,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",color:b.text,fontSize:"14px",fontWeight:"700",border:`2px solid ${b.border}`,flexShrink:0}}>{u.avatar}</div>
                      <div>
                        <div style={{fontWeight:"700",fontSize:"15px",color:"#0f172a"}}>{u.name}</div>
                        <span style={{padding:"2px 9px",borderRadius:"20px",fontSize:"11px",background:b.bg,color:b.text,fontWeight:"600",border:`1px solid ${b.border}`}}>{u.team}</span>
                      </div>
                    </div>
                    <div style={{borderTop:"1px solid #f1f5f9",paddingTop:"12px",marginBottom:"14px"}}>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:"13px",marginBottom:"6px"}}>
                        <span style={{color:"#64748b"}}>Username</span>
                        <code style={{...S.mono,color:"#0f172a",fontSize:"13px"}}>{u.username}</code>
                      </div>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:"13px",marginBottom:"6px"}}>
                        <span style={{color:"#64748b"}}>Credentials access</span>
                        <span style={{fontWeight:"700",color:"#0f172a"}}>{credCount}</span>
                      </div>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:"13px"}}>
                        <span style={{color:"#64748b"}}>Role</span>
                        <span style={{fontWeight:"600",color:u.team==="admin"?"#d97706":"#475569"}}>{u.team==="admin"?"🔧 Admin":"👤 Member"}</span>
                      </div>
                    </div>
                    <div style={{display:"flex",gap:"8px"}}>
                      <button onClick={()=>openEditUser(u)} style={{...S.btn,flex:1,background:"#f8fafc",border:"1px solid #e5e9f0",color:"#475569",padding:"7px"}}>✏️ Edit</button>
                      {!isSelf&&<button onClick={()=>setDelUser(u.id)} style={{...S.btn,flex:1,background:"#fff5f5",border:"1px solid #fecaca",color:"#dc2626",padding:"7px"}}>🗑️ Remove</button>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── CREDENTIAL MODAL ──────────────────────────────────────────────── */}
      {showCredModal&&(
        <div style={S.overlay}>
          <div style={S.modal}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"22px"}}>
              <h2 style={{margin:0,fontSize:"18px",fontWeight:"700",color:"#0f172a"}}>{editingCred?"✏️ Edit Credential":"➕ New Credential"}</h2>
              <button onClick={()=>setShowCredModal(false)} style={{background:"#f8fafc",border:"1px solid #e5e9f0",borderRadius:"8px",width:"32px",height:"32px",cursor:"pointer",color:"#64748b",fontSize:"16px"}}>✕</button>
            </div>
            {[{label:"Portal Name *",key:"portal",ph:"GitHub, AWS Console…"},{label:"URL (optional)",key:"url",ph:"github.com"},{label:"Username / Email *",key:"username",ph:"user@example.com"}].map(f=>(
              <div key={f.key} style={{marginBottom:"14px"}}>
                <label style={S.lbl}>{f.label}</label>
                <input type="text" value={credForm[f.key]} onChange={e=>setCredForm(x=>({...x,[f.key]:e.target.value}))} placeholder={f.ph} style={S.inp}/>
              </div>
            ))}
            <div style={{marginBottom:"14px"}}>
              <label style={S.lbl}>Password *</label>
              <div style={{position:"relative"}}>
                <input type={credReveal?"text":"password"} value={credForm.password} onChange={e=>setCredForm(f=>({...f,password:e.target.value}))} placeholder="Enter password" style={{...S.inp,paddingRight:"42px"}}/>
                <button onClick={()=>setCredReveal(p=>!p)} style={{position:"absolute",right:"10px",top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",color:"#94a3b8",fontSize:"16px"}}>{credReveal?"🙈":"👁️"}</button>
              </div>
            </div>
            <div style={{marginBottom:"14px"}}>
              <label style={S.lbl}>Category</label>
              <select value={credForm.category} onChange={e=>setCredForm(f=>({...f,category:e.target.value}))} style={{...S.inp,cursor:"pointer"}}>{CATEGORIES.map(c=><option key={c}>{c}</option>)}</select>
            </div>
            <div style={{marginBottom:"22px"}}>
              <label style={S.lbl}>Team Access</label>
              <div style={{display:"flex",gap:"8px",flexWrap:"wrap"}}>
                <button onClick={()=>toggleCredTeam("all")} style={S.pill(credForm.teams.includes("all"))}>🌐 All teams</button>
                {TEAMS.map(team=>{ const b=teamBadge[team]; const a=credForm.teams.includes(team); return <button key={team} onClick={()=>toggleCredTeam(team)} style={{padding:"5px 14px",borderRadius:"20px",border:`1px solid ${a?b.border:"#e5e9f0"}`,background:a?b.bg:"white",color:a?b.text:"#64748b",fontSize:"12px",fontWeight:a?"600":"400",cursor:"pointer"}}>{team}</button>; })}
              </div>
              {credForm.teams.length===0&&<p style={{color:"#f97316",fontSize:"12px",margin:"6px 0 0"}}>⚠️ Select at least one team</p>}
            </div>
            <div style={{display:"flex",gap:"10px"}}>
              <button onClick={()=>setShowCredModal(false)} style={{...S.btn,flex:1,background:"#f8fafc",border:"1px solid #e5e9f0",color:"#475569"}}>Cancel</button>
              <button onClick={saveCred} disabled={!credForm.portal.trim()||!credForm.username.trim()||!credForm.password.trim()} style={{...S.btn,flex:2,background:credForm.portal&&credForm.username&&credForm.password?"linear-gradient(135deg,#f59e0b,#d97706)":"#e5e9f0",color:credForm.portal&&credForm.username&&credForm.password?"#0f172a":"#94a3b8",fontWeight:"700"}}>
                {editingCred?"Save Changes":"Add Credential"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── USER MODAL ────────────────────────────────────────────────────── */}
      {showUserModal&&(
        <div style={S.overlay}>
          <div style={{...S.modal,maxWidth:"440px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"22px"}}>
              <h2 style={{margin:0,fontSize:"18px",fontWeight:"700",color:"#0f172a"}}>{editingUser?"✏️ Edit User":"➕ Add User"}</h2>
              <button onClick={()=>setShowUserModal(false)} style={{background:"#f8fafc",border:"1px solid #e5e9f0",borderRadius:"8px",width:"32px",height:"32px",cursor:"pointer",color:"#64748b",fontSize:"16px"}}>✕</button>
            </div>

            {/* Live avatar preview */}
            <div style={{display:"flex",justifyContent:"center",marginBottom:"20px"}}>
              <div style={{width:"56px",height:"56px",background:(teamBadge[userForm.team]||teamBadge.engineering).bg,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",color:(teamBadge[userForm.team]||teamBadge.engineering).text,fontSize:"16px",fontWeight:"700",border:`2px solid ${(teamBadge[userForm.team]||teamBadge.engineering).border}`}}>
                {userForm.name?getInitials(userForm.name):"?"}
              </div>
            </div>

            <div style={{marginBottom:"14px"}}>
              <label style={S.lbl}>Full Name *</label>
              <input type="text" value={userForm.name} onChange={e=>setUserForm(f=>({...f,name:e.target.value}))} placeholder="e.g. Jane Smith" style={S.inp}/>
            </div>
            <div style={{marginBottom:"14px"}}>
              <label style={S.lbl}>Username *</label>
              <input type="text" value={userForm.username} onChange={e=>setUserForm(f=>({...f,username:e.target.value}))} placeholder="e.g. jane" style={{...S.inp,...S.mono}}/>
            </div>
            <div style={{marginBottom:"14px"}}>
              <label style={S.lbl}>Password *</label>
              <div style={{position:"relative"}}>
                <input type={userReveal?"text":"password"} value={userForm.password} onChange={e=>setUserForm(f=>({...f,password:e.target.value}))} placeholder="Set a password" style={{...S.inp,paddingRight:"42px"}}/>
                <button onClick={()=>setUserReveal(p=>!p)} style={{position:"absolute",right:"10px",top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",color:"#94a3b8",fontSize:"16px"}}>{userReveal?"🙈":"👁️"}</button>
              </div>
            </div>
            <div style={{marginBottom:"22px"}}>
              <label style={S.lbl}>Team / Role</label>
              <div style={{display:"flex",gap:"8px",flexWrap:"wrap"}}>
                {ALL_TEAM_OPTIONS.map(team=>{ const b=teamBadge[team]||teamBadge.engineering; const a=userForm.team===team; return (
                  <button key={team} onClick={()=>setUserForm(f=>({...f,team}))} style={{padding:"6px 14px",borderRadius:"20px",border:`2px solid ${a?b.border:"#e5e9f0"}`,background:a?b.bg:"white",color:a?b.text:"#64748b",fontSize:"12px",fontWeight:a?"700":"400",cursor:"pointer"}}>
                    {team==="admin"?"🔧 ":""}{team}
                  </button>
                );})}
              </div>
            </div>
            <div style={{display:"flex",gap:"10px"}}>
              <button onClick={()=>setShowUserModal(false)} style={{...S.btn,flex:1,background:"#f8fafc",border:"1px solid #e5e9f0",color:"#475569"}}>Cancel</button>
              <button onClick={saveUser} disabled={!userForm.name.trim()||!userForm.username.trim()||!userForm.password.trim()} style={{...S.btn,flex:2,background:userForm.name&&userForm.username&&userForm.password?"linear-gradient(135deg,#f59e0b,#d97706)":"#e5e9f0",color:userForm.name&&userForm.username&&userForm.password?"#0f172a":"#94a3b8",fontWeight:"700"}}>
                {editingUser?"Save Changes":"Add User"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── DELETE CRED CONFIRM ───────────────────────────────────────────── */}
      {delCred&&(
        <div style={S.overlay}>
          <div style={{background:"white",borderRadius:"16px",padding:"28px",maxWidth:"380px",width:"90%",textAlign:"center"}}>
            <div style={{fontSize:"40px",marginBottom:"12px"}}>⚠️</div>
            <h3 style={{margin:"0 0 8px",fontSize:"17px",fontWeight:"700",color:"#0f172a"}}>Delete credential?</h3>
            <p style={{color:"#64748b",fontSize:"14px",margin:"0 0 22px"}}>This will permanently remove <strong>"{credentials.find(c=>c.id===delCred)?.portal}"</strong>.</p>
            <div style={{display:"flex",gap:"10px"}}>
              <button onClick={()=>setDelCred(null)} style={{...S.btn,flex:1,background:"#f8fafc",border:"1px solid #e5e9f0",color:"#475569"}}>Cancel</button>
              <button onClick={()=>deleteCred(delCred)} style={{...S.btn,flex:1,background:"#ef4444",color:"white",fontWeight:"700"}}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* ── DELETE USER CONFIRM ───────────────────────────────────────────── */}
      {delUser&&(
        <div style={S.overlay}>
          <div style={{background:"white",borderRadius:"16px",padding:"28px",maxWidth:"380px",width:"90%",textAlign:"center"}}>
            <div style={{fontSize:"40px",marginBottom:"12px"}}>⚠️</div>
            <h3 style={{margin:"0 0 8px",fontSize:"17px",fontWeight:"700",color:"#0f172a"}}>Remove user?</h3>
            <p style={{color:"#64748b",fontSize:"14px",margin:"0 0 22px"}}><strong>{users.find(u=>u.id===delUser)?.name}</strong> will lose access to the vault immediately.</p>
            <div style={{display:"flex",gap:"10px"}}>
              <button onClick={()=>setDelUser(null)} style={{...S.btn,flex:1,background:"#f8fafc",border:"1px solid #e5e9f0",color:"#475569"}}>Cancel</button>
              <button onClick={()=>deleteUser(delUser)} style={{...S.btn,flex:1,background:"#ef4444",color:"white",fontWeight:"700"}}>Remove</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

