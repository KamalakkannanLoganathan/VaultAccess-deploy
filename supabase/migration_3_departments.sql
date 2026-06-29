-- ============================================================================
-- Eagle RCM — migration 3: editable departments
-- Run ONCE in Supabase: SQL Editor → New query → paste → Run. Idempotent.
-- ============================================================================

-- A table admins can manage from the UI. "admin" stays a fixed role and is
-- NOT stored here — these are the editable departments (formerly the teams).
create table if not exists public.departments (
  id         text primary key,                 -- stable slug stored on users/credentials
  label      text not null,                     -- display name (editable)
  color      text not null default '#60a5fa',   -- badge colour (editable)
  sort       integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.departments enable row level security;

drop policy if exists departments_select on public.departments;
create policy departments_select on public.departments
  for select using (auth.uid() is not null);

drop policy if exists departments_admin on public.departments;
create policy departments_admin on public.departments
  for all using (public.is_admin()) with check (public.is_admin());

insert into public.departments (id, label, color, sort) values
  ('engineering','Engineering','#60a5fa',1),
  ('marketing','Marketing','#f472b6',2),
  ('design','Design','#a78bfa',3),
  ('ops','Ops','#34d399',4)
on conflict (id) do nothing;

-- Allow profiles.team to hold any department id (not just the original four).
-- Row Level Security still controls access; only the rigid CHECK is removed.
alter table public.profiles drop constraint if exists profiles_team_check;

-- Done.
