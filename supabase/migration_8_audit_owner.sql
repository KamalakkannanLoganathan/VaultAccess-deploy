-- ============================================================================
-- Eagle RCM — migration 8: "Audit Owner" per credential
-- Run ONCE in Supabase: SQL Editor → New query → paste → Run. Idempotent.
-- Adds a nullable FK from credentials to the owning team member (profiles).
-- Owner tagging only — audit-date tracking is a separate, later change.
-- ============================================================================

alter table public.credentials
  add column if not exists audit_owner uuid
  references public.profiles(id) on delete set null;

-- Optional: speeds up "filter by owner" on large vaults.
create index if not exists credentials_audit_owner_idx on public.credentials(audit_owner);

-- Done.
