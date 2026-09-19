-- Behavioural proof for 0331, run as real `authenticated` sessions under RLS.
--
-- `journal_entries` had ONE policy — `FOR ALL using/with check
-- (is_family_member(family_id))` — so every member of a household could read,
-- edit, delete and forge every other member's journal. Two places in the
-- codebase already called this data private and neither was the database:
-- the module header ("Personal Journal … scoped to the signed-in member") and
-- lib/ai/context/policy.ts, which excludes the table from AI context with the
-- reason "private journals".
--
-- The two sharpest cases are the ones the client cannot mitigate, because the
-- client IS the attacker's tool here: the module deletes by id alone
-- (`.delete().eq('id', id)`), and INSERT never pinned `member_id`, so an entry
-- could be written INTO someone else's journal.
--
-- Reads stay family-wide and are asserted so: narrowing them is a household
-- policy question, filed rather than guessed.
--
-- No blanket `grant ... on all tables in schema public` here. The bootstrap's
-- `alter default privileges` already gives `authenticated` full DML on every
-- table a migration creates, so the restatement was redundant — and once
-- migrations began revoking DML deliberately (0300 takes the paywall columns
-- away from the client), it stopped being redundant and started undoing them
-- for every probe that runs after this one against the shared database.
grant usage on schema public to authenticated;

do $$
declare
  fam        uuid := 'ffff4444-0000-4000-8000-00000000000c';
  parent_uid uuid := 'f4000000-0000-4000-8000-000000000001';
  kid_uid    uuid := 'f4000000-0000-4000-8000-000000000002';
  parent_mid uuid;
  kid_mid    uuid;
  parent_entry uuid;
  kid_entry    uuid;
  n          int;
  v_body     text;
begin
  -- Re-runnable, with identifiers of its own so a sibling probe's teardown
  -- cannot reach in.
  delete from public.journal_entries where family_id = fam;
  delete from public.family_members   where user_id in (parent_uid, kid_uid);
  delete from public.families         where id = fam;

  insert into public.families (id, name) values (fam, 'Journal');
  insert into auth.users (id, email) values
    (parent_uid, 'jp@example.test'), (kid_uid, 'jk@example.test') on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, parent_uid, 'Parent', 'parent', true) returning id into parent_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, kid_uid, 'Kid', 'child', true) returning id into kid_mid;

  insert into public.journal_entries (family_id, member_id, created_by, body, is_private)
  values (fam, parent_mid, parent_uid, 'the parent''s private reflection', true)
  returning id into parent_entry;

  -- ══ POSITIVE CONTROLS FIRST ════════════════════════════════════════════
  perform set_config('request.jwt.claim.sub', kid_uid::text, true);
  set local role authenticated;

  insert into public.journal_entries (family_id, member_id, created_by, body)
  values (fam, kid_mid, kid_uid, 'the child''s own entry') returning id into kid_entry;

  update public.journal_entries set body = 'the child edits their own' where id = kid_entry;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a child can no longer edit their OWN journal entry (%)', n;
  end if;

  -- Reads are family-wide by design, and that is the filed owner decision
  -- rather than an oversight. Asserted so the migration cannot quietly narrow
  -- it without this probe saying so.
  select count(*) into n from public.journal_entries where family_id = fam;
  if n <> 2 then
    raise exception 'journal reads are no longer family-wide (% of 2 visible)', n;
  end if;

  -- ══ THE BOUNDARY ═══════════════════════════════════════════════════════

  -- 1. Editing a parent's entry. The module updates by id alone, so RLS is the
  --    only thing that ever said no.
  update public.journal_entries set body = 'rewritten by the child' where id = parent_entry;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child rewrote a parent''s journal entry (%)', n;
  end if;

  -- 2. Deleting a parent's entry — `.delete().eq('id', id)`, no author check.
  delete from public.journal_entries where id = parent_entry;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child deleted a parent''s journal entry (%)', n;
  end if;

  -- 3. Forging one INTO the parent's journal.
  begin
    insert into public.journal_entries (family_id, member_id, created_by, body)
    values (fam, parent_mid, kid_uid, 'a forged entry in the parent''s journal');
    raise exception 'a child wrote an entry into a parent''s journal';
  exception when insufficient_privilege then
    null;
  end;

  -- 4. Handing their own entry to the parent — the WITH CHECK half. USING
  --    admits the row (it is theirs); only a symmetric WITH CHECK refuses the
  --    row it would become. This is 0327's lesson applied here.
  begin
    update public.journal_entries set member_id = parent_mid where id = kid_entry;
    raise exception 'a child moved their own entry into a parent''s journal';
  exception when insufficient_privilege then
    null;
  end;

  -- The parent's entry is untouched, word for word.
  reset role;
  select body into v_body from public.journal_entries where id = parent_entry;
  if v_body is distinct from 'the parent''s private reflection' then
    raise exception 'the parent''s journal entry was altered: %', v_body;
  end if;

  -- ══ AND THE PARENT STILL OWNS THEIRS ═══════════════════════════════════
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  update public.journal_entries set body = 'the parent edits their own' where id = parent_entry;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a parent can no longer edit their own journal entry (%)', n;
  end if;
  delete from public.journal_entries where id = parent_entry;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a parent can no longer delete their own journal entry (%)', n;
  end if;

  reset role;
  delete from public.journal_entries where family_id = fam;
  delete from public.family_members   where user_id in (parent_uid, kid_uid);
  delete from public.families         where id = fam;

  raise notice '0331 journal write boundary: all assertions held';
end $$;
