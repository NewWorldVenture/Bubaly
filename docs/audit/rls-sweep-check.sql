-- ── The 2026-10-10 RLS sweep: every high and medium finding, both directions ──
--
-- Companion to 0481_the_rls_sweep_narrows_the_household_tables_to_their_roles.
-- For each high and medium finding in
-- rls-sweep.md this probe proves, as real `authenticated` sessions under RLS:
--
--   * FORBIDDEN: the action the finding names is refused (RLS filters it to zero
--     rows, a WITH CHECK refuses it, or a guard trigger raises 42501) for the
--     role that should not have it: guest, caregiver or child as the finding says;
--   * LEGITIMATE: the action the app needs still lands for the parent (manager),
--     and for the row's own member where the app lets them write it.
--
-- Every attempt runs in its own subtransaction that is rolled back whatever it
-- did (pg_temp.sweep_try), so a breach on an unfixed database cannot change the
-- fixture under a later assertion: each line measures one thing.
--
-- Findings 0481 only partly closes are asserted only for the part
-- it closes, and the rest is printed as a NOTICE so it is not mistaken for proof:
--   behavior_logs   a child still logs about THEMSELVES (0338/0377 decision; three probes pin it),
--                   and a guest still reads the log (member-scope-crossing pins the read policy);
--   health_visits / immunizations
--                   a child or teen still reads the family hub (0414 / M23; health-record-boundary pins it);
--   meal_votes      a non-guest member can still close a vote and stamp winner_option_id;
--   wishlist_items  the owner can still SELECT claimed_by / is_purchased (needs a view; not in the SQL);
--   expense_split_shares  a debtor can still zero their own share_cents (optional trigger, not in the SQL);
--   member_locations / pets / pet_care_records  the caregiver half is an owner decision (ROLE-SCOPE-001).
--
-- Rolled back: nothing here outlives the run.
\set ON_ERROR_STOP on

begin;

-- Run q as `who` under RLS, then roll it back. Returns the row count, 'refused'
-- (42501: RLS WITH CHECK or a guard trigger), or 'error:<sqlstate> <message>'.
create function pg_temp.sweep_try(who uuid, q text) returns text language plpgsql as $f$
declare n int; res text;
begin
  perform set_config('request.jwt.claim.sub', who::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', who::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    begin
      execute q;
      get diagnostics n = row_count;
      raise exception using errcode = 'SW001', message = n::text;
    exception
      when sqlstate 'SW001' then res := sqlerrm;
      when insufficient_privilege then res := 'refused';
      when others then res := 'error:' || sqlstate || ' ' || sqlerrm;
    end;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return res;
end $f$;

-- `select count(*) …` as `who`.
create function pg_temp.sweep_count(who uuid, q text) returns text language plpgsql as $f$
declare n int; res text;
begin
  perform set_config('request.jwt.claim.sub', who::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', who::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    execute q into n;
    res := n::text;
  exception
    when insufficient_privilege then res := 'refused';
    when others then res := 'error:' || sqlstate || ' ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return res;
end $f$;

create temp table sweep_result (
  seq serial, finding text, kind text, label text, got text, ok boolean
) on commit drop;

-- want: 'refused' (refused or zero rows), 'ok' (at least one row), 'zero', 'some'
create function pg_temp.sweep_expect(finding text, label text, got text, want text) returns void language plpgsql as $f$
declare ok boolean;
begin
  ok := case want
          when 'refused' then got = 'refused' or got = '0'
          when 'zero'    then got = '0' or got = 'refused'
          when 'ok'      then got ~ '^[1-9][0-9]*$'
          when 'some'    then got ~ '^[1-9][0-9]*$'
        end;
  insert into sweep_result (finding, kind, label, got, ok)
  values (finding, case when want in ('refused', 'zero') then 'FORBIDDEN' else 'LEGIT' end, label, got, ok);
end $f$;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000005e000';
  uP  uuid := '00000000-0000-4000-8000-00000005e001';  -- parent (manager)
  uK  uuid := '00000000-0000-4000-8000-00000005e002';  -- child (the attacker)
  uS  uuid := '00000000-0000-4000-8000-00000005e003';  -- sibling, a child
  uG  uuid := '00000000-0000-4000-8000-00000005e004';  -- guest (grandparent invite)
  uC  uuid := '00000000-0000-4000-8000-00000005e005';  -- caregiver (babysitter)
  mP uuid; mK uuid; mS uuid; mG uuid; mC uuid;
  medK uuid; medS uuid; doseS uuid; doseK uuid;
  taxFam uuid; taxK uuid;
  ch uuid; asgK uuid; asgS uuid;
  subS_rej uuid; subK_res uuid; subK_rej uuid; subK_rej2 uuid; subK_appr uuid; subK_rej3 uuid; subK_rej4 uuid; subK_pend uuid;
  dS uuid; dR uuid; dK_open uuid;
  feed uuid;
  split1 uuid; shK uuid; shS uuid; split2 uuid;
  annP uuid; dateP uuid;
  poll uuid; opt1 uuid;
  visS uuid; immS uuid;
  voteP uuid; optP1 uuid;
  pet uuid; rec uuid;
  locK uuid; locG uuid;
  rw uuid; redK uuid; redK2 uuid;
  wS uuid; wP uuid; wS_byC uuid; wS_byK uuid;
  memP uuid;
  F text;
begin
  -- ── fixture, written as the table owner with no session (auth.uid() null) ──
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  insert into auth.users (id, email) values
    (uP, 'sweep-parent@example.test'), (uK, 'sweep-child@example.test'), (uS, 'sweep-sibling@example.test'),
    (uG, 'sweep-guest@example.test'), (uC, 'sweep-carer@example.test')
  on conflict (id) do nothing;
  insert into public.families (id, name) values (fam, 'RLS sweep probe') on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uP, 'Parent', 'parent', true) returning id into mP;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uK, 'Kid', 'child', true) returning id into mK;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uS, 'Sib', 'child', true) returning id into mS;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uG, 'Grandma', 'guest', true) returning id into mG;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uC, 'Sitter', 'caregiver', true) returning id into mC;

  insert into public.medications (family_id, member_id, name, created_by) values (fam, mK, 'Kid med', uP) returning id into medK;
  insert into public.medications (family_id, member_id, name, created_by) values (fam, mS, 'Sib med', uP) returning id into medS;
  insert into public.medication_doses (family_id, medication_id, member_id, scheduled_for, status, logged_by)
    values (fam, medS, mS, now() - interval '1 hour', 'taken', uP) returning id into doseS;
  insert into public.medication_doses (family_id, medication_id, member_id, scheduled_for, status, logged_by)
    values (fam, medK, mK, now() - interval '1 hour', 'taken', uK) returning id into doseK;

  insert into public.tax_documents (family_id, tax_year, category, name, amount_cents, created_by)
    values (fam, 2025, 'w2', 'Parent W-2', 9000000, uP) returning id into taxFam;
  insert into public.tax_documents (family_id, tax_year, category, name, member_id, created_by)
    values (fam, 2025, '1099', 'Kid 1099', mK, uP) returning id into taxK;

  insert into public.chores (family_id, title) values (fam, 'Dishes') returning id into ch;
  insert into public.chore_assignments (family_id, chore_id, member_id) values (fam, ch, mK) returning id into asgK;
  insert into public.chore_assignments (family_id, chore_id, member_id) values (fam, ch, mS) returning id into asgS;
  insert into public.chore_submissions (family_id, assignment_id, chore_id, member_id, kind, status) values (fam, asgS, ch, mS, 'photo', 'rejected') returning id into subS_rej;
  insert into public.chore_submissions (family_id, assignment_id, chore_id, member_id, kind, status) values (fam, asgK, ch, mK, 'photo', 'rejected') returning id into subK_res;
  insert into public.chore_submissions (family_id, assignment_id, chore_id, member_id, kind, status) values (fam, asgK, ch, mK, 'photo', 'rejected') returning id into subK_rej;
  insert into public.chore_submissions (family_id, assignment_id, chore_id, member_id, kind, status) values (fam, asgK, ch, mK, 'photo', 'rejected') returning id into subK_rej2;
  insert into public.chore_submissions (family_id, assignment_id, chore_id, member_id, kind, status, media_paths) values (fam, asgK, ch, mK, 'photo', 'approved', array['a.jpg']) returning id into subK_appr;
  insert into public.chore_submissions (family_id, assignment_id, chore_id, member_id, kind, status, media_paths) values (fam, asgK, ch, mK, 'photo', 'rejected', array['a.jpg']) returning id into subK_rej3;
  insert into public.chore_submissions (family_id, assignment_id, chore_id, member_id, kind, status) values (fam, asgK, ch, mK, 'photo', 'needs_improvement') returning id into subK_rej4;
  insert into public.chore_submissions (family_id, assignment_id, chore_id, member_id, kind, status) values (fam, asgK, ch, mK, 'photo', 'pending') returning id into subK_pend;
  insert into public.chore_disputes (family_id, submission_id, member_id, status) values (fam, subS_rej, mS, 'open') returning id into dS;
  insert into public.chore_disputes (family_id, submission_id, member_id, status, resolution, resolved_by, resolved_at)
    values (fam, subK_res, mK, 'resolved', 'Upheld', mP, now()) returning id into dR;
  insert into public.chore_disputes (family_id, submission_id, member_id, status) values (fam, subK_rej2, mK, 'open') returning id into dK_open;

  insert into public.calendar_feeds (family_id, name, url) values (fam, 'School', 'https://example.test/school.ics') returning id into feed;

  insert into public.expense_splits (family_id, description, total_cents, paid_by, created_by) values (fam, 'Groceries', 3000, mP, uP) returning id into split1;
  insert into public.expense_split_shares (family_id, split_id, member_id, share_cents) values (fam, split1, mK, 1000) returning id into shK;
  insert into public.expense_split_shares (family_id, split_id, member_id, share_cents) values (fam, split1, mS, 1000) returning id into shS;
  insert into public.expense_splits (family_id, description, total_cents, paid_by, created_by) values (fam, 'Rent', 500000, mP, uP) returning id into split2;

  insert into public.family_announcements (family_id, title, author_id, author_member_id) values (fam, 'Dinner at 6', uP, mP) returning id into annP;
  insert into public.family_dates (family_id, title, event_date, created_by) values (fam, 'Anniversary', '2010-06-01', uP) returning id into dateP;

  insert into public.family_polls (family_id, question, created_by) values (fam, 'Beach or hills?', uP) returning id into poll;
  insert into public.family_poll_options (family_id, poll_id, label) values (fam, poll, 'Beach') returning id into opt1;

  insert into public.health_visits (family_id, member_id, kind, title, outcome, created_by) values (fam, mS, 'therapy', 'Session', 'Diagnosis text', uP) returning id into visS;
  insert into public.immunizations (family_id, member_id, vaccine, created_by) values (fam, mS, 'MMR', uP) returning id into immS;

  insert into public.kid_progress (family_id, member_id, xp, level) values (fam, mK, 10, 1), (fam, mS, 500, 3);

  insert into public.meal_votes (family_id, created_by, title, status) values (fam, uP, 'Friday dinner', 'open') returning id into voteP;
  insert into public.meal_vote_options (vote_id, family_id, label) values (voteP, fam, 'Tacos') returning id into optP1;

  insert into public.pets (family_id, name) values (fam, 'Rex') returning id into pet;
  insert into public.pet_care_records (family_id, pet_id, title) values (fam, pet, 'Rabies') returning id into rec;

  insert into public.member_locations (family_id, member_id, latitude, longitude) values (fam, mK, 51.5, -0.1) returning id into locK;
  insert into public.member_locations (family_id, member_id, latitude, longitude) values (fam, mG, 52.5, -1.1) returning id into locG;

  insert into public.rewards (family_id, title, cost_points) values (fam, 'Movie night', 50) returning id into rw;
  insert into public.reward_redemptions (family_id, reward_id, member_id, reward_title, cost_points, status)
    values (fam, rw, mK, 'Movie night', 50, 'requested') returning id into redK;
  insert into public.reward_redemptions (family_id, reward_id, member_id, reward_title, cost_points, status)
    values (fam, rw, mK, 'Movie night', 50, 'requested') returning id into redK2;

  insert into public.wishlist_items (family_id, member_id, title, created_by) values (fam, mS, 'Bike', uS) returning id into wS;
  insert into public.wishlist_items (family_id, member_id, title, created_by) values (fam, mP, 'Book', uP) returning id into wP;
  insert into public.wishlist_items (family_id, member_id, title, created_by, claimed_by, claimed_at) values (fam, mS, 'Lego', uS, mC, now()) returning id into wS_byC;
  insert into public.wishlist_items (family_id, member_id, title, created_by, claimed_by, claimed_at) values (fam, mS, 'Kite', uS, mK, now()) returning id into wS_byK;

  insert into public.trip_memories (family_id, title, note, created_by, member_id) values (fam, 'Beach day', 'Sunny', uP, mP) returning id into memP;

  -- ── medication_doses (high) ──────────────────────────────────────────────
  F := 'medication_doses (high)';
  perform pg_temp.sweep_expect(F, 'child reads a sibling''s dose', pg_temp.sweep_count(uK, format('select count(*) from public.medication_doses where id = %L', doseS)), 'zero');
  perform pg_temp.sweep_expect(F, 'guest reads a member''s dose', pg_temp.sweep_count(uG, format('select count(*) from public.medication_doses where id = %L', doseS)), 'zero');
  perform pg_temp.sweep_expect(F, 'child marks a sibling''s dose skipped', pg_temp.sweep_try(uK, format('update public.medication_doses set status = ''skipped'', taken_at = null where id = %L', doseS)), 'refused');
  perform pg_temp.sweep_expect(F, 'child deletes a sibling''s dose', pg_temp.sweep_try(uK, format('delete from public.medication_doses where id = %L', doseS)), 'refused');
  perform pg_temp.sweep_expect(F, 'child logs a dose of a sibling''s medicine in their own name', pg_temp.sweep_try(uK, format('insert into public.medication_doses (family_id, medication_id, member_id, scheduled_for, status, logged_by) values (%L, %L, %L, now(), ''taken'', %L)', fam, medS, mK, uK)), 'refused');
  perform pg_temp.sweep_expect(F, 'child logs a dose naming the sibling', pg_temp.sweep_try(uK, format('insert into public.medication_doses (family_id, medication_id, member_id, scheduled_for, status, logged_by) values (%L, %L, %L, now(), ''taken'', %L)', fam, medS, mS, uK)), 'refused');
  perform pg_temp.sweep_expect(F, 'parent reads the sibling''s dose', pg_temp.sweep_count(uP, format('select count(*) from public.medication_doses where id = %L', doseS)), 'some');
  perform pg_temp.sweep_expect(F, 'parent corrects the sibling''s dose', pg_temp.sweep_try(uP, format('update public.medication_doses set status = ''skipped'' where id = %L', doseS)), 'ok');
  perform pg_temp.sweep_expect(F, 'child reads their own dose', pg_temp.sweep_count(uK, format('select count(*) from public.medication_doses where id = %L', doseK)), 'some');
  perform pg_temp.sweep_expect(F, 'child logs a dose of their own medicine', pg_temp.sweep_try(uK, format('insert into public.medication_doses (family_id, medication_id, member_id, scheduled_for, status, logged_by) values (%L, %L, %L, now(), ''taken'', %L)', fam, medK, mK, uK)), 'ok');
  perform pg_temp.sweep_expect(F, 'child corrects their own dose', pg_temp.sweep_try(uK, format('update public.medication_doses set status = ''skipped'' where id = %L', doseK)), 'ok');

  -- ── tax_documents (high) ─────────────────────────────────────────────────
  F := 'tax_documents (high)';
  perform pg_temp.sweep_expect(F, 'guest reads the parent''s W-2', pg_temp.sweep_count(uG, format('select count(*) from public.tax_documents where id = %L', taxFam)), 'zero');
  perform pg_temp.sweep_expect(F, 'caregiver reads the parent''s W-2', pg_temp.sweep_count(uC, format('select count(*) from public.tax_documents where id = %L', taxFam)), 'zero');
  perform pg_temp.sweep_expect(F, 'child reads the parent''s W-2', pg_temp.sweep_count(uK, format('select count(*) from public.tax_documents where id = %L', taxFam)), 'zero');
  perform pg_temp.sweep_expect(F, 'caregiver deletes the family''s tax vault', pg_temp.sweep_try(uC, format('delete from public.tax_documents where family_id = %L', fam)), 'refused');
  perform pg_temp.sweep_expect(F, 'guest rewrites a tax document', pg_temp.sweep_try(uG, format('update public.tax_documents set amount_cents = 0, storage_path = null where id = %L', taxFam)), 'refused');
  perform pg_temp.sweep_expect(F, 'child adds a tax document', pg_temp.sweep_try(uK, format('insert into public.tax_documents (family_id, tax_year, name) values (%L, 2025, ''fake'')', fam)), 'refused');
  perform pg_temp.sweep_expect(F, 'parent reads the W-2', pg_temp.sweep_count(uP, format('select count(*) from public.tax_documents where id = %L', taxFam)), 'some');
  perform pg_temp.sweep_expect(F, 'parent edits the W-2', pg_temp.sweep_try(uP, format('update public.tax_documents set note = ''checked'' where id = %L', taxFam)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent adds a tax document', pg_temp.sweep_try(uP, format('insert into public.tax_documents (family_id, tax_year, name) values (%L, 2025, ''1098'')', fam)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent deletes a tax document', pg_temp.sweep_try(uP, format('delete from public.tax_documents where id = %L', taxFam)), 'ok');
  perform pg_temp.sweep_expect(F, 'child reads a document about them', pg_temp.sweep_count(uK, format('select count(*) from public.tax_documents where id = %L', taxK)), 'some');

  -- ── chore_disputes (medium) ──────────────────────────────────────────────
  F := 'chore_disputes (medium)';
  perform pg_temp.sweep_expect(F, 'child deletes a sibling''s open dispute', pg_temp.sweep_try(uK, format('delete from public.chore_disputes where id = %L', dS)), 'refused');
  perform pg_temp.sweep_expect(F, 'child deletes a resolved dispute (the parent''s decision)', pg_temp.sweep_try(uK, format('delete from public.chore_disputes where id = %L', dR)), 'refused');
  perform pg_temp.sweep_expect(F, 'child files a dispute in their own name against a sibling''s submission', pg_temp.sweep_try(uK, format('insert into public.chore_disputes (family_id, submission_id, member_id, status) values (%L, %L, %L, ''open'')', fam, subS_rej, mK)), 'refused');
  perform pg_temp.sweep_expect(F, 'child disputes their own rejected submission', pg_temp.sweep_try(uK, format('insert into public.chore_disputes (family_id, submission_id, member_id, status) values (%L, %L, %L, ''open'')', fam, subK_rej, mK)), 'ok');
  perform pg_temp.sweep_expect(F, 'child withdraws their own open dispute (the app''s rollback)', pg_temp.sweep_try(uK, format('delete from public.chore_disputes where id = %L', dK_open)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent deletes a dispute', pg_temp.sweep_try(uP, format('delete from public.chore_disputes where id = %L', dS)), 'ok');

  -- ── calendar_feeds (medium) ──────────────────────────────────────────────
  F := 'calendar_feeds (medium)';
  perform pg_temp.sweep_expect(F, 'guest subscribes the family to a new calendar', pg_temp.sweep_try(uG, format('insert into public.calendar_feeds (family_id, name, url) values (%L, ''x'', ''https://attacker.example/cal.ics'')', fam)), 'refused');
  perform pg_temp.sweep_expect(F, 'guest repoints a feed''s url', pg_temp.sweep_try(uG, format('update public.calendar_feeds set url = ''https://attacker.example/cal.ics'' where id = %L', feed)), 'refused');
  perform pg_temp.sweep_expect(F, 'guest deletes a feed', pg_temp.sweep_try(uG, format('delete from public.calendar_feeds where id = %L', feed)), 'refused');
  perform pg_temp.sweep_expect(F, 'parent adds a feed', pg_temp.sweep_try(uP, format('insert into public.calendar_feeds (family_id, name, url) values (%L, ''Club'', ''https://example.test/club.ics'')', fam)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent renames a feed', pg_temp.sweep_try(uP, format('update public.calendar_feeds set name = ''School (new)'' where id = %L', feed)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent deletes a feed', pg_temp.sweep_try(uP, format('delete from public.calendar_feeds where id = %L', feed)), 'ok');

  -- ── behavior_logs (medium; partly closed) ────────────────────────────────
  F := 'behavior_logs (medium)';
  perform pg_temp.sweep_expect(F, 'child logs a challenging entry about a sibling', pg_temp.sweep_try(uK, format('insert into public.behavior_logs (family_id, member_id, kind, note, points, logged_by) values (%L, %L, ''concern'', ''Hit me'', -10, %L)', fam, mS, uK)), 'refused');
  perform pg_temp.sweep_expect(F, 'guest logs a behaviour entry', pg_temp.sweep_try(uG, format('insert into public.behavior_logs (family_id, member_id, kind, note, logged_by) values (%L, %L, ''positive'', ''x'', %L)', fam, mG, uG)), 'refused');
  perform pg_temp.sweep_expect(F, 'parent logs about the child', pg_temp.sweep_try(uP, format('insert into public.behavior_logs (family_id, member_id, kind, note, points, logged_by) values (%L, %L, ''positive'', ''Helped'', 5, %L)', fam, mK, uP)), 'ok');
  perform pg_temp.sweep_expect(F, 'child logs about themselves (kept: 0338/0377 decision)', pg_temp.sweep_try(uK, format('insert into public.behavior_logs (family_id, member_id, kind, note, logged_by) values (%L, %L, ''neutral'', ''Read a book'', %L)', fam, mK, uK)), 'ok');

  -- ── expense_split_shares (medium) ────────────────────────────────────────
  F := 'expense_split_shares (medium)';
  perform pg_temp.sweep_expect(F, 'guest reads the family''s debts', pg_temp.sweep_count(uG, format('select count(*) from public.expense_split_shares where family_id = %L', fam)), 'zero');
  perform pg_temp.sweep_expect(F, 'guest marks a debt settled', pg_temp.sweep_try(uG, format('update public.expense_split_shares set settled = true, settled_at = now(), share_cents = 0 where id = %L', shK)), 'refused');
  perform pg_temp.sweep_expect(F, 'caregiver deletes the ledger', pg_temp.sweep_try(uC, format('delete from public.expense_split_shares where family_id = %L', fam)), 'refused');
  perform pg_temp.sweep_expect(F, 'child marks a sibling''s debt to the parent settled', pg_temp.sweep_try(uK, format('update public.expense_split_shares set settled = true, settled_at = now() where id = %L', shS)), 'refused');
  perform pg_temp.sweep_expect(F, 'child adds a share naming a sibling to the parent''s split', pg_temp.sweep_try(uK, format('insert into public.expense_split_shares (family_id, split_id, member_id, share_cents) values (%L, %L, %L, 5000)', fam, split1, mS)), 'refused');
  perform pg_temp.sweep_expect(F, 'parent reads the shares', pg_temp.sweep_count(uP, format('select count(*) from public.expense_split_shares where family_id = %L', fam)), 'some');
  perform pg_temp.sweep_expect(F, 'parent settles a share', pg_temp.sweep_try(uP, format('update public.expense_split_shares set settled = true, settled_at = now() where id = %L', shK)), 'ok');
  perform pg_temp.sweep_expect(F, 'child settles their own share', pg_temp.sweep_try(uK, format('update public.expense_split_shares set settled = true, settled_at = now() where id = %L', shK)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent adds a share to their split', pg_temp.sweep_try(uP, format('insert into public.expense_split_shares (family_id, split_id, member_id, share_cents) values (%L, %L, %L, 1000)', fam, split1, mC)), 'ok');

  -- ── chore_submissions (medium) ───────────────────────────────────────────
  F := 'chore_submissions (medium)';
  perform pg_temp.sweep_expect(F, 'child throws an approved (paid) submission back to disputed', pg_temp.sweep_try(uK, format('update public.chore_submissions set status = ''disputed'' where id = %L', subK_appr)), 'refused');
  perform pg_temp.sweep_expect(F, 'child swaps the proof on a reviewed submission', pg_temp.sweep_try(uK, format('update public.chore_submissions set media_paths = array[''other.jpg''], note = ''x'' where id = %L', subK_rej3)), 'refused');
  perform pg_temp.sweep_expect(F, 'child deletes their own rejected submission', pg_temp.sweep_try(uK, format('delete from public.chore_submissions where id = %L', subK_rej3)), 'refused');
  perform pg_temp.sweep_expect(F, 'child submits against a sibling''s assignment', pg_temp.sweep_try(uK, format('insert into public.chore_submissions (family_id, assignment_id, chore_id, member_id, kind, status) values (%L, %L, %L, %L, ''photo'', ''pending'')', fam, asgS, ch, mK)), 'refused');
  perform pg_temp.sweep_expect(F, 'child re-points a submission at a sibling''s assignment', pg_temp.sweep_try(uK, format('update public.chore_submissions set assignment_id = %L where id = %L', asgS, subK_pend)), 'refused');
  perform pg_temp.sweep_expect(F, 'child submits proof for their own assignment', pg_temp.sweep_try(uK, format('insert into public.chore_submissions (family_id, assignment_id, chore_id, member_id, kind, status) values (%L, %L, %L, %L, ''photo'', ''pending'')', fam, asgK, ch, mK)), 'ok');
  perform pg_temp.sweep_expect(F, 'child disputes a needs_improvement verdict', pg_temp.sweep_try(uK, format('update public.chore_submissions set status = ''disputed'' where id = %L', subK_rej4)), 'ok');
  perform pg_temp.sweep_expect(F, 'child cleans up their own pending submission', pg_temp.sweep_try(uK, format('delete from public.chore_submissions where id = %L', subK_pend)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent edits a reviewed submission', pg_temp.sweep_try(uP, format('update public.chore_submissions set note = ''Reviewed'' where id = %L', subK_appr)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent deletes a rejected submission', pg_temp.sweep_try(uP, format('delete from public.chore_submissions where id = %L', subK_rej3)), 'ok');

  -- ── family_announcements (medium) ────────────────────────────────────────
  F := 'family_announcements (medium)';
  perform pg_temp.sweep_expect(F, 'child posts as the parent', pg_temp.sweep_try(uK, format('insert into public.family_announcements (family_id, title, author_member_id, is_pinned) values (%L, ''No school tomorrow'', %L, true)', fam, mP)), 'refused');
  perform pg_temp.sweep_expect(F, 'child rewrites the parent''s post', pg_temp.sweep_try(uK, format('update public.family_announcements set title = ''x'' where id = %L', annP)), 'refused');
  perform pg_temp.sweep_expect(F, 'child deletes the board', pg_temp.sweep_try(uK, format('delete from public.family_announcements where family_id = %L', fam)), 'refused');
  perform pg_temp.sweep_expect(F, 'guest posts', pg_temp.sweep_try(uG, format('insert into public.family_announcements (family_id, title, author_id) values (%L, ''hi'', %L)', fam, uG)), 'refused');
  perform pg_temp.sweep_expect(F, 'parent posts', pg_temp.sweep_try(uP, format('insert into public.family_announcements (family_id, title, author_id, author_member_id) values (%L, ''Trip!'', %L, %L)', fam, uP, mP)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent pins a post', pg_temp.sweep_try(uP, format('update public.family_announcements set is_pinned = true where id = %L', annP)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent deletes a post', pg_temp.sweep_try(uP, format('delete from public.family_announcements where id = %L', annP)), 'ok');

  -- ── family_dates (medium) ────────────────────────────────────────────────
  F := 'family_dates (medium)';
  perform pg_temp.sweep_expect(F, 'child deletes the parents'' anniversary', pg_temp.sweep_try(uK, format('delete from public.family_dates where id = %L', dateP)), 'refused');
  perform pg_temp.sweep_expect(F, 'child rewrites a celebration', pg_temp.sweep_try(uK, format('update public.family_dates set event_date = ''2020-01-01'', remind_days = 0 where id = %L', dateP)), 'refused');
  perform pg_temp.sweep_expect(F, 'guest adds a celebration', pg_temp.sweep_try(uG, format('insert into public.family_dates (family_id, title, event_date) values (%L, ''x'', current_date)', fam)), 'refused');
  perform pg_temp.sweep_expect(F, 'parent adds a celebration', pg_temp.sweep_try(uP, format('insert into public.family_dates (family_id, title, event_date, created_by) values (%L, ''Gotcha Day'', current_date, %L)', fam, uP)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent edits a celebration', pg_temp.sweep_try(uP, format('update public.family_dates set remind_days = 3 where id = %L', dateP)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent deletes a celebration', pg_temp.sweep_try(uP, format('delete from public.family_dates where id = %L', dateP)), 'ok');

  -- ── expense_splits (medium) ──────────────────────────────────────────────
  F := 'expense_splits (medium)';
  perform pg_temp.sweep_expect(F, 'guest reads the family''s spending', pg_temp.sweep_count(uG, format('select count(*) from public.expense_splits where family_id = %L', fam)), 'zero');
  perform pg_temp.sweep_expect(F, 'guest adds an expense', pg_temp.sweep_try(uG, format('insert into public.expense_splits (family_id, description, total_cents, created_by) values (%L, ''Rent'', 500000, %L)', fam, uG)), 'refused');
  perform pg_temp.sweep_expect(F, 'guest deletes an expense (and its shares)', pg_temp.sweep_try(uG, format('delete from public.expense_splits where id = %L', split2)), 'refused');
  perform pg_temp.sweep_expect(F, 'child enters an expense as the parent', pg_temp.sweep_try(uK, format('insert into public.expense_splits (family_id, description, total_cents, paid_by, created_by) values (%L, ''Rent'', 500000, %L, %L)', fam, mK, uP)), 'refused');
  perform pg_temp.sweep_expect(F, 'parent reads the spending', pg_temp.sweep_count(uP, format('select count(*) from public.expense_splits where family_id = %L', fam)), 'some');
  perform pg_temp.sweep_expect(F, 'child enters their own expense (app is open to members)', pg_temp.sweep_try(uK, format('insert into public.expense_splits (family_id, description, total_cents, paid_by, created_by) values (%L, ''Pizza'', 2000, %L, %L)', fam, mK, uK)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent deletes an expense', pg_temp.sweep_try(uP, format('delete from public.expense_splits where id = %L', split2)), 'ok');

  -- ── family_polls (+ family_poll_votes) (medium) ──────────────────────────
  F := 'family_polls + family_poll_votes (medium)';
  perform pg_temp.sweep_expect(F, 'guest creates a poll', pg_temp.sweep_try(uG, format('insert into public.family_polls (family_id, question, created_by) values (%L, ''?'', %L)', fam, uG)), 'refused');
  perform pg_temp.sweep_expect(F, 'guest closes a poll', pg_temp.sweep_try(uG, format('update public.family_polls set status = ''closed'' where id = %L', poll)), 'refused');
  perform pg_temp.sweep_expect(F, 'guest deletes a poll (and every vote)', pg_temp.sweep_try(uG, format('delete from public.family_polls where id = %L', poll)), 'refused');
  perform pg_temp.sweep_expect(F, 'guest votes', pg_temp.sweep_try(uG, format('insert into public.family_poll_votes (family_id, poll_id, option_id, member_id) values (%L, %L, %L, %L)', fam, poll, opt1, mG)), 'refused');
  perform pg_temp.sweep_expect(F, 'child votes', pg_temp.sweep_try(uK, format('insert into public.family_poll_votes (family_id, poll_id, option_id, member_id) values (%L, %L, %L, %L)', fam, poll, opt1, mK)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent creates a poll', pg_temp.sweep_try(uP, format('insert into public.family_polls (family_id, question, created_by) values (%L, ''Pizza or pasta?'', %L)', fam, uP)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent closes a poll', pg_temp.sweep_try(uP, format('update public.family_polls set status = ''closed'' where id = %L', poll)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent deletes a poll', pg_temp.sweep_try(uP, format('delete from public.family_polls where id = %L', poll)), 'ok');

  -- ── health_visits / immunizations (medium; guest + caregiver half) ───────
  F := 'health_visits (medium)';
  perform pg_temp.sweep_expect(F, 'guest reads a child''s therapy visit', pg_temp.sweep_count(uG, format('select count(*) from public.health_visits where id = %L', visS)), 'zero');
  perform pg_temp.sweep_expect(F, 'caregiver reads a child''s therapy visit', pg_temp.sweep_count(uC, format('select count(*) from public.health_visits where id = %L', visS)), 'zero');
  perform pg_temp.sweep_expect(F, 'parent reads the visit', pg_temp.sweep_count(uP, format('select count(*) from public.health_visits where id = %L', visS)), 'some');
  perform pg_temp.sweep_expect(F, 'the visit''s own member reads it', pg_temp.sweep_count(uS, format('select count(*) from public.health_visits where id = %L', visS)), 'some');
  F := 'immunizations (medium)';
  perform pg_temp.sweep_expect(F, 'guest reads a child''s vaccinations', pg_temp.sweep_count(uG, format('select count(*) from public.immunizations where id = %L', immS)), 'zero');
  perform pg_temp.sweep_expect(F, 'caregiver reads a child''s vaccinations', pg_temp.sweep_count(uC, format('select count(*) from public.immunizations where id = %L', immS)), 'zero');
  perform pg_temp.sweep_expect(F, 'parent reads the vaccinations', pg_temp.sweep_count(uP, format('select count(*) from public.immunizations where id = %L', immS)), 'some');
  perform pg_temp.sweep_expect(F, 'the record''s own member reads it', pg_temp.sweep_count(uS, format('select count(*) from public.immunizations where id = %L', immS)), 'some');

  -- ── kid_progress (medium) ────────────────────────────────────────────────
  F := 'kid_progress (medium)';
  perform pg_temp.sweep_expect(F, 'child awards themselves a million XP through the RPC', pg_temp.sweep_try(uK, format('select 1 where (public.kid_progress_apply_completion(%L, %L, 1000000, current_date) ->> ''ok'')::boolean', fam, mK)), 'refused');
  perform pg_temp.sweep_expect(F, 'child takes XP away from a sibling through the RPC', pg_temp.sweep_try(uK, format('select 1 where (public.kid_progress_revert_completion(%L, %L, 400, 0, 0, null, 0, 0, null) ->> ''ok'')::boolean', fam, mS)), 'refused');
  perform pg_temp.sweep_expect(F, 'child writes their own level directly', pg_temp.sweep_try(uK, format('update public.kid_progress set xp = 999999, level = 50 where member_id = %L', mK)), 'refused');
  perform pg_temp.sweep_expect(F, 'parent awards XP through the RPC (approval)', pg_temp.sweep_try(uP, format('select 1 where (public.kid_progress_apply_completion(%L, %L, 20, current_date) ->> ''ok'')::boolean', fam, mK)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent reverts XP through the RPC', pg_temp.sweep_try(uP, format('select 1 where (public.kid_progress_revert_completion(%L, %L, 100, 0, 0, null, 0, 0, null) ->> ''ok'')::boolean', fam, mS)), 'ok');

  -- ── meal_vote_options (medium) ───────────────────────────────────────────
  F := 'meal_vote_options (medium)';
  perform pg_temp.sweep_expect(F, 'child renames the leading option', pg_temp.sweep_try(uK, format('update public.meal_vote_options set label = ''Brussels sprouts'' where id = %L', optP1)), 'refused');
  perform pg_temp.sweep_expect(F, 'child deletes an option (and its ballots)', pg_temp.sweep_try(uK, format('delete from public.meal_vote_options where id = %L', optP1)), 'refused');
  perform pg_temp.sweep_expect(F, 'child adds an option to the parent''s vote', pg_temp.sweep_try(uK, format('insert into public.meal_vote_options (vote_id, family_id, label) values (%L, %L, ''Candy'')', voteP, fam)), 'refused');
  perform pg_temp.sweep_expect(F, 'guest adds an option', pg_temp.sweep_try(uG, format('insert into public.meal_vote_options (vote_id, family_id, label) values (%L, %L, ''Candy'')', voteP, fam)), 'refused');
  perform pg_temp.sweep_expect(F, 'the vote''s creator adds an option', pg_temp.sweep_try(uP, format('insert into public.meal_vote_options (vote_id, family_id, label) values (%L, %L, ''Curry'')', voteP, fam)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent edits an option', pg_temp.sweep_try(uP, format('update public.meal_vote_options set label = ''Fish tacos'' where id = %L', optP1)), 'ok');

  -- ── meal_votes (medium) ──────────────────────────────────────────────────
  F := 'meal_votes (medium)';
  perform pg_temp.sweep_expect(F, 'guest starts a vote', pg_temp.sweep_try(uG, format('insert into public.meal_votes (family_id, title, created_by) values (%L, ''x'', %L)', fam, uG)), 'refused');
  perform pg_temp.sweep_expect(F, 'guest closes a vote', pg_temp.sweep_try(uG, format('update public.meal_votes set status = ''closed'' where id = %L', voteP)), 'refused');
  perform pg_temp.sweep_expect(F, 'child deletes the parent''s vote', pg_temp.sweep_try(uK, format('delete from public.meal_votes where id = %L', voteP)), 'refused');
  perform pg_temp.sweep_expect(F, 'child starts their own vote', pg_temp.sweep_try(uK, format('insert into public.meal_votes (family_id, title, created_by) values (%L, ''Saturday lunch'', %L)', fam, uK)), 'ok');
  perform pg_temp.sweep_expect(F, 'child closes a vote (kept open to non-guests)', pg_temp.sweep_try(uK, format('update public.meal_votes set status = ''closed'' where id = %L', voteP)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent deletes a vote', pg_temp.sweep_try(uP, format('delete from public.meal_votes where id = %L', voteP)), 'ok');

  -- ── pet_care_records / pets (medium; guest half) ─────────────────────────
  F := 'pet_care_records (medium)';
  perform pg_temp.sweep_expect(F, 'guest fakes a vaccination', pg_temp.sweep_try(uG, format('insert into public.pet_care_records (family_id, pet_id, kind, title) values (%L, %L, ''vaccination'', ''Rabies'')', fam, pet)), 'refused');
  perform pg_temp.sweep_expect(F, 'guest clears a next-due date', pg_temp.sweep_try(uG, format('update public.pet_care_records set next_due = null where id = %L', rec)), 'refused');
  perform pg_temp.sweep_expect(F, 'guest deletes the care ledger', pg_temp.sweep_try(uG, format('delete from public.pet_care_records where family_id = %L', fam)), 'refused');
  perform pg_temp.sweep_expect(F, 'parent adds a care record', pg_temp.sweep_try(uP, format('insert into public.pet_care_records (family_id, pet_id, kind, title) values (%L, %L, ''vet_visit'', ''Checkup'')', fam, pet)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent edits a care record', pg_temp.sweep_try(uP, format('update public.pet_care_records set next_due = current_date + 365 where id = %L', rec)), 'ok');
  perform pg_temp.sweep_expect(F, 'child adds a care record (members keep writing)', pg_temp.sweep_try(uK, format('insert into public.pet_care_records (family_id, pet_id, kind, title) values (%L, %L, ''weight'', ''Weighed'')', fam, pet)), 'ok');
  F := 'pets (medium)';
  perform pg_temp.sweep_expect(F, 'guest adds a pet', pg_temp.sweep_try(uG, format('insert into public.pets (family_id, name) values (%L, ''x'')', fam)), 'refused');
  perform pg_temp.sweep_expect(F, 'guest rewrites the vet''s number', pg_temp.sweep_try(uG, format('update public.pets set vet_phone = ''555'', microchip_id = ''x'' where id = %L', pet)), 'refused');
  perform pg_temp.sweep_expect(F, 'guest deletes the pets (and their records)', pg_temp.sweep_try(uG, format('delete from public.pets where family_id = %L', fam)), 'refused');
  perform pg_temp.sweep_expect(F, 'parent adds a pet', pg_temp.sweep_try(uP, format('insert into public.pets (family_id, name) values (%L, ''Tom'')', fam)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent archives a pet', pg_temp.sweep_try(uP, format('update public.pets set is_active = false where id = %L', pet)), 'ok');

  -- ── member_locations (medium; guest half) ────────────────────────────────
  F := 'member_locations (medium)';
  perform pg_temp.sweep_expect(F, 'guest reads a child''s live location', pg_temp.sweep_count(uG, format('select count(*) from public.member_locations where id = %L', locK)), 'zero');
  perform pg_temp.sweep_expect(F, 'parent reads the child''s location', pg_temp.sweep_count(uP, format('select count(*) from public.member_locations where id = %L', locK)), 'some');
  perform pg_temp.sweep_expect(F, 'guest reads their own location', pg_temp.sweep_count(uG, format('select count(*) from public.member_locations where id = %L', locG)), 'some');

  -- ── reward_redemptions (medium) ──────────────────────────────────────────
  F := 'reward_redemptions (medium)';
  perform pg_temp.sweep_expect(F, 'child asks for a reward that is not in the catalogue, for 0 points', pg_temp.sweep_try(uK, format('insert into public.reward_redemptions (family_id, member_id, reward_id, reward_title, cost_points, status) values (%L, %L, null, ''Xbox'', 0, ''requested'')', fam, mK)), 'refused');
  perform pg_temp.sweep_expect(F, 'child files a request that already names a decider', pg_temp.sweep_try(uK, format('insert into public.reward_redemptions (family_id, member_id, reward_id, reward_title, cost_points, status, decided_by, decided_at) values (%L, %L, %L, ''Movie night'', 50, ''requested'', %L, now())', fam, mK, rw, mP)), 'refused');
  perform pg_temp.sweep_expect(F, 'child strips the reward and price off their own request', pg_temp.sweep_try(uK, format('update public.reward_redemptions set reward_id = null, cost_points = 0 where id = %L', redK)), 'refused');
  perform pg_temp.sweep_expect(F, 'child asks for a catalogue reward at its price', pg_temp.sweep_try(uK, format('insert into public.reward_redemptions (family_id, member_id, reward_id, reward_title, cost_points, status) values (%L, %L, %L, ''Movie night'', 50, ''requested'')', fam, mK, rw)), 'ok');
  perform pg_temp.sweep_expect(F, 'child withdraws their own request', pg_temp.sweep_try(uK, format('update public.reward_redemptions set status = ''cancelled'' where id = %L', redK)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent turns a request down', pg_temp.sweep_try(uP, format('update public.reward_redemptions set status = ''rejected'', decided_by = %L, decided_at = now() where id = %L', mP, redK2)), 'ok');

  -- ── wishlist_items (medium) ──────────────────────────────────────────────
  F := 'wishlist_items (medium)';
  perform pg_temp.sweep_expect(F, 'child deletes a sibling''s wish', pg_temp.sweep_try(uK, format('delete from public.wishlist_items where id = %L', wS)), 'refused');
  perform pg_temp.sweep_expect(F, 'child rewrites the parent''s wish', pg_temp.sweep_try(uK, format('update public.wishlist_items set title = ''x'', price = 0 where id = %L', wP)), 'refused');
  perform pg_temp.sweep_expect(F, 'child adds to a sibling''s list', pg_temp.sweep_try(uK, format('insert into public.wishlist_items (family_id, member_id, title) values (%L, %L, ''Socks'')', fam, mS)), 'refused');
  perform pg_temp.sweep_expect(F, 'child claims a gift in someone else''s name', pg_temp.sweep_try(uK, format('update public.wishlist_items set claimed_by = %L, claimed_at = now() where id = %L', mC, wS)), 'refused');
  perform pg_temp.sweep_expect(F, 'child releases someone else''s claim', pg_temp.sweep_try(uK, format('update public.wishlist_items set claimed_by = null, claimed_at = null where id = %L', wS_byC)), 'refused');
  perform pg_temp.sweep_expect(F, 'child adds to their own list', pg_temp.sweep_try(uK, format('insert into public.wishlist_items (family_id, member_id, title, created_by) values (%L, %L, ''Skates'', %L)', fam, mK, uK)), 'ok');
  perform pg_temp.sweep_expect(F, 'child claims a sibling''s wish for themselves', pg_temp.sweep_try(uK, format('update public.wishlist_items set claimed_by = %L, claimed_at = now() where id = %L', mK, wS)), 'ok');
  perform pg_temp.sweep_expect(F, 'child releases their own claim', pg_temp.sweep_try(uK, format('update public.wishlist_items set claimed_by = null, claimed_at = null where id = %L', wS_byK)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent edits a child''s wish', pg_temp.sweep_try(uP, format('update public.wishlist_items set priority = ''high'' where id = %L', wS)), 'ok');

  -- ── trip_memories (medium) ───────────────────────────────────────────────
  F := 'trip_memories (medium)';
  perform pg_temp.sweep_expect(F, 'guest adds to the trip journal', pg_temp.sweep_try(uG, format('insert into public.trip_memories (family_id, title, created_by) values (%L, ''x'', %L)', fam, uG)), 'refused');
  perform pg_temp.sweep_expect(F, 'guest erases the trip journal', pg_temp.sweep_try(uG, format('delete from public.trip_memories where family_id = %L', fam)), 'refused');
  perform pg_temp.sweep_expect(F, 'caregiver deletes a memory', pg_temp.sweep_try(uC, format('delete from public.trip_memories where id = %L', memP)), 'refused');
  perform pg_temp.sweep_expect(F, 'child rewrites the parent''s memory', pg_temp.sweep_try(uK, format('update public.trip_memories set note = ''x'', location = null where id = %L', memP)), 'refused');
  perform pg_temp.sweep_expect(F, 'child forges an entry as the parent', pg_temp.sweep_try(uK, format('insert into public.trip_memories (family_id, title, created_by) values (%L, ''x'', %L)', fam, uP)), 'refused');
  perform pg_temp.sweep_expect(F, 'parent adds a memory', pg_temp.sweep_try(uP, format('insert into public.trip_memories (family_id, title, created_by) values (%L, ''Hike'', %L)', fam, uP)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent edits a memory', pg_temp.sweep_try(uP, format('update public.trip_memories set note = ''Windy'' where id = %L', memP)), 'ok');
  perform pg_temp.sweep_expect(F, 'parent deletes a memory', pg_temp.sweep_try(uP, format('delete from public.trip_memories where id = %L', memP)), 'ok');
  perform pg_temp.sweep_expect(F, 'child adds their own memory', pg_temp.sweep_try(uK, format('insert into public.trip_memories (family_id, title, created_by) values (%L, ''Shells'', %L)', fam, uK)), 'ok');
end
$probe$;

-- ── verdict ──────────────────────────────────────────────────────────────────
do $verdict$
declare
  r record;
  bad int;
  total int;
  lines text := '';
begin
  select count(*) filter (where not ok), count(*) into bad, total from sweep_result;
  for r in
    select finding,
           count(*) filter (where kind = 'FORBIDDEN' and ok) as f_ok, count(*) filter (where kind = 'FORBIDDEN') as f_n,
           count(*) filter (where kind = 'LEGIT' and ok) as l_ok, count(*) filter (where kind = 'LEGIT') as l_n
      from sweep_result group by finding order by min(seq)
  loop
    raise notice '%: forbidden refused %/%, legitimate landed %/%', r.finding, r.f_ok, r.f_n, r.l_ok, r.l_n;
  end loop;
  for r in select * from sweep_result where not ok order by seq loop
    lines := lines || format(E'\n  - [%s] %s: %s (got %s)', r.finding, r.kind, r.label, r.got);
  end loop;
  if bad > 0 then
    raise exception 'rls-sweep: % of % assertions failed:%', bad, total, lines;
  end if;
  raise notice 'OK rls-sweep: all % assertions held — every high/medium finding''s forbidden action is refused for the offending role and the parent/owner action still lands. Still open by recorded decision: a child logs behaviour about themselves and a guest reads the behaviour log; a child or teen reads the family health hub (M23); a non-guest closes a meal vote and sets its winner; a wish''s owner can read its claim; a debtor can change their own share_cents; caregivers keep their reads of locations and their pet writes (ROLE-SCOPE-001).', total;
end
$verdict$;

rollback;
