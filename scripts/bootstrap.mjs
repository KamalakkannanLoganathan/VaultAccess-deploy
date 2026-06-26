// One-time bootstrap: creates the 5 team logins and seeds 10 credentials.
// Run with:  node scripts/bootstrap.mjs
// Safe to re-run — it skips users/credentials that already exist.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// --- load .env.local ---------------------------------------------------------
const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2];
}
const URL_ = env.VITE_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !SERVICE) { console.error("Missing URL or service role key in .env.local"); process.exit(1); }

const admin = createClient(URL_, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
const initials = (n) => n.split(" ").map((p) => p[0]).join("").toUpperCase().slice(0, 2);
const emailFor = (u) => `${u}@vault.local`;

const USERS = [
  { name: "Alex Chen",   username: "alex",   password: "Admin@123!", team: "admin" },
  { name: "Sam Rivera",  username: "sam",    password: "Eng@123!",   team: "engineering" },
  { name: "Morgan Lee",  username: "morgan", password: "Mkt@123!",   team: "marketing" },
  { name: "Jordan Park", username: "jordan", password: "Des@123!",   team: "design" },
  { name: "Casey Kim",   username: "casey",  password: "Ops@123!",   team: "ops" },
];

async function findUserByEmail(email) {
  // paginate admin.listUsers until found
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email === email);
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

async function ensureUsers() {
  for (const u of USERS) {
    const email = emailFor(u.username);
    let authUser = await findUserByEmail(email);
    if (!authUser) {
      const { data, error } = await admin.auth.admin.createUser({
        email, password: u.password, email_confirm: true,
        user_metadata: { name: u.name, username: u.username, team: u.team },
      });
      if (error) { console.error(`  ! create ${u.username}:`, error.message); continue; }
      authUser = data.user;
      console.log(`  + auth user ${u.username}`);
    } else {
      console.log(`  = auth user ${u.username} already exists`);
    }
    const { error: pErr } = await admin.from("profiles").upsert({
      id: authUser.id, name: u.name, username: u.username, team: u.team, avatar: initials(u.name),
    }, { onConflict: "id" });
    if (pErr) console.error(`  ! profile ${u.username}:`, pErr.message);
    else console.log(`  + profile ${u.username} (${u.team})`);
  }
}

const CREDS = [
  ["GitHub","github.com","org-dev-team","ghp_K9mX2pQrTs8vL4nW","Development","Acme Corp","Auth","Engineering Authy (shared)",false,["engineering"],90,false,""],
  ["AWS Console","console.aws.amazon.com","aws-devops@company.com","Aws#2024!Secure","Infrastructure","Acme Corp","Auth","Alex's Google Authenticator",false,["engineering"],90,false,""],
  ["Figma","figma.com","design@company.com","Fig@Creative24!","Design","Bright Agency","Email","design@company.com inbox",false,["design","marketing"],90,false,""],
  ["HubSpot","app.hubspot.com","marketing@company.com","Hub$pot2024!","Marketing","Bright Agency","Email","marketing@company.com inbox",false,["marketing"],90,false,""],
  ["Google Workspace","workspace.google.com","admin@company.com","GWs@Admin2024","Communication","Internal","Text","+1 555-0100 (Alex's phone)",true,[],90,false,""],
  ["Notion","notion.so","team@company.com","N0tion$Team!","Communication","Internal","None","",true,[],90,false,""],
  ["Jira","company.atlassian.net","jira-admin@company.com","Jira#Mgmt2025","Development","Acme Corp","Auth","Engineering Authy (shared)",false,["engineering"],90,true,"Scheduled rotation"],
  ["Salesforce","login.salesforce.com","sales@company.com","Sf@Sales2025!","Marketing","Globex Ltd","Text","+1 555-0142 (Sales line)",false,["marketing"],90,false,""],
  ["Adobe Creative Cloud","creativecloud.adobe.com","design@company.com","Adobe#CC2025!","Design","Bright Agency","Email","design@company.com inbox",false,["design"],90,false,""],
  ["Datadog","app.datadoghq.com","monitoring@company.com","D@tadog!Ops25","Infrastructure","Globex Ltd","Auth","Ops Authenticator",false,["ops","engineering"],90,false,""],
];

async function ensureCredentials() {
  const { count, error } = await admin.from("credentials").select("*", { count: "exact", head: true });
  if (error) { console.error("  ! count credentials:", error.message); return; }
  if (count > 0) { console.log(`  = credentials already seeded (${count} rows), skipping`); return; }
  const rows = CREDS.map((c) => ({
    portal: c[0], url: c[1], username: c[2], password: c[3], category: c[4], client: c[5],
    auth_method: c[6], auth_location: c[7], all_teams: c[8], teams: c[9],
    password_expiry_days: c[10], needs_rotation: c[11], rotation_note: c[12], added_by: "Alex Chen",
  }));
  const { error: iErr } = await admin.from("credentials").insert(rows);
  if (iErr) console.error("  ! insert credentials:", iErr.message);
  else console.log(`  + seeded ${rows.length} credentials`);
}

console.log("Bootstrapping VaultAccess Supabase data…");
console.log("Users:");
await ensureUsers();
console.log("Credentials:");
await ensureCredentials();
console.log("Done.");
