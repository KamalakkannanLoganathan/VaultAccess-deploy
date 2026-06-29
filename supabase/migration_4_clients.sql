-- ============================================================================
-- Eagle RCM — migration 4: clients as managed entities + remove category
-- Run ONCE in Supabase: SQL Editor → New query → paste → Run. Idempotent.
-- ============================================================================

-- 1) Clients table -----------------------------------------------------------
create table if not exists public.clients (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  code            text default '',
  color           text not null default '#6366f1',
  privilege_level text not null default 'standard' check (privilege_level in ('standard','restricted','confidential')),
  allowed_teams   text[] not null default '{}',
  description     text default '',
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  created_by      text
);

alter table public.clients enable row level security;
drop policy if exists clients_select on public.clients;
create policy clients_select on public.clients for select using (auth.uid() is not null);
drop policy if exists clients_admin on public.clients;
create policy clients_admin on public.clients for all using (public.is_admin()) with check (public.is_admin());

-- Seed the five default clients (only if the table is empty) -----------------
insert into public.clients (name, code, color, privilege_level, allowed_teams, description, created_by)
select * from (values
  ('Bright Agency',      'BRA', '#6366f1', 'standard',     array['design','marketing'],                  'Creative agency partner',  'Alex Chen'),
  ('TechCorp Solutions', 'TCS', '#10b981', 'restricted',   array['engineering'],                         'Engineering vendor',       'Alex Chen'),
  ('Executive Suite',    'EXC', '#ef4444', 'confidential', array[]::text[],                              'Leadership-only systems',  'Alex Chen'),
  ('Internal',           'INT', '#f59e0b', 'standard',     array['engineering','marketing','design','ops'], 'Internal company tools', 'Alex Chen'),
  ('Meridian Group',     'MRG', '#8b5cf6', 'restricted',   array['ops','marketing'],                     'Strategic partner',        'Alex Chen')
) as v(name,code,color,privilege_level,allowed_teams,description,created_by)
where not exists (select 1 from public.clients);

-- 2) Point credentials at clients -------------------------------------------
alter table public.credentials add column if not exists client_id   uuid;
alter table public.credentials add column if not exists client_name text default '';

-- Backfill existing demo credentials by portal so each gets a client
-- (ensures >=2 restricted + 1 confidential).
update public.credentials c set client_id = cl.id, client_name = cl.name
  from public.clients cl
  where c.client_id is null and (
    (c.portal in ('GitHub','AWS Console','Jira') and cl.name = 'TechCorp Solutions') or
    (c.portal in ('Figma','HubSpot','Adobe Creative Cloud') and cl.name = 'Bright Agency') or
    (c.portal in ('Google Workspace','Notion') and cl.name = 'Internal') or
    (c.portal = 'Salesforce' and cl.name = 'Meridian Group') or
    (c.portal = 'Datadog'    and cl.name = 'Executive Suite')
  );

-- Any still-unmatched credential falls back to Internal.
update public.credentials c set client_id = cl.id, client_name = cl.name
  from public.clients cl where c.client_id is null and cl.name = 'Internal';

alter table public.credentials drop constraint if exists credentials_client_fk;
alter table public.credentials add constraint credentials_client_fk
  foreign key (client_id) references public.clients(id) on delete set null;

-- 3) Remove the old category and free-text client columns -------------------
alter table public.credentials drop column if exists category;
alter table public.credentials drop column if exists client;

-- Done.
