-- ============================================================================
-- VaultAccess — migration 2: verification fields + time restrictions
-- Run ONCE in Supabase: SQL Editor → New query → paste → Run.
-- Safe to re-run (uses IF NOT EXISTS / idempotent backfill).
-- ============================================================================

alter table public.credentials add column if not exists verify_email     text  default '';
alter table public.credentials add column if not exists verify_text      text  default '';
alter table public.credentials add column if not exists verify_auth      text  default '';
alter table public.credentials add column if not exists time_restriction jsonb default null;

-- Backfill the new verification fields from the older single auth_method/
-- auth_location pair so existing credentials keep their verification info.
update public.credentials
   set verify_email = auth_location
 where coalesce(verify_email,'') = '' and auth_method = 'Email' and coalesce(auth_location,'') <> '';

update public.credentials
   set verify_text = auth_location
 where coalesce(verify_text,'') = '' and auth_method = 'Text' and coalesce(auth_location,'') <> '';

update public.credentials
   set verify_auth = auth_location
 where coalesce(verify_auth,'') = '' and auth_method = 'Auth' and coalesce(auth_location,'') <> '';

-- Done.
