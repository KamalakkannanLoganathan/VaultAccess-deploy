import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2];
}
const admin = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });

async function findUserByEmail(email) {
  for (let page = 1; page <= 20; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    const hit = data.users.find((u) => u.email === email);
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

const alexAuth = await findUserByEmail("alex@vault.local");
console.log("intended alex@vault.local auth id:", alexAuth?.id);

const { data: profs } = await admin.from("profiles").select("id,name,username,team").eq("username", "alex");
console.log("existing 'alex' profile rows:", JSON.stringify(profs));

const orphan = (profs || []).find((p) => p.id !== alexAuth.id);
if (!orphan) {
  console.log("No orphan. Ensuring correct profile…");
} else {
  console.log("Removing orphan profile id:", orphan.id);
  await admin.from("profiles").delete().eq("id", orphan.id);
  // also list all auth users to see if the orphan id is a stray auth user we should remove
  const allEmails = [];
  for (let page = 1; page <= 20; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    data.users.forEach((u) => allEmails.push({ id: u.id, email: u.email }));
    if (data.users.length < 200) break;
  }
  const stray = allEmails.find((u) => u.id === orphan.id);
  if (stray && stray.email !== "alex@vault.local") {
    console.log("Deleting stray auth user:", stray.email, stray.id);
    await admin.auth.admin.deleteUser(stray.id);
  }
}

const { error } = await admin.from("profiles").upsert(
  { id: alexAuth.id, name: "Alex Chen", username: "alex", team: "admin", avatar: "AC" },
  { onConflict: "id" });
console.log(error ? "ERROR: " + error.message : "alex profile fixed → admin");

const { data: finalProfs } = await admin.from("profiles").select("name,username,team").order("team");
console.log("Final profiles:", JSON.stringify(finalProfs));
