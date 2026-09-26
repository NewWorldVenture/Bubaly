-- ── A playbook suggestion cannot smuggle a sensitive fact (0330) ───────────
--
-- `family_playbook_suggestions` (0126_family_playbook.sql:44-58) carries four
-- role-blind `is_family_member(family_id)` policies written through one
-- `format()` loop, never narrowed since — 0265's header says "No policy
-- changes: 0264 owns this table's RLS", and 0264 does not mention this table.
-- Its `category` CHECK admits `'medical'` and `'account'`.
--
-- `family_facts_insert` (0264_ai_surface_role_privacy.sql:115) is
--
--   is_family_member(family_id)
--   and (category not in ('medical','account') or can_manage_family(family_id))
--
-- and `confirmFact` (lib/services/memory/index.ts:672-727) is manager-gated and
-- copies the suggestion's OWN `member_id`, `category`, `label`, `value`,
-- `evidence`, `confidence` and `expires_at` into `family_facts`. So a child
-- writes the card, a parent presses Confirm, and the insert lands because it
-- runs in the PARENT's session — into a category the child cannot write and,
-- because `family_facts_select` carries the same rule, cannot read back. That
-- is AUTHZ-006's mechanism (`guardian_suggestions`) and AUTHZ-009's
-- (`wallet_goals`) for the third time.
--
-- The repair has to be narrow, and this probe has to prove BOTH halves or it is
-- proving the wrong thing. A member filing an ordinary card IS the product:
-- `rememberUnconfirmed` (memory/index.ts:361) writes the AI inbox on the
-- caller's own client with no role gate, and `refreshPlaybookAction`
-- (playbook-actions.ts:146) is fired by the Refresh button for any member.
-- Neither can produce a sensitive category — `rememberFact` refuses one four
-- lines earlier via `isSensitiveMemory`, and `learnPlaybook` emits only
-- `'preference'` and `'date'` — so closing the sensitive lane costs the product
-- nothing, and closing more than that would have been CENSUS-002 again.
--
-- Dismissing is open to every member too (`dismissSuggestionAction` and
-- `forgetFact` carry no role gate), which is why UPDATE is guarded by a BEFORE
-- trigger on the columns a confirm copies rather than by a policy on the table.
--
-- Asserts, in both directions:
--
--   1. a MANAGER can still author a medical card, and a parent's confirm still
--      carries it into `family_facts` — the whole flow must survive;
--   2. a child CANNOT author a 'medical' or an 'account' card;
--   3. a child CAN still author 'preference' and 'date' cards on both
--      legitimate lanes (the `ai_memory:` signature and the miner's slug);
--   4. a child CANNOT turn an ordinary card of their own into a medical one;
--   5. a child CANNOT rewrite the `label`, `value`, `evidence`, `member_id` or
--      `signature` of a manager's medical card — the text and the provenance
--      lane the parent reads while deciding;
--   6. a child CAN still dismiss BOTH kinds of card, and can still delete an
--      ordinary one — the guard is narrow on purpose;
--   7. a child CANNOT delete a manager's medical card;
--   8. reads are untouched — every member still sees every card;
--   9. NEGATIVE CONTROL: drop ONLY the two restrictive policies and the
--      trigger, leaving 0126's four permissive policies exactly as they were —
--      the pre-0330 state — and require the whole escalation to run again:
--      the child's medical INSERT succeeds, their direct `family_facts` insert
--      is still refused, the parent's confirm carries the child's text across
--      as a `medical` fact the child then reads back as 0 rows, and the
--      provenance the child chose through `signature` is what the fact records.
--
-- The INSERT and DELETE guards are policies, so a refusal arrives as 42501 on
-- insert and as zero rows on delete; the UPDATE guard is a trigger, so it
-- raises. All three are checked both ways: a write that CHANGED a row is a
-- breach whether or not anything was raised, and an insert that reaches a
-- unique index is one RLS let through.
--
-- NOT asserted, because 0330 does not close it and a probe must not claim a
-- guard that is not there: `confirmFact` still derives `family_facts.source`
-- from `suggestion.signature`, a dedupe key the row's author writes. The
-- negative control demonstrates that forgery rather than guarding it. It is an
-- application fix — see 0330's header.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/playbook-suggestions-cannot-smuggle-a-sensitive-fact-check.sql

\set FAM '00000000-0000-4000-8000-000000000b30'
\set UP  '00000000-0000-4000-8000-000000000b31'
\set UK  '00000000-0000-4000-8000-000000000b32'
\set MP  '00000000-0000-4000-8000-000000000b33'
\set MK  '00000000-0000-4000-8000-000000000b34'

begin;

insert into auth.users (id, email) values (:'UP','pb-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UK','pb-kid@example.com')    on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FAM','Playbook House',:'UP') on conflict do nothing;
-- The creator's member row is made by a trigger; pin its id and make it a manager.
update public.family_members set role = 'parent', id = :'MP'
  where family_id = :'FAM' and user_id = :'UP';
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values (:'MK', :'FAM', :'UK', 'Kid', 'child', true) on conflict do nothing;

grant select, insert, update, delete on public.family_playbook_suggestions to authenticated;
grant select, insert, update, delete on public.family_facts to authenticated;

do $$
declare
  n          int;
  failures   text[] := '{}';
  reproduced text[] := '{}';
  fam      constant uuid := '00000000-0000-4000-8000-000000000b30';
  parent_u constant uuid := '00000000-0000-4000-8000-000000000b31';
  kid_u    constant uuid := '00000000-0000-4000-8000-000000000b32';
  parent_m constant uuid := '00000000-0000-4000-8000-000000000b33';
  kid_m    constant uuid := '00000000-0000-4000-8000-000000000b34';
  s_med    constant uuid := '00000000-0000-4000-8000-000000000b35';  -- manager-authored medical card, about the PARENT
  s_pref   constant uuid := '00000000-0000-4000-8000-000000000b36';  -- child's memory-inbox card
  s_date   constant uuid := '00000000-0000-4000-8000-000000000b37';  -- child's playbook-refresh card
  s_smug   constant uuid := '00000000-0000-4000-8000-000000000b38';  -- the negative control's forgery
  -- The sentence a child would most like a parent to confirm.
  smuggled constant text := 'Peanut allergy outgrown — no epipen needed';
  new_fact uuid;
  got_cat  text;
  got_val  text;
  got_src  text;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- ── 1. As the PARENT: authoring a medical card is a manager's to do ──────
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  begin
    insert into public.family_playbook_suggestions
      (id, family_id, member_id, category, label, value, evidence, confidence, signature, status, created_by)
    values (s_med, fam, parent_m, 'medical', 'Allergy', 'Peanut allergy — carries an epipen',
            'Entered by a parent', 90, 'ai_memory:00000000000000000000000000000001', 'suggested', parent_u);
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER could not author a medical suggestion — the guard refuses everyone and the inbox is dead');
  end;

  -- ── 2. As the CHILD: the two categories family_facts_insert bars them from ─
  perform set_config('request.jwt.claim.sub', kid_u::text, true);

  begin
    insert into public.family_playbook_suggestions
      (family_id, member_id, category, label, value, evidence, confidence, signature, status, created_by)
    values (fam, kid_m, 'medical', 'Allergy', smuggled,
            'You told me last week', 95, 'ai_memory:0000000000000000000000000000000a', 'suggested', kid_u);
    failures := array_append(failures,
      format('a child AUTHORED a %L playbook suggestion reading %L — family_facts_insert bars them from that category, and confirmFact copies the card''s own fields across in the parent''s session', 'medical', smuggled));
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s medical suggestion INSERT reached a unique index, so RLS had already let it through');
  end;

  begin
    insert into public.family_playbook_suggestions
      (family_id, member_id, category, label, value, evidence, confidence, signature, status, created_by)
    values (fam, kid_m, 'account', 'Bank login', 'Shared with me',
            'You told me last week', 95, 'ai_memory:0000000000000000000000000000000b', 'suggested', kid_u);
    failures := array_append(failures, 'a child AUTHORED an ''account'' playbook suggestion — credentials by another name, and 0264 bars them from the fact it becomes');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s account suggestion INSERT reached a unique index, so RLS had already let it through');
  end;

  -- ── 3. The two legitimate lanes must keep working for that same child ────
  -- rememberUnconfirmed's card (lib/services/memory/index.ts:361).
  begin
    insert into public.family_playbook_suggestions
      (id, family_id, member_id, category, label, value, evidence, confidence, signature, status, created_by)
    values (s_pref, fam, null, 'preference', 'Go-to dinner', 'Taco night',
            'Mentioned in a conversation', 70, 'ai_memory:0000000000000000000000000000000c', 'suggested', kid_u);
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MEMBER could not file an ordinary ''preference'' card — rememberUnconfirmed runs on the caller''s own client with no role gate, and the memory inbox is now broken for every child');
  end;

  -- refreshPlaybookAction's card (playbook-actions.ts:146, learnPlaybook's 'date').
  begin
    insert into public.family_playbook_suggestions
      (id, family_id, member_id, category, label, value, evidence, confidence, signature, status, created_by)
    values (s_date, fam, null, 'date', 'Family tradition', 'Pumpkin patch in October',
            'Happened 3 years running around October', 85, 'tradition:pumpkin-patch', 'suggested', kid_u);
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MEMBER could not file a ''date'' card — the Refresh button on /dashboard/playbook has no role gate and now 500s for every child');
  end;

  -- ── 4. Converting an ordinary card of their own into a medical one ───────
  begin
    update public.family_playbook_suggestions
       set category = 'medical', label = 'Allergy', value = smuggled
     where id = s_pref;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, format('a child turned %s ordinary card(s) of their own into a ''medical'' one — the insert guard is walked around by an update', n));
    end if;
  exception when insufficient_privilege then null;
  end;

  -- ── 5. Rewriting the manager's medical card, field by field ──────────────
  begin
    update public.family_playbook_suggestions set label = 'Allergy', value = smuggled, evidence = 'You told me last week'
     where id = s_med;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, format('a child rewrote the label/value/evidence of %s medical card(s) — the parent decides while reading exactly those three, and confirmFact copies them', n));
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    update public.family_playbook_suggestions set member_id = kid_m where id = s_med;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, format('a child retargeted %s medical card(s) at a different member — confirmFact copies member_id, so the confirmed fact would be about whoever the child named', n));
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    update public.family_playbook_suggestions set signature = 'tradition:forged' where id = s_med;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, format('a child rewrote the signature of %s medical card(s) — confirmFact reads provenance off that column', n));
    end if;
  exception when insufficient_privilege then null;
  end;

  -- ── 6. Dismissal stays open to every member, on BOTH kinds of card ───────
  update public.family_playbook_suggestions set status = 'dismissed' where id = s_pref;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a member could not dismiss their OWN ordinary card — dismissSuggestionAction and forgetFact have no role gate'); end if;
  update public.family_playbook_suggestions set status = 'suggested' where id = s_pref;

  begin
    update public.family_playbook_suggestions set status = 'dismissed' where id = s_med;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, 'a member could not dismiss a MEDICAL card off their own inbox — a blanket UPDATE guard has taken the inbox away from the person reading it'); end if;
  exception when insufficient_privilege then
    failures := array_append(failures, 'a member could not dismiss a MEDICAL card off their own inbox — a blanket UPDATE guard has taken the inbox away from the person reading it');
  end;
  update public.family_playbook_suggestions set status = 'suggested' where id = s_med;

  -- ── 7. Deleting: a manager's medical card is not theirs to erase ─────────
  delete from public.family_playbook_suggestions where id = s_med;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child DELETED %s medical card(s) a parent had not yet read', n)); end if;

  -- …while an ordinary card of their own still goes.
  delete from public.family_playbook_suggestions where id = s_date;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a member could not delete an ORDINARY card — the delete guard is wider than the rule it mirrors'); end if;

  -- ── 8. Reads are deliberately untouched ──────────────────────────────────
  select count(*) into n from public.family_playbook_suggestions where id in (s_med, s_pref);
  if n <> 2 then
    failures := array_append(failures, format('a child now reads %s of 2 cards — either SELECT was narrowed (a product decision; update finalaudit.md and this probe) or an earlier unguarded write removed one', n));
  end if;

  -- ── 1b. The real flow end to end: a parent confirms the manager's card ───
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  begin
    insert into public.family_facts
      (family_id, member_id, category, label, value, notes, source, confidence, expires_at, created_by)
    select family_id, member_id, category, label, value,
           case when evidence is not null then 'Learned by Bubaly — ' || evidence else 'Learned by Bubaly' end,
           case when starts_with(signature, 'ai_memory:') then 'ai_conversation' else 'ai_inferred' end,
           confidence, expires_at, parent_u
      from public.family_playbook_suggestions where id = s_med
    returning id into new_fact;
    update public.family_playbook_suggestions set status = 'accepted', fact_id = new_fact where id = s_med;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, 'confirmFact could not mark the card accepted — the guard blocks the confirm it exists to protect'); end if;
  exception when insufficient_privilege then
    failures := array_append(failures, 'a PARENT could not confirm a medical card into family_facts — confirmFact is broken by this repair');
  end;

  -- And nothing the CHILD wrote reached family_facts.
  perform set_config('role','postgres', true);
  select count(*) into n from public.family_facts where family_id = fam and value = smuggled;
  if n <> 0 then
    failures := array_append(failures, format('%s family_facts row(s) carry the child''s smuggled text %L', n, smuggled));
  end if;

  -- ── 9. NEGATIVE CONTROL: prove this probe can SEE the defect ─────────────
  -- Drop ONLY what 0330 added. 0126's four permissive policies are left exactly
  -- as they were, which is precisely the pre-0330 state. The outer rollback
  -- undoes this along with everything else.
  drop policy if exists family_playbook_suggestions_sensitive_insert_guard on public.family_playbook_suggestions;
  drop policy if exists family_playbook_suggestions_sensitive_delete_guard on public.family_playbook_suggestions;
  drop trigger if exists trg_playbook_suggestion_sensitive_guard on public.family_playbook_suggestions;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);

  -- (a) the child authors the medical card again
  begin
    insert into public.family_playbook_suggestions
      (id, family_id, member_id, category, label, value, evidence, confidence, signature, status, created_by)
    values (s_smug, fam, kid_m, 'medical', 'Allergy', smuggled,
            'You told me last week', 95, 'ai_memory:0000000000000000000000000000000d', 'suggested', kid_u);
  exception when others then
    reproduced := array_append(reproduced, 'the child STILL could not author a medical suggestion with the 0330 guards removed');
  end;

  -- (b) …but the fact itself is still out of reach, which is what makes it an escalation
  begin
    insert into public.family_facts (family_id, member_id, category, label, value, source, created_by)
    values (fam, kid_m, 'medical', 'Allergy', smuggled, 'ai_conversation', kid_u);
    reproduced := array_append(reproduced, 'the child could write family_facts.category=''medical'' DIRECTLY — 0264 is not holding, and this finding is a different one');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      reproduced := array_append(reproduced, 'the child''s direct medical family_facts INSERT reached a unique index, so 0264 let it through');
  end;

  -- (c) the parent confirms, in their own session, exactly as confirmFact does
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  new_fact := null;
  begin
    insert into public.family_facts
      (family_id, member_id, category, label, value, notes, source, confidence, expires_at, created_by)
    select family_id, member_id, category, label, value,
           case when evidence is not null then 'Learned by Bubaly — ' || evidence else 'Learned by Bubaly' end,
           case when starts_with(signature, 'ai_memory:') then 'ai_conversation' else 'ai_inferred' end,
           confidence, expires_at, parent_u
      from public.family_playbook_suggestions where id = s_smug
    returning id into new_fact;
  exception when others then
    reproduced := array_append(reproduced, 'the parent''s confirm did not carry the child''s card into family_facts');
  end;

  perform set_config('role','postgres', true);
  select category, value, source into got_cat, got_val, got_src from public.family_facts where id = new_fact;
  if got_cat is distinct from 'medical' or got_val is distinct from smuggled then
    reproduced := array_append(reproduced, format('the confirmed fact came out %L / %L rather than the child''s medical text', got_cat, got_val));
  end if;
  -- The provenance half, demonstrated rather than guarded: the child picked
  -- 'ai_conversation' ("you said it and I kept it") by choosing the signature
  -- prefix. 0330 does not close this; confirmFact must stop reading `source`
  -- off a column the card's author writes.
  if got_src is distinct from 'ai_conversation' then
    reproduced := array_append(reproduced, format('the confirmed fact recorded source %L — the signature-derived provenance no longer behaves as AUTHZ-013 described, so this probe''s account of it is stale', got_src));
  end if;

  -- (d) …and the child cannot read back the fact they caused to be written
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  select count(*) into n from public.family_facts where id = new_fact;
  if n <> 0 then
    reproduced := array_append(reproduced, 'the child could READ the medical fact back — family_facts_select is not carrying 0264''s rule and this probe''s account of the finding is stale');
  end if;

  -- (e) the update half: turning their own ordinary card medical
  begin
    update public.family_playbook_suggestions set category = 'medical', value = smuggled where id = s_pref;
    get diagnostics n = row_count;
    if n <> 1 then reproduced := array_append(reproduced, 'with the trigger removed the child STILL could not make their own card medical'); end if;
  exception when others then
    reproduced := array_append(reproduced, 'with the trigger removed the child STILL could not make their own card medical');
  end;

  -- (f) the delete half: erasing a card a parent had not read
  delete from public.family_playbook_suggestions where id = s_med;
  get diagnostics n = row_count;
  if n <> 1 then reproduced := array_append(reproduced, 'with the delete guard removed the child STILL could not erase the manager''s medical card'); end if;

  perform set_config('role','postgres', true);

  if array_length(reproduced, 1) is not null then
    failures := array_append(failures,
      'NEGATIVE CONTROL did not reproduce the defect, so this probe is decoration rather than a boundary: ' || array_to_string(reproduced, '; '));
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a playbook suggestion can still smuggle a sensitive fact:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'playbook-suggestions-sensitive-category: OK (a child files ordinary cards on both lanes, dismisses either kind and deletes their own; only a manager authors, edits or erases a medical or account card; a parent''s confirm still works; negative control reproduced the child-authored medical fact end to end)';
end $$;

rollback;
