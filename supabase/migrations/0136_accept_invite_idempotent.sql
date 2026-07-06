-- FamilyOS :: 0136 accept_invite made idempotent
-- ----------------------------------------------------------------------------
-- Found in a real browser smoke test of the invite journey: accepting an invite
-- twice — a double-click, React strict-mode double-effect, or simply revisiting
-- the emailed /join link after already joining — raised "Invite is invalid or
-- expired" even though the member WAS in the family, so the UI showed a scary
-- error on a successful join. Re-accepting your own already-accepted invite now
-- returns the family id (success). All other guards are unchanged: unknown/
-- expired tokens still fail, and an invite accepted by a DIFFERENT user still
-- fails with the original message.

create or replace function public.accept_invite(p_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_invite public.invites;
  v_name   text;
begin
  select * into v_invite from public.invites
  where token = p_token
  for update;

  if not found then
    raise exception 'Invite is invalid or expired';
  end if;

  -- Idempotent success: this user already accepted this invite.
  if v_invite.status = 'accepted' and v_invite.accepted_by = auth.uid() then
    return v_invite.family_id;
  end if;

  if v_invite.status <> 'pending' or v_invite.expires_at <= now() then
    raise exception 'Invite is invalid or expired';
  end if;

  if lower(v_invite.email) <> lower(coalesce(auth.jwt()->>'email','')) then
    raise exception 'This invite was issued to a different email';
  end if;

  select coalesce(full_name, display_name, email) into v_name
  from public.profiles where id = auth.uid();

  insert into public.family_members (family_id, user_id, role, display_name)
  values (v_invite.family_id, auth.uid(), v_invite.role, coalesce(v_name,'Member'))
  on conflict (family_id, user_id) do update set is_active = true;

  update public.invites
    set status = 'accepted', accepted_by = auth.uid(), updated_at = now()
  where id = v_invite.id;

  update public.user_preferences
    set active_family_id = v_invite.family_id
  where user_id = auth.uid() and active_family_id is null;

  return v_invite.family_id;
end; $$;
