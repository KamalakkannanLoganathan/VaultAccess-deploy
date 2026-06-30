-- ============================================================================
-- Eagle RCM — migration 6: credentials may belong to MULTIPLE clients
-- Run ONCE in Supabase: SQL Editor → New query → paste → Run. Idempotent.
-- ============================================================================

-- New array columns ----------------------------------------------------------
alter table public.credentials add column if not exists client_ids   text[] not null default '{}';
alter table public.credentials add column if not exists client_names text[] not null default '{}';

-- Backfill from the old single client_id/client_name (only where empty) ------
update public.credentials
   set client_ids   = array[client_id::text],
       client_names = array[coalesce(client_name, '')]
 where client_id is not null
   and (client_ids is null or array_length(client_ids, 1) is null);

-- (OPTIONAL demo flavour — NOT run by default, to protect your live data.)
-- Uncomment if you specifically want a few credentials to have 2+ clients /
-- "all". On a real vault this would overwrite the client of any credential
-- whose portal matches, so it is left commented out.
--
-- update public.credentials c set client_ids = array[a.id::text, b.id::text], client_names = array[a.name, b.name]
--   from public.clients a, public.clients b where c.portal = 'GitHub' and a.name = 'TechCorp Solutions' and b.name = 'Internal';
-- update public.credentials c set client_ids = array[a.id::text, b.id::text], client_names = array[a.name, b.name]
--   from public.clients a, public.clients b where c.portal = 'Figma' and a.name = 'Bright Agency' and b.name = 'Internal';
-- update public.credentials set client_ids = array['all'], client_names = array['All Clients'] where portal = 'Notion';

-- Drop the old single-client FK + columns ------------------------------------
alter table public.credentials drop constraint if exists credentials_client_fk;
alter table public.credentials drop column if exists client_id;
alter table public.credentials drop column if exists client_name;

-- Done.
