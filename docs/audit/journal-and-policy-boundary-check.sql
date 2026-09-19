-- ── 0328: a private journal, and the insurance table that lost its twin ─────
--
-- TWO tables, one shape: the intent is written down and the policy does not
-- carry it.
--
-- `journal_entries` (0087). The module is titled "Personal Journal — private
-- reflection", its header says "scoped to the signed-in member", its fetcher
-- says `.eq('member_id', memberId)`, and the table carries
-- `is_private boolean NOT NULL DEFAULT true`. Its only policy is
-- `FOR ALL TO authenticated USING (is_family_member(family_id))`, and
-- `is_private` is referenced NOWHERE in the application — not a query, not a
-- filter, not a control. So the member scoping is a query filter, not a
-- boundary: one PostgREST call reads every journal in the family, and edits or
-- deletes them.
--
-- `family_insurance_policies` (policy numbers, premiums, agent phone numbers,
-- document paths) is `FOR ALL … is_family_member`, while its twin
-- `insurance_policies` — the same class of data, named on the same deny-list
-- line in lib/ai/context/policy.ts — has been manager-gated for writes all
-- along. `insurance-module.tsx` carries no role check of any kind.
--
-- Measured before 0328, as a signed-in child:
--   NOTICE: child read 1 of a SIBLING's private journal entries
--   NOTICE: child rewrote a SIBLING's journal entry
--   NOTICE: child deleted a SIBLING's journal entry
--   NOTICE: child rewrote the family's insurance policy number
--   NOTICE: child deactivated the family's insurance policy
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/journal-and-policy-boundary-check.sql
--
-- Re-runnable: the fixture family's rows are cleared before each run.
-- Audit C1-S8-07.
do $$
declare
  fam uuid := 'f0328000-0000-4000-8000-00000000fa01';
  up  uuid := 'f0328000-0000-4000-8000-00000000c001';  -- parent
  uk  uuid := 'f0328000-0000-4000-8000-00000000c002';  -- child (the attacker)
  us  uuid := 'f0328000-0000-4000-8000-00000000c003';  -- sibling (the subject)
  mp uuid; mk uuid; ms uuid; je uuid; pol uuid;
  n int; txt text; holes text[] := '{}';
begin
  insert into public.families (id, name) values (fam, '0328 journal and policies') on conflict do nothing;
  insert into auth.users (id, email) values
    (up, 'p0328@example.test'), (uk, 'k0328@example.test'), (us, 's0328@example.test')
    on conflict do nothing;
  delete from public.journal_entries           where family_id = fam;
  delete from public.family_insurance_policies where family_id = fam;
  delete from public.family_members            where family_id = fam;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, up, 'Parent', 'parent', true) returning id into mp;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uk, 'Kid', 'child', true) returning id into mk;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, us, 'Sibling', 'child', true) returning id into ms;

  insert into public.journal_entries (family_id, member_id, entry_date, mood, title, body, created_by)
    values (fam, ms, current_date, 'low', 'Hard day', 'Something I have told nobody.', us)
    returning id into je;
  -- The sibling's own entry, to prove self-access is not what this closes.
  insert into public.journal_entries (family_id, member_id, entry_date, body, created_by)
    values (fam, mk, current_date, 'My own entry.', uk);

  insert into public.family_insurance_policies
    (family_id, policy_type, insurer, policy_number, premium_amount, is_active, created_by)
    values (fam, 'auto', 'Insurer', 'POL-12345', 120, true, up) returning id into pol;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', uk::text, true);
  if auth.uid() is distinct from uk then
    raise exception '0328: impersonation failed — auth.uid() is %, expected the child', auth.uid();
  end if;

  -- ── 1. Reading a sibling's private journal ────────────────────────────────
  select count(*) into n from public.journal_entries where member_id = ms;
  if n > 0 then
    holes := holes || format('child read %s of a SIBLING''s private journal entries', n);
    raise notice 'child read % of a SIBLING''s private journal entries', n;
  end if;

  -- ── 2. Rewriting one ──────────────────────────────────────────────────────
  begin
    update public.journal_entries set body = 'Everything is fine.' where id = je;
    get diagnostics n = row_count;
  exception when insufficient_privilege then n := 0;
  end;
  if n > 0 then
    holes := holes || 'child rewrote a SIBLING''s journal entry'::text;
    raise notice 'child rewrote a SIBLING''s journal entry';
  end if;

  -- ── 3. Deleting one ───────────────────────────────────────────────────────
  begin
    delete from public.journal_entries where id = je;
    get diagnostics n = row_count;
  exception when insufficient_privilege then n := 0;
  end;
  if n > 0 then
    holes := holes || 'child deleted a SIBLING''s journal entry'::text;
    raise notice 'child deleted a SIBLING''s journal entry';
  end if;

  -- ── 4/5. The insurance policy its twin has always protected ───────────────
  begin
    update public.family_insurance_policies set policy_number = 'POL-99999' where id = pol;
    get diagnostics n = row_count;
  exception when insufficient_privilege then n := 0;
  end;
  if n > 0 then
    holes := holes || 'child rewrote the family''s insurance policy number'::text;
    raise notice 'child rewrote the family''s insurance policy number';
  end if;
  begin
    update public.family_insurance_policies set is_active = false where id = pol;
    get diagnostics n = row_count;
  exception when insufficient_privilege then n := 0;
  end;
  if n > 0 then
    holes := holes || 'child deactivated the family''s insurance policy'::text;
    raise notice 'child deactivated the family''s insurance policy';
  end if;

  -- ── What must still work ──────────────────────────────────────────────────
  -- Your own journal is yours: read, write, edit and delete.
  select count(*) into n from public.journal_entries where member_id = mk;
  if n < 1 then raise exception '0328: a member can no longer read their OWN journal'; end if;
  insert into public.journal_entries (family_id, member_id, entry_date, body, created_by)
    values (fam, mk, current_date, 'A second entry.', uk);
  update public.journal_entries set body = 'Edited.' where member_id = mk and body = 'A second entry.';
  delete from public.journal_entries where member_id = mk and body = 'Edited.';

  -- Writing in someone else's name is refused even for your own reading.
  begin
    insert into public.journal_entries (family_id, member_id, entry_date, body, created_by)
      values (fam, ms, current_date, 'Planted.', uk);
    holes := holes || 'child wrote a journal entry in a SIBLING''s name'::text;
    raise notice 'child wrote a journal entry in a SIBLING''s name';
  exception when insufficient_privilege then null;
  end;

  -- Every member still READS the insurance policies — that is the product.
  select count(*) into n from public.family_insurance_policies where family_id = fam;
  if n < 1 then
    raise exception '0328: a family member can no longer read the insurance policies';
  end if;
  reset role;

  -- ── A parent keeps the pen on both ────────────────────────────────────────
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', up::text, true);
  update public.family_insurance_policies set policy_number = 'POL-54321' where id = pol;
  select policy_number into txt from public.family_insurance_policies where id = pol;
  if txt is distinct from 'POL-54321' then
    raise exception '0328: a parent can no longer edit an insurance policy (number is %)', txt;
  end if;
  insert into public.family_insurance_policies
    (family_id, policy_type, insurer, policy_number, is_active, created_by)
    values (fam, 'home', 'Insurer', 'POL-2', true, up);
  delete from public.family_insurance_policies where policy_number = 'POL-2';

  -- And a parent does NOT gain a window into a child's journal. Nothing in the
  -- product ever offered that, so granting it here would be a new capability
  -- wearing a security fix's clothes.
  select count(*) into n from public.journal_entries where member_id = ms;
  if n > 0 then
    raise exception '0328: a parent can read a child''s private journal — that is a product decision, not this migration''s to make';
  end if;
  reset role;

  if array_length(holes, 1) is not null then
    raise exception '0328: %', array_to_string(holes, '; ');
  end if;
  raise notice '0328 OK — a journal is its author''s, and policy numbers are the parents''';
end $$;
