-- ============================================================================
-- Eagle RCM — migration 5: self-registration via invite links
-- Run ONCE in Supabase: SQL Editor → New query → paste → Run. Idempotent.
-- ============================================================================

-- Gate: new accounts start inactive until an admin approves them.
alter table public.profiles add column if not exists active boolean not null default true;

-- Invite tokens (admin-generated) -------------------------------------------
create table if not exists public.invite_tokens (
  id           uuid primary key default gen_random_uuid(),
  token        text not null unique,
  label        text default '',
  created_by   text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz,
  allowed_team text,                 -- null = admin picks team on approval
  max_uses     integer not null default 1,
  used_count   integer not null default 0,
  active       boolean not null default true
);
alter table public.invite_tokens enable row level security;
drop policy if exists invite_admin on public.invite_tokens;
create policy invite_admin on public.invite_tokens for all using (public.is_admin()) with check (public.is_admin());
-- (Anonymous registration validates/consumes tokens server-side via the
--  service role in /api/register, so no anon SELECT policy is needed.)

-- Pending registrations ------------------------------------------------------
create table if not exists public.pending_registrations (
  id               uuid primary key default gen_random_uuid(),
  token_id         uuid,
  user_id          uuid,             -- the inactive auth user created at submit
  full_name        text not null,
  username         text not null,
  requested_team   text,
  submitted_at     timestamptz not null default now(),
  status           text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by      text,
  reviewed_at      timestamptz,
  rejection_reason text
);
alter table public.pending_registrations enable row level security;
drop policy if exists pending_admin on public.pending_registrations;
create policy pending_admin on public.pending_registrations for all using (public.is_admin()) with check (public.is_admin());

-- Done.
