-- ============================================================================
-- Eagle RCM — migration 9: two-week audit cadence
-- Run ONCE in Supabase: SQL Editor → New query → paste → Run. Idempotent.
-- Tracks when each login was last audited. A login is "due" every 14 days.
-- Owner tagging came in migration 8; this adds the date tracking.
-- ============================================================================

alter table public.credentials add column if not exists last_audited_at timestamptz;
alter table public.credentials add column if not exists last_audited_by uuid
  references public.profiles(id) on delete set null;

-- Members can't UPDATE credentials directly (RLS). This SECURITY DEFINER
-- function lets the ASSIGNED audit owner (or any admin) stamp an audit,
-- touching only the audit-date columns.
create or replace function public.cred_mark_audited(cred_id uuid, p_by text, p_by_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare c public.credentials;
begin
  select * into c from public.credentials where id = cred_id;
  if not found then raise exception 'Credential not found'; end if;
  if not (public.is_admin() or c.audit_owner = auth.uid()) then
    raise exception 'Only an admin or the assigned audit owner can mark this audited';
  end if;
  update public.credentials
     set last_audited_at = now(), last_audited_by = p_by_id
   where id = cred_id;
end; $$;
grant execute on function public.cred_mark_audited(uuid, text, uuid) to authenticated;

-- Done.
