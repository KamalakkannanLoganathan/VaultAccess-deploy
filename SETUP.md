# VaultAccess — Shared Backend Setup (Supabase)

You do steps 1–4 once. They take about 10 minutes and need no coding.
Then send me your **Project URL** + **anon public key** and I wire up the app.

---

## 1. Create the Supabase project
1. Go to **https://supabase.com** → sign in (free) → **New project**.
2. Name it `vaultaccess`, pick a strong database password (save it somewhere), choose the region closest to your team.
3. Click **Create new project** and wait ~2 minutes for it to finish provisioning.

## 2. Create the database tables
1. In the left sidebar open **SQL Editor** → **New query**.
2. Open the file `supabase/schema.sql` from this project, copy **all** of it, paste into the editor.
3. Click **Run**. You should see "Success. No rows returned."

## 3. Get your API keys
1. Left sidebar → **Settings** (gear) → **API**.
2. Copy two values:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **anon public** key (a long string under "Project API keys")
3. These are what you send back to me. (The anon key is safe to share — the database security rules protect the data.)

## 4. Create your first admin login
The app's "Add User" button will create everyone else, but the very first admin
has to be made by hand:

1. Left sidebar → **Authentication** → **Users** → **Add user** → **Create new user**.
2. Email: `alex@vault.local`  ·  Password: `Admin@123!`  ·  tick **Auto Confirm User** → **Create user**.
3. Click the new user row and copy its **User UID**.
4. Go back to **SQL Editor** → **New query**, paste the line below, replace
   `PASTE-UID-HERE` with that UID, and **Run**:

   ```sql
   insert into public.profiles (id, name, username, team, avatar)
   values ('PASTE-UID-HERE', 'Alex Chen', 'alex', 'admin', 'AC');
   ```

You can change the name/username/password later from inside the app.

---

## What to send me
Just paste these two back into the chat:

```
Project URL:  https://xxxx.supabase.co
anon key:     eyJ....(long string)
```

Once I have them I'll: add them to `.env.local`, swap the app's storage layer
from localStorage to Supabase, add the secure "Add User" function, and redeploy
to Vercel so the whole team shares one live vault.
