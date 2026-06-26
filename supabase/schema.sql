-- ============================================================================
-- VaultAccess — Supabase schema
-- Run this ONCE in your Supabase project: SQL Editor → New query → paste → Run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- One row per team member. id == the Supabase Auth user id.
create table if not exists public.profiles (
  id                    uuid primary key references auth.users(id) on delete cascade,
  name                  text not null,
  username              text not null unique,
  team                  text not null check (team in ('admin','engineering','marketing','design','ops')),
  avatar                text,
  created_at            timestamptz not null default now(),
  last_login_at         timestamptz,
  two_factor_enabled    boolean not null default false,
  two_factor_secret     text default '',
  failed_login_attempts integer not null default 0,
  locked_until          timestamptz
);

create table if not exists public.credentials (
  id                   uuid primary key default gen_random_uuid(),
  portal               text not null,
  url                  text default '',
  username             text not null,
  password             text not null,
  category             text not null default 'Development',
  client               text default '',
  auth_method          text not null default 'None' check (auth_method in ('None','Text','Auth','Email')),
  auth_location        text default '',
  all_teams            boolean not null default false,   -- true == every team
  teams                text[] not null default '{}',     -- used when all_teams = false
  password_expiry_days integer not null default 90,
  needs_rotation       boolean not null default false,
  rotation_note        text default '',
  added_by             text,
  added_at             timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table if not exists public.audit (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid,
  user_name       text,
  action          text not null,
  credential_id   uuid,
  credential_name text,
  target_user_id  uuid,
  detail          text,
  ts              timestamptz not null default now()
);

create table if not exists public.access_requests (
  id              uuid primary key default gen_random_uuid(),
  requester_id    uuid not null,
  requester_name  text,
  requester_team  text,
  credential_id   uuid,
  credential_name text,
  message         text default '',
  status          text not null default 'pending' check (status in ('pending','approved','denied')),
  requested_at    timestamptz not null default now(),
  resolved_at     timestamptz,
  resolved_by     text
);

create table if not exists public.favourites (
  user_id       uuid not null,
  credential_id uuid not null,
  primary key (user_id, credential_id)
);

create index if not exists idx_audit_ts          on public.audit (ts desc);
create index if not exists idx_requests_status    on public.access_requests (status);

-- ---------------------------------------------------------------------------
-- Helper functions (used by the security policies below)
-- ---------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.team = 'admin');
$$;

create or replace function public.my_team()
returns text language sql stable security definer set search_path = public as $$
  select p.team from public.profiles p where p.id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security — the public anon key can read NOTHING without a login.
-- ---------------------------------------------------------------------------

alter table public.profiles        enable row level security;
alter table public.credentials     enable row level security;
alter table public.audit           enable row level security;
alter table public.access_requests enable row level security;
alter table public.favourites      enable row level security;

-- profiles: any logged-in member can see the roster; admins manage everyone;
-- a user may update their own row (2FA, last login, lockout counters).
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (auth.uid() is not null);

drop policy if exists profiles_admin_all on public.profiles;
create policy profiles_admin_all on public.profiles
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- credentials: visible to admins, to everyone when all_teams, or to the
-- owning team(s). Only admins can create/edit/delete.
drop policy if exists credentials_select on public.credentials;
create policy credentials_select on public.credentials
  for select using (
    public.is_admin() or all_teams or (public.my_team() = any (teams))
  );

drop policy if exists credentials_admin_write on public.credentials;
create policy credentials_admin_write on public.credentials
  for all using (public.is_admin()) with check (public.is_admin());

-- audit: anyone logged in may append; only admins may read.
drop policy if exists audit_insert on public.audit;
create policy audit_insert on public.audit
  for insert with check (auth.uid() is not null);

drop policy if exists audit_admin_select on public.audit;
create policy audit_admin_select on public.audit
  for select using (public.is_admin());

-- access_requests: a member files their own and sees their own; admins see/resolve all.
drop policy if exists requests_insert on public.access_requests;
create policy requests_insert on public.access_requests
  for insert with check (requester_id = auth.uid());

drop policy if exists requests_select on public.access_requests;
create policy requests_select on public.access_requests
  for select using (public.is_admin() or requester_id = auth.uid());

drop policy if exists requests_admin_update on public.access_requests;
create policy requests_admin_update on public.access_requests
  for update using (public.is_admin()) with check (public.is_admin());

-- favourites: strictly per-user.
drop policy if exists favourites_all on public.favourites;
create policy favourites_all on public.favourites
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================================
-- Done. Next: create your first admin (see SETUP.md step 4).
-- ============================================================================
