-- ============================================================================
-- Eagle RCM — migration 7: "In Use" + "Not Working" status flags
-- Run ONCE in Supabase: SQL Editor → New query → paste → Run. Idempotent.
-- Additive only — old needs_rotation/rotation_note columns stay (unused).
-- ============================================================================

-- "Currently In Use" --------------------------------------------------------
alter table public.credentials add column if not exists in_use            boolean not null default false;
alter table public.credentials add column if not exists in_use_by         text;
alter table public.credentials add column if not exists in_use_by_user_id text;
alter table public.credentials add column if not exists in_use_since       timestamptz;
alter table public.credentials add column if not exists in_use_note        text;

-- "Not Working" -------------------------------------------------------------
alter table public.credentials add column if not exists not_working               boolean not null default false;
alter table public.credentials add column if not exists not_working_reported_by    text;
alter table public.credentials add column if not exists not_working_reported_by_id text;
alter table public.credentials add column if not exists not_working_at             timestamptz;
alter table public.credentials add column if not exists not_working_note           text;
alter table public.credentials add column if not exists not_working_history        jsonb not null default '[]'::jsonb;

-- Members may set status WITHOUT being able to edit passwords/teams. These
-- SECURITY DEFINER functions touch ONLY the status columns and check access
-- (admin, or the caller's team can see the credential).

create or replace function public.cred_set_in_use(cred_id uuid, p_in_use boolean, p_by text, p_by_id text, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare c public.credentials;
begin
  select * into c from public.credentials where id = cred_id;
  if not found then raise exception 'Credential not found'; end if;
  if not (public.is_admin() or c.all_teams or public.my_team() = any (c.teams)) then
    raise exception 'No access to this credential';
  end if;
  if p_in_use then
    update public.credentials set in_use = true, in_use_by = p_by, in_use_by_user_id = p_by_id,
           in_use_since = now(), in_use_note = p_note where id = cred_id;
  else
    update public.credentials set in_use = false, in_use_by = null, in_use_by_user_id = null,
           in_use_since = null, in_use_note = null where id = cred_id;
  end if;
end; $$;
grant execute on function public.cred_set_in_use(uuid, boolean, text, text, text) to authenticated;

create or replace function public.cred_set_not_working(cred_id uuid, p_not_working boolean, p_by text, p_by_id text, p_note text, p_history jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare c public.credentials;
begin
  select * into c from public.credentials where id = cred_id;
  if not found then raise exception 'Credential not found'; end if;
  if p_not_working then
    if not (public.is_admin() or c.all_teams or public.my_team() = any (c.teams)) then
      raise exception 'No access to this credential';
    end if;
    update public.credentials set not_working = true, not_working_reported_by = p_by, not_working_reported_by_id = p_by_id,
           not_working_at = now(), not_working_note = p_note, not_working_history = coalesce(p_history, '[]'::jsonb) where id = cred_id;
  else
    if not public.is_admin() then raise exception 'Only an admin can resolve'; end if;
    update public.credentials set not_working = false, not_working_reported_by = null, not_working_reported_by_id = null,
           not_working_at = null, not_working_note = null, not_working_history = coalesce(p_history, not_working_history) where id = cred_id;
  end if;
end; $$;
grant execute on function public.cred_set_not_working(uuid, boolean, text, text, text, jsonb) to authenticated;

-- Done.
