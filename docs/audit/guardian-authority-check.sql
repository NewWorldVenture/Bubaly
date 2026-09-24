-- Guardian's screening decisions are the parents'. (AUTHZ-005, migration 0330)
--
-- Guardian screens calls and texts for the family. Who rings through, who goes
-- to voicemail and who is blocked is decided by three tables:
--
--   guardian_contacts        a caller's trust_level (blocked … immediate_family)
--   guardian_member_profiles how each member's calls are handled per trust level,
--                            and whether screening is on for them at all
--   guardian_suggestions     proposals a parent approves; guardian_review_suggestion
--                            applies whatever proposed_* the row holds at that moment
--
-- Every product path that writes them is parent-only (upsertContactAction,
-- updateContactTrustAction, deleteContactAction, upsertMemberProfileAction,
-- updateContextAction, assignGuardianPhoneAction) or the service role (the SMS
-- pipeline, the learning cron). The routing rules were already manager-only.
-- The three tables above were `FOR ALL is_family_member`, so a child could undo
-- a parent's screening for themselves directly.
--
--   a child raises a blocked caller to immediate_family  -> REFUSED
--   a child adds a contact, or deletes one               -> REFUSED
--   a child switches their own screening off             -> REFUSED
--   a child rewrites a pending suggestion                -> REFUSED
--   a child deletes a parent's routing rule by deleting
--     the contact it is attached to (ON DELETE CASCADE)  -> REFUSED
--   a parent sets trust, edits a profile                 -> allowed  (control)
--   a parent approves the suggestion as it was proposed  -> allowed  (control)
--   a child can still see the family's contacts          -> allowed  (control)
--
-- Rolled back: nothing here should outlive the assertion.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $probe$
declare
  par      uuid := '00000000-0000-4000-8000-00000000c501';
  kid      uuid := '00000000-0000-4000-8000-00000000c502';
  fam      uuid := '00000000-0000-4000-8000-00000000c511';
  m_par    uuid;
  m_kid    uuid;
  stranger uuid := '00000000-0000-4000-8000-00000000c521';
  prof     uuid := '00000000-0000-4000-8000-00000000c531';
  sugg     uuid := '00000000-0000-4000-8000-00000000c541';
  rule     uuid := '00000000-0000-4000-8000-00000000c551';
  res      jsonb;
  lvl      text;
  n        int;
  failures int := 0;
begin
  insert into auth.users (id, email) values (par, 'guardian-parent@example.test'), (kid, 'guardian-kid@example.test')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Guardian', par) on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, par, 'Parent', 'parent', true), (fam, kid, 'Kid', 'child', true)
  on conflict (family_id, user_id) do update set role = excluded.role, is_active = true;
  select id into m_par from public.family_members where family_id = fam and user_id = par;
  select id into m_kid from public.family_members where family_id = fam and user_id = kid;

  insert into public.guardian_contacts (id, family_id, name, phone, trust_level, trust_override, created_by)
    values (stranger, fam, 'Stranger', '+15550100199', 'blocked', true, par);
  insert into public.guardian_member_profiles (id, family_id, member_id, is_active)
    values (prof, fam, m_kid, true);
  insert into public.guardian_routing_rules (id, family_id, name, condition_contact_id, action_routing_mode, created_by)
    values (rule, fam, 'Always block Stranger', stranger, 'blocked', par);
  insert into public.guardian_suggestions (id, family_id, suggestion_type, title, reasoning, proposed_contact_id, proposed_trust_level, status)
    values (sugg, fam, 'block_contact', 'Keep blocking this caller', 'Three calls after 11pm', stranger, 'blocked', 'pending');

  -- ── the child ───────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', kid::text)::text, true);
  set local role authenticated;
  if not public.is_family_member(fam) or public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: not acting as a non-manager member, so no refusal below means anything';
  end if;
  select count(*) into n from public.guardian_contacts where id = stranger;
  if n <> 1 then
    raise warning 'CONTROL FAILED: the child cannot see the family''s contacts';
    failures := failures + 1;
  end if;

  begin
    update public.guardian_suggestions set proposed_trust_level = 'immediate_family', title = 'Mark as family' where id = sugg;
    get diagnostics n = row_count;
    if n > 0 then raise warning 'BREACH: a child rewrote a pending suggestion before a parent approved it (rows: %)', n; failures := failures + 1; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    update public.guardian_contacts set trust_level = 'immediate_family' where id = stranger;
    get diagnostics n = row_count;
    if n > 0 then raise warning 'BREACH: a child raised a blocked caller to immediate_family (rows: %)', n; failures := failures + 1; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.guardian_contacts (family_id, name, phone, trust_level) values (fam, 'New friend', '+15550100200', 'trusted_friend');
    raise warning 'BREACH: a child added a trusted contact';
    failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.guardian_contacts where id = stranger;
    get diagnostics n = row_count;
    if n > 0 then raise warning 'BREACH: a child deleted a blocked caller''s record (rows: %)', n; failures := failures + 1; end if;
  exception when insufficient_privilege then null;
  end;
  reset role;
  if not exists (select 1 from public.guardian_routing_rules where id = rule) then
    raise warning 'BREACH: a child deleted a parent''s manager-only routing rule by deleting the contact it names (cascade)';
    failures := failures + 1;
  end if;
  -- A breach above may have removed rows the parent's controls need; put them
  -- back so a control failure below means the fix, not the fixture.
  insert into public.guardian_contacts (id, family_id, name, phone, trust_level, trust_override, created_by)
    values (stranger, fam, 'Stranger', '+15550100199', 'blocked', true, par)
  on conflict (id) do update set trust_level = 'blocked';
  insert into public.guardian_suggestions (id, family_id, suggestion_type, title, reasoning, proposed_contact_id, proposed_trust_level, status)
    values (sugg, fam, 'block_contact', 'Keep blocking this caller', 'Three calls after 11pm', stranger, 'blocked', 'pending')
  on conflict (id) do update set proposed_trust_level = 'blocked', title = 'Keep blocking this caller', status = 'pending';
  perform set_config('request.jwt.claims', json_build_object('sub', kid::text)::text, true);
  set local role authenticated;
  begin
    insert into public.guardian_communications (family_id, comm_type, direction, from_number, status)
      values (fam, 'call_inbound', 'inbound', '+15550100199', 'handled');
    raise warning 'BREACH: a child fabricated a call record, which the learning run reads';
    failures := failures + 1;
  exception when insufficient_privilege then null;
           when others then
    raise warning 'CONTROL FAILED: the fabricated-call fixture is wrong (%), so this case proves nothing', sqlerrm;
    failures := failures + 1;
  end;
  begin
    update public.guardian_member_profiles set is_active = false where id = prof;
    get diagnostics n = row_count;
    if n > 0 then raise warning 'BREACH: a child switched off their own call screening (rows: %)', n; failures := failures + 1; end if;
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- ── the parent ──────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', par::text)::text, true);
  set local role authenticated;
  res := public.guardian_review_suggestion(sugg, 'approved', null);
  if coalesce((res ->> 'ok')::boolean, false) is not true then
    raise warning 'CONTROL FAILED: the parent could not approve the suggestion: %', res;
    failures := failures + 1;
  end if;
  begin
    update public.guardian_member_profiles set current_context = 'meeting' where id = prof;
    get diagnostics n = row_count;
    if n <> 1 then raise warning 'CONTROL FAILED: a parent could not edit a member''s screening profile (rows: %)', n; failures := failures + 1; end if;
  exception when insufficient_privilege then
    raise warning 'CONTROL FAILED: a parent was refused editing a screening profile';
    failures := failures + 1;
  end;
  reset role;

  select trust_level::text into lvl from public.guardian_contacts where id = stranger;
  if lvl is distinct from 'blocked' then
    raise warning 'BREACH: after the parent approved "keep blocking", the caller is %', coalesce(lvl, 'gone');
    failures := failures + 1;
  end if;

  if failures > 0 then
    raise exception 'Guardian''s screening decisions are not the parents'': % finding(s)', failures;
  end if;
  raise notice 'OK: a child cannot change trust, contacts, their own screening or a pending suggestion; every parent path still works.';
end
$probe$;

rollback;
