-- ── A child cannot rewrite the family's safety records (0323) ──────────────
--
-- Three tables, one shape. `family_emergency_contacts` and
-- `family_emergency_plans` came out of 0022_family_os.sql's DO loop, and
-- `guardian_suggestions` out of 01370_ai_call_guardian.sql, all three with
--
--   FOR ALL TO authenticated USING (is_family_member(family_id))
--
-- `FOR ALL` covers INSERT, UPDATE and DELETE; `is_family_member` ignores role.
--
-- The application says otherwise twice over. lib/family/actions.ts holds
-- `MANAGER_ONLY`, naming both emergency tables, and refuses a non-manager on
-- create, update and delete; app/(app)/dashboard/family-emergency/page.tsx
-- renders the add form and the delete button only `if (manager)`. Neither is a
-- boundary against a JWT holder — children have real logins, and a request to
-- /rest/v1/family_emergency_contacts never passes through app/ at all.
--
-- `guardian_suggestions` is the harder one, and it is why this probe exists
-- separately from guardian-safety-config-is-managers-only-check.sql. 0318 made
-- `guardian_contacts` manager-only. It did not cover the table that FEEDS it.
-- `guardian_review_suggestion` (0198) is SECURITY DEFINER, checks
-- `can_manage_family`, and on approval copies the suggestion's OWN fields into
-- the contact:
--
--   update public.guardian_contacts
--      set trust_level = v_suggestion.proposed_trust_level, trust_override = true
--    where id = v_suggestion.proposed_contact_id …
--
-- So a child who cannot write `guardian_contacts` could write the row telling a
-- privileged function what to write there, and a parent clicking Approve in good
-- faith applied it. This probe reproduces that chain end to end and requires it
-- to be broken — and its negative control requires it to WORK again once the
-- guard is removed, because a confused-deputy assertion nobody has watched fire
-- is the easiest kind to get wrong.
--
-- Asserts, in both directions:
--
--   1. a child cannot add, alter or delete an emergency contact or plan, nor
--      insert, retarget, dismiss or delete a Guardian suggestion;
--   2. a manager still can — a guard that refuses everyone is not a boundary;
--   3. the deputy chain is broken: with the child's rewrite refused, a parent's
--      approval applies the ORIGINAL proposal ('blocked'), not the child's;
--   4. a child CAN still read all three. The family-emergency page is a crisis
--      surface and hides nothing from the person who may need it, and /guardian
--      renders pending suggestions from the same RLS-bound read. Recorded rather
--      than asserted as a defect; if it changes this line fails on purpose;
--   5. UPDATE pins `family_id` on BOTH sides;
--   6. `anon` holds no INSERT — the 0323 guards are `TO authenticated` and are
--      absent for an anonymous request, so the grant layer is all that is left
--      (0290's argument);
--   7. NEGATIVE CONTROL: drop the restrictive guards, leaving the original
--      permissive policies untouched, and require the child's escalation AND the
--      full deputy chain to succeed again.
--
-- RLS is evaluated BEFORE a unique index, so an insert that reaches a constraint
-- violation is one RLS LET THROUGH; those are reported as breaches, not
-- swallowed.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/safety-record-write-check.sql

\set FS '00000000-0000-4000-8000-00000000cb10'
\set FT '00000000-0000-4000-8000-00000000cb11'
\set UP '00000000-0000-4000-8000-00000000cb12'
\set UK '00000000-0000-4000-8000-00000000cb13'
\set UO '00000000-0000-4000-8000-00000000cb14'

begin;

insert into auth.users (id, email) values (:'UP','s-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UK','s-kid@example.com')    on conflict do nothing;
insert into auth.users (id, email) values (:'UO','s-other@example.com')  on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FS','Safety House',:'UP') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FT','Other House',:'UO')  on conflict do nothing;

insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-00000000cb15',:'FS',:'UK','Kid','child',true) on conflict do nothing;
update public.family_members set role = 'parent' where family_id = :'FS' and user_id = :'UP';
update public.family_members set role = 'parent' where family_id = :'FT' and user_id = :'UO';

-- `can_pickup` is the list a school may release this child to.
insert into public.family_emergency_contacts (id, family_id, name, phone, can_pickup, is_primary)
  values ('00000000-0000-4000-8000-00000000cb16', :'FS', 'Grandma', '+15550111', true, true);
-- Where the household meets when the house is on fire.
insert into public.family_emergency_plans (id, family_id, title, safe_location, instructions)
  values ('00000000-0000-4000-8000-00000000cb17', :'FS', 'Fire', 'The oak tree', 'Leave by the back door, meet at the oak tree.');

-- A caller the Guardian has flagged, and the AI's pending proposal to block it.
insert into public.guardian_contacts (id, family_id, phone, name, trust_level)
  values ('00000000-0000-4000-8000-00000000cb18', :'FS', '+15550999', 'Scam Caller', 'suspected_spam');
insert into public.guardian_suggestions (id, family_id, suggestion_type, title, reasoning,
                                         proposed_contact_id, proposed_trust_level, status)
  values ('00000000-0000-4000-8000-00000000cb19', :'FS', 'update_trust', 'Block this caller',
          'repeated scam pattern', '00000000-0000-4000-8000-00000000cb18', 'blocked', 'pending');

grant select, insert, update, delete on public.family_emergency_contacts to authenticated;
grant select, insert, update, delete on public.family_emergency_plans    to authenticated;
grant select, insert, update, delete on public.guardian_suggestions      to authenticated;

do $$
declare
  n int;
  res jsonb;
  lvl text;
  failures text[] := '{}';
  fam       constant uuid := '00000000-0000-4000-8000-00000000cb10';
  other_fam constant uuid := '00000000-0000-4000-8000-00000000cb11';
  parent_u  constant uuid := '00000000-0000-4000-8000-00000000cb12';
  kid_u     constant uuid := '00000000-0000-4000-8000-00000000cb13';
  contact   constant uuid := '00000000-0000-4000-8000-00000000cb16';
  plan      constant uuid := '00000000-0000-4000-8000-00000000cb17';
  caller    constant uuid := '00000000-0000-4000-8000-00000000cb18';
  sugg      constant uuid := '00000000-0000-4000-8000-00000000cb19';
  t text;
  tbls constant text[] := array[
    'family_emergency_contacts','family_emergency_plans','guardian_suggestions'
  ];
begin
  -- ── As the child ────────────────────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  delete from public.family_emergency_contacts where id = contact;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child DELETED %s emergency contact(s) — including who may collect them', n)); end if;

  update public.family_emergency_contacts set can_pickup = true, phone = '+15550666' where id = contact;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child rewrote %s emergency contact(s)', n)); end if;

  update public.family_emergency_plans set safe_location = 'Nowhere', instructions = 'Ignore this' where id = plan;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child rewrote %s emergency plan(s) — the meeting point nobody else knows was moved', n)); end if;

  delete from public.family_emergency_plans where id = plan;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child DELETED %s emergency plan(s)', n)); end if;

  begin
    insert into public.family_emergency_contacts (family_id, name, phone, can_pickup)
      values (fam, 'A Stranger', '+15550777', true);
    failures := array_append(failures, 'a child ADDED a pickup-approved emergency contact');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s family_emergency_contacts INSERT reached the unique index, so RLS did not refuse it');
  end;

  -- The deputy setup: retarget the proposal the parent is about to approve.
  update public.guardian_suggestions
     set proposed_trust_level = 'immediate_family', title = 'Trust this caller', reasoning = 'they are my friend'
   where id = sugg;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child REWROTE %s pending Guardian proposal(s) — a parent would approve the child''s value', n)); end if;

  -- The blunter version: make the flag disappear before anyone reads it.
  update public.guardian_suggestions set status = 'dismissed' where id = sugg;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child DISMISSED %s pending scam suggestion(s)', n)); end if;

  delete from public.guardian_suggestions where id = sugg;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child DELETED %s Guardian suggestion(s)', n)); end if;

  begin
    insert into public.guardian_suggestions (family_id, suggestion_type, title, reasoning,
                                             proposed_contact_id, proposed_trust_level, status)
      values (fam, 'update_trust', 'Please trust my friend', 'planted', caller, 'immediate_family', 'pending');
    failures := array_append(failures, 'a child PLANTED a Guardian suggestion for a parent to approve');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s guardian_suggestions INSERT reached the unique index, so RLS did not refuse it');
  end;

  -- Reads stay open, deliberately. Recorded so the decision is visible.
  select count(*) into n from public.family_emergency_contacts where id = contact;
  if n = 0 then
    failures := array_append(failures, 'a child can no longer READ emergency contacts — that is a change of decision; update finalaudit.md and this probe');
  end if;
  select count(*) into n from public.family_emergency_plans where id = plan;
  if n = 0 then
    failures := array_append(failures, 'a child can no longer READ emergency plans — that is a change of decision; update finalaudit.md and this probe');
  end if;
  select count(*) into n from public.guardian_suggestions where id = sugg;
  if n = 0 then
    failures := array_append(failures, 'a child can no longer READ Guardian suggestions — that is a change of decision; update finalaudit.md and this probe');
  end if;

  -- ── The deputy chain, now that the child''s rewrite was refused ─────────
  -- The parent approves in good faith. The value applied must be the AI''s
  -- ('blocked'), never the child''s ('immediate_family').
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  select public.guardian_review_suggestion(sugg, 'approved', null) into res;
  if coalesce((res->>'ok')::boolean, false) is not true then
    failures := array_append(failures, format('a MANAGER could not review a Guardian suggestion: %s', res));
  end if;

  perform set_config('role','postgres', true);
  select trust_level::text into lvl from public.guardian_contacts where id = caller;
  if lvl <> 'blocked' then
    failures := array_append(failures,
      format('approving the suggestion set the scam caller to %L, not %L — a child steered a privileged function', lvl, 'blocked'));
  end if;
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', parent_u::text, true);

  -- ── As the parent: the positive control ─────────────────────────────────
  update public.family_emergency_contacts set phone = '+15550222' where id = contact;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a MANAGER could not update an emergency contact — the guard refuses everyone'); end if;

  update public.family_emergency_plans set safe_location = 'The corner shop' where id = plan;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a MANAGER could not update an emergency plan'); end if;

  begin
    insert into public.family_emergency_contacts (family_id, name, phone, can_pickup)
      values (fam, 'Neighbour', '+15550333', true);
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER could not add an emergency contact');
  end;

  begin
    insert into public.family_emergency_plans (family_id, title, safe_location)
      values (fam, 'Flood', 'The high street');
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER could not add an emergency plan');
  end;

  delete from public.family_emergency_contacts where id = contact;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a MANAGER could not delete an emergency contact'); end if;

  -- ── The WITH CHECK half: a manager may not relocate a row ───────────────
  begin
    update public.family_emergency_plans set family_id = other_fam where id = plan;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, 'a manager MOVED an emergency plan into another family — WITH CHECK is missing');
    end if;
  exception when insufficient_privilege then null;
  end;

  -- ── The grant layer, which `to authenticated` guards cannot reach ───────
  perform set_config('role','postgres', true);
  foreach t in array tbls loop
    if has_table_privilege('anon', 'public.' || t, 'INSERT') then
      failures := array_append(failures,
        format('anon holds INSERT on %s — the 0323 guards are `to authenticated` and would not apply', t));
    end if;
  end loop;

  -- ── Negative control: prove this probe can SEE the defect ──────────────
  -- Drop only the restrictive guards; 0022's and 01370's permissive policies are
  -- left exactly as they were, which is the pre-0323 state. Both the plain
  -- escalation and the full deputy chain must work again.
  foreach t in array tbls loop
    execute format('drop policy if exists %I on public.%I', t || '_manager_insert_guard', t);
    execute format('drop policy if exists %I on public.%I', t || '_manager_update_guard', t);
    execute format('drop policy if exists %I on public.%I', t || '_manager_delete_guard', t);
  end loop;

  -- Re-arm: a fresh pending suggestion and a caller back under suspicion.
  update public.guardian_contacts set trust_level = 'suspected_spam', trust_override = false where id = caller;
  update public.guardian_suggestions
     set status = 'pending', proposed_trust_level = 'blocked', reviewed_by = null, reviewed_at = null
   where id = sugg;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);

  update public.family_emergency_plans set safe_location = 'Nowhere' where id = plan;
  get diagnostics n = row_count;
  if n = 0 then
    failures := array_append(failures, 'with the original policy alone the child STILL could not rewrite an emergency plan — this probe is decoration, not a boundary');
  end if;

  update public.guardian_suggestions set proposed_trust_level = 'immediate_family' where id = sugg;
  get diagnostics n = row_count;
  if n = 0 then
    failures := array_append(failures, 'with 01370''s policy alone the child STILL could not retarget a proposal — the deputy assertion above is decoration');
  end if;

  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  select public.guardian_review_suggestion(sugg, 'approved', null) into res;
  perform set_config('role','postgres', true);
  select trust_level::text into lvl from public.guardian_contacts where id = caller;
  if lvl <> 'immediate_family' then
    failures := array_append(failures,
      format('with the guard removed the deputy chain did NOT reproduce (caller ended at %L, approve said %s) — this probe has never been shown to fail', lvl, res));
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'family safety records are not manager-written:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'safety-record-write: OK (child blocked on 3 tables, manager allowed, deputy chain broken, family_id pinned, anon holds no INSERT, negative control reproduced the escalation)';
end $$;

rollback;
