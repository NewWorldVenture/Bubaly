-- Behavioural proof for 0265: a memory says where it came from, and an edit
-- cannot take that away.
--
-- The scheme this replaces put provenance in the `notes` text column: an
-- inferred fact's notes began "Learned by Bubaly". Two things broke, and both
-- are asserted below against a real Postgres.
--
-- NEGATIVE CONTROL, and it runs FIRST, before any of the four sections
-- ---------------------------------------------------------------------------
-- The mechanism under test here is a CHECK CONSTRAINT, not RLS, and that is
-- established rather than assumed. §3's two refusals are the only
-- `exception`-shaped assertions in this file and both catch `check_violation`
-- (23514); the constraints that raise it, `family_facts_source_check` and
-- `family_facts_confidence_check`, are added by
-- 0265_family_facts_provenance.sql:50-72, and grepping BOTH names across
-- supabase/migrations returns that one file — nothing later drops, alters or
-- re-creates either, so 0265 is the GOVERNING migration and not merely the
-- first one to mention the columns. §5 re-reads that claim out of
-- pg_constraint on every run, so it is not a grep frozen into this comment.
--
-- RLS is not what refuses here. 0264_ai_surface_role_privacy.sql:107-134
-- created this table's four policies and 0357_a_member_only_rewrites_their_
-- own_memory.sql:121-145 re-enables RLS and drops and re-creates
-- `family_facts_update` and `family_facts_delete` on a narrower predicate (an
-- earlier version of this paragraph said 0264 "owns" all four; a later
-- migration re-creating a policy is exactly how that sentence went stale).
-- Neither is in the path: every probe runs as `postgres` — verify-pg.sh:25
-- exports PGUSER=postgres,
-- .github/workflows/ci.yml:196 sets the same, and run-probes.sh issues no
-- `set role` — and a superuser bypasses both row-level security and table
-- GRANTs, so no policy of 0264's or 0357's and no missing privilege can be
-- what says no.
--
-- Nor is a trigger: the ONLY trigger on public.family_facts is
-- `set_family_facts_updated` (0123:29-31), BEFORE UPDATE only, running
-- public.set_updated_at (0003:42-47), whose whole body is
-- `new.updated_at = now(); return new;` — it fires on no INSERT and rejects
-- nothing. Two migrations attach triggers from the CATALOG rather than a
-- literal table list: 0003:86-98 attaches set_updated_at to every table
-- carrying `updated_at`, but ran BEFORE 0123 created this one; 0034:692-704
-- does the same scoped to `table_name like 'social\_%'`. Every other
-- `execute format('… create trigger …')` loop in the tree (some thirty-five
-- files, 0013 through 0338 — too many to keep listing here, and an earlier
-- enumeration of thirteen had already gone stale) iterates a literal array of
-- its own tables, none of which is family_facts;
-- `grep -rn "on public.family_facts" supabase/migrations | grep -i trigger`
-- returns 0123:29-30 only; and 0330's guard trigger is on
-- family_playbook_suggestions (0330:263), not here. That inventory is what a
-- reader checks by hand; what the BUILD checks is §5, which reads pg_trigger
-- and requires the table to carry exactly that one trigger in exactly that
-- shape.
--
-- So the mechanism keys on ONE COLUMN'S VALUE, and the control is that value
-- turned the other way: the same session running the same statement with an
-- ADMITTED value, which must land. The legs are at the top of the block below,
-- with what each one would catch. §5, after the refusals, then ties the
-- refusals to the NAMED constraints — a same-predicate CHECK under another
-- name, or a BEFORE trigger raising `using errcode = 'check_violation'`,
-- passes every leg and every refusal and is caught only there.
do $$
declare
  fam    uuid := 'ddddaaaa-dddd-4ddd-8ddd-dddddddddddd';
  mine   uuid; theirs uuid; stale uuid;
  src    text;
  n      int;
  ok     boolean;
  -- the negative control's own locals
  s          text;
  conf       smallint;
  ctl        uuid; ctl_live uuid;
  ctl_src    text; ctl_notes text;
  live       int;
  control_ok boolean := true;
  failures   text[] := '{}';
  -- §5's
  def        text;
  stray      text;
begin
  insert into public.families (id, name) values (fam, 'Provenance') on conflict do nothing;
  delete from public.family_facts where family_id = fam;

  -- ── NEGATIVE CONTROL: the same session, the same statements, the one value
  --    the mechanism keys on turned the other way — and these MUST LAND ──────
  -- It runs FIRST, before the four sections, because a refusal is evidence
  -- about 0265's CHECKs only once the REST of the statement is known to be
  -- acceptable. Without these legs, §3's two `exception when check_violation
  -- then null` handlers credit `family_facts_source_check` and
  -- `family_facts_confidence_check` for ANY 23514 that INSERT happens to raise,
  -- and 23514 is not a narrow signal:
  --
  --   * any CHECK added later anywhere on this row raises it from the SAME
  --     statement — a narrowed `category` vocabulary (0123 owns that list and
  --     'other' is only in it today), a `label <> ''`, a tightened
  --     `confidence` domain. §3 would then keep passing with the `source`
  --     vocabulary opened back up to free text, which is the whole point of
  --     0265 and the exact regression this probe exists to catch;
  --   * a BEFORE trigger that rejects rows raises it just as easily. This
  --     repository refuses writes with guard triggers in 0223, 0305, 0326 and
  --     0331, and 0330 put one on this table's own upstream
  --     (`family_playbook_suggestions`) to enforce a family_facts rule, so a
  --     trigger arriving on family_facts is not hypothetical.
  --
  -- Each leg names the SAME COLUMN LIST as the refusal it gives meaning to,
  -- with the same category, label and value, so the ONLY difference is the
  -- value the constraint keys on. A leg that quietly used a different column
  -- list or a different category would sail straight past the narrowing it is
  -- here to catch — the same reason the child_logins control repoints
  -- `user_id` rather than only renaming.
  --
  -- Every leg checks BOTH ways a write can fail to land. The loud way raises
  -- and is taken by the `when others` handler. The quiet way does not: a
  -- BEFORE INSERT trigger that RETURNs NULL vetoes the row with no error and
  -- a row_count of 0, and RETURNING hands back no row at all (an INSTEAD
  -- NOTHING rule does the same). The `row_count` and `is null` branches below
  -- are for that outcome; they are not dead code, and a control that only
  -- caught exceptions would report "landed" over a row that was never stored.

  -- Leg A — the `source` vocabulary, against §3's 'whatever' refusal. All FOUR
  -- admitted members must land in that statement's own shape. If any is
  -- refused, the 'whatever' refusal is not attributable to the vocabulary; and
  -- if the vocabulary is later narrowed to, say, 'user' alone, that shows up
  -- red HERE instead of passing silently down there.
  foreach s in array array['user','ai_conversation','ai_inferred','import'] loop
    begin
      insert into public.family_facts (family_id, category, label, value, source)
      values (fam, 'other', 'Bad source', 'x', s);
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, format('CONTROL FAILED: source=%L, an ADMITTED member of 0265''s vocabulary, stored %s rows with no error in the exact statement §3 expects ''whatever'' to be refused in — a row-vetoing BEFORE trigger or rule is on this table', s, n));
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: source=%L, an ADMITTED member of 0265''s vocabulary, was REFUSED (%s: %s) in the exact statement §3 expects ''whatever'' to be refused in — so that refusal proves nothing about family_facts_source_check, only that something said no', s, sqlstate, sqlerrm));
    end;
  end loop;

  -- Leg B — the `confidence` bound, against §3's 101 refusal. 100 is the
  -- largest value `confidence between 0 and 100` admits and 101 is the value
  -- refused, so the pair brackets the bound: if 100 lands and 101 does not,
  -- the refusal IS the bound and not some other check on the row. 0 covers the
  -- other end. Same column list as the refusal — `source` omitted, so the
  -- defaulted-provenance row shape is proven acceptable too.
  foreach conf in array array[0,100]::smallint[] loop
    begin
      insert into public.family_facts (family_id, category, label, value, confidence)
      values (fam, 'other', 'Impossible', 'x', conf);
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, format('CONTROL FAILED: confidence=%s, an ADMITTED value, stored %s rows with no error in the exact statement §3 expects 101 to be refused in — a row-vetoing BEFORE trigger or rule is on this table', conf, n));
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: confidence=%s, an ADMITTED value, was REFUSED (%s: %s) in the exact statement §3 expects 101 to be refused in — so that refusal is not attributable to family_facts_confidence_check', conf, sqlstate, sqlerrm));
    end;
  end loop;

  -- Leg C — §2, which is not a refusal but can pass VACUOUSLY, and that is the
  -- same defect wearing different clothes. §2 edits `notes` and then asserts
  -- `source` is unchanged. If the UPDATE matches no row, or the row cannot be
  -- read back, `src` comes back null, `src <> 'ai_conversation'` evaluates to
  -- null, and the check passes without ever having tested anything. Worse: if
  -- `source` is not writable AT ALL — made generated, pinned by a trigger, or
  -- derived from `notes` again, which is precisely the scheme 0265 replaced —
  -- then "an edit to notes did not change provenance" is true for a reason
  -- that has nothing to do with notes, and the probe is blind to the
  -- regression it was written for.
  --
  -- So: the same UPDATE verb naming the SAME COLUMN under test (`notes`) plus
  -- `source`, and the answer the other way — provenance DOES move when a
  -- statement names it, observably.
  --
  -- Two things this leg says on purpose. First, it DEMANDS that `source` is
  -- mutable by a plain UPDATE, which 0265 permits but does not promise. If a
  -- later migration pins provenance — a BEFORE UPDATE trigger forcing
  -- `new.source = old.source`, in the 0223/0305/0326/0330/0331 habit — this leg
  -- goes red against a database that is HEALTHIER than today's. That is the
  -- intended trade: the failure text names the cause in one read, and the fix
  -- is to rewrite this leg (and §2's reading of it) to the new rule, never to
  -- loosen the schema. Second, it runs as `postgres`, so it is NOT evidence
  -- that a non-superuser can move provenance; a column-level `revoke update
  -- (source)` would sail past this leg and past §2 alike. Who may rewrite a
  -- memory is the question of 0357 and its probe,
  -- a-member-only-rewrites-their-own-memory-check.sql, under verify-pg.sh's
  -- `rls` path — not this one.
  begin
    insert into public.family_facts (family_id, category, label, value, notes, source)
    values (fam, 'preference', 'Control fact', 'Control value', 'as written', 'ai_conversation')
    returning id into ctl;
  exception when others then
    ctl := null;
    control_ok := false;
    failures := array_append(failures, format('CONTROL FAILED: could not seed the control fact at all (%s: %s)', sqlstate, sqlerrm));
  end;

  if ctl is null then
    -- The handler above already spoke if the INSERT raised. This is the quiet
    -- way here: a row-vetoing BEFORE trigger (or INSTEAD NOTHING rule) makes
    -- RETURNING yield no row, `into ctl` is null, and nothing was raised. `id`
    -- is a NOT NULL primary key, so a stored row cannot get here — only an
    -- unstored one can. Without this branch the leg would be silently
    -- skipped, which is the failure mode the whole control exists to remove.
    if control_ok then
      control_ok := false;
      failures := array_append(failures, 'CONTROL FAILED: the control fact''s INSERT returned no row and raised nothing — a row-vetoing BEFORE trigger or rule is on this table — so the notes/source leg never ran');
    end if;
  else
    begin
      update public.family_facts
         set notes = 'edited by the control', source = 'ai_inferred'
       where id = ctl;
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, format('CONTROL FAILED: an UPDATE of notes AND source on a row this session just inserted changed %s rows, so §2''s "provenance survived the edit" would be a statement about a write that never landed', n));
      else
        select source, notes into ctl_src, ctl_notes from public.family_facts where id = ctl;
        if ctl_src is distinct from 'ai_inferred' or ctl_notes is distinct from 'edited by the control' then
          control_ok := false;
          failures := array_append(failures, format('CONTROL FAILED: after an UPDATE naming both columns the row reads source=%L notes=%L — provenance is not writable (or not readable) here, so §2 holds for a reason unrelated to notes and would not notice provenance being derived from notes again. If a migration has deliberately pinned `source`, rewrite this leg to the new rule; do not loosen the schema', ctl_src, ctl_notes));
        end if;
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: an UPDATE of notes AND source on this session''s own row raised %s: %s', sqlstate, sqlerrm));
    end;
  end if;

  -- Leg D — §4's live-facts count: the OTHER HALF of its bound. §4 stores a
  -- fact that expired YESTERDAY and requires the live count to be 2; this leg
  -- stores one that expires TOMORROW, in the same column list, and requires it
  -- (a) present, read back with the timestamp it was given — so nothing on the
  -- way in refuses or rewrites `expires_at` — and (b) counted live under §4's
  -- own predicate. The two rows bracket `expires_at > now()`: §4 shows a dated
  -- row can be excluded, this leg shows a dated row can be included, so the
  -- exclusion is the DATE's doing and not `expires_at is not null`'s. What
  -- this leg does NOT test, because here it cannot, is row visibility: the
  -- probe runs as `postgres` in one transaction, so a row it stored is a row
  -- it can see, and no policy stands between the INSERT and the count. The gap
  -- that remains — a row that was never stored is absent from a count exactly
  -- as an expired one is — is closed in §4 itself, which now requires the
  -- stale row to be PRESENT unfiltered before reading the live count.
  begin
    insert into public.family_facts (family_id, category, label, value, source, expires_at)
    values (fam, 'sizes', 'Coat size', 'Age 8', 'user', now() + interval '1 day')
    returning id into ctl_live;
    select count(*), bool_and(expires_at > now()) into n, ok
      from public.family_facts where id = ctl_live;
    if n <> 1 or not coalesce(ok, false) then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: a fact expiring TOMORROW is present as %s row(s) with expires_at in the future = %s — `expires_at` is being refused or rewritten on the way in, so §4''s exclusion of an expired row cannot be credited to the expiry filter', n, coalesce(ok::text, 'null')));
    end if;
    select count(*) into live
      from public.family_facts
     where family_id = fam and id = ctl_live and (expires_at is null or expires_at > now());
    if live <> 1 then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: a fact expiring TOMORROW came back as %s live rows under §4''s own predicate, so that predicate excludes dated rows regardless of their date and §4''s count of 2 does not show the expiry filter working', live));
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL FAILED: a fact expiring tomorrow could not be stored or counted (%s: %s)', sqlstate, sqlerrm));
  end;

  -- The control's rows do not outlive the control, and this is unconditional:
  -- a stray row in this family is quiet contamination that would turn one
  -- unattributed check into a false failure in §2's count of
  -- source = 'ai_conversation' rows and §4's count of live facts. Scoped to
  -- this probe's own anchor family, so it can reach nothing another probe
  -- seeded. The four legs invent no UUID of their own — every control row is
  -- captured with RETURNING, the way §1 already does — so nothing here can
  -- collide with another probe sharing the one database.
  delete from public.family_facts where family_id = fam;

  -- §2 expects exactly 1 `ai_conversation` row in this family and §4 exactly
  -- 2 live rows. Both counts ASSUME the family is empty at this line — Leg A
  -- alone seeded an 'ai_conversation' row — so the assumption is asserted here,
  -- where a narrowed DELETE would be the cause, rather than surfacing
  -- downstream as a 2 or a 3 with no reason at the failure site.
  select count(*) into n from public.family_facts where family_id = fam;
  if n <> 0 then
    raise exception 'the control''s clean-up left % row(s) in its anchor family; §2''s count of 1 ai_conversation row and §4''s count of 2 live rows both depend on this family being empty here', n;
  end if;

  -- A failed control makes every refusal below unreadable. The boundary is not
  -- reported as holding and not reported as broken: it is reported as UNPROVEN,
  -- naming the reason while it is still in hand, and the build is red either
  -- way.
  if not control_ok then
    raise exception 'family_facts provenance boundary UNPROVEN (the control this probe rests on did not hold): %', array_to_string(failures, ' | ');
  end if;

  -- ── 1. The backfill classifies what 0123 left behind ──────────────────────
  -- Two rows as they would have existed before this migration: one a person
  -- typed, one that came across from the playbook inbox carrying the marker.
  insert into public.family_facts (family_id, category, label, value, notes, source)
  values (fam, 'sizes', 'Shoe size', 'US 2', 'Measured at the shop', 'user')
  returning id into mine;
  insert into public.family_facts (family_id, category, label, value, notes, source)
  values (fam, 'preference', 'Hates mushrooms', 'Will not eat them', 'Learned by Bubaly — said so twice in one week', 'ai_conversation')
  returning id into theirs;

  -- ── 2. An edit no longer destroys provenance ──────────────────────────────
  -- This is the failure the column exists for. `rememberConfirmed` overwrites
  -- `notes` whenever a person restates a fact the household already holds, so
  -- under the old scheme the marker vanished and "clear what Bubaly learned"
  -- silently missed the row forever.
  update public.family_facts set notes = 'Actually she just does not like the texture' where id = theirs;
  select source into src from public.family_facts where id = theirs;
  if src <> 'ai_conversation' then
    raise exception 'an edit to notes changed provenance to %', src;
  end if;

  -- And the converse: a person writing the old marker into their OWN note does
  -- not hand their fact to Bubaly. Under `notes ilike ''Learned by Bubaly%''`
  -- this row was deleted by "Clear memories" along with the real ones.
  -- (Exactly 1 relies on the control having emptied this family above, which
  -- the control asserts of itself after its DELETE.)
  update public.family_facts set notes = 'Learned by Bubaly? No — I measured it myself' where id = mine;
  select count(*) into n from public.family_facts where family_id = fam and source = 'ai_conversation';
  if n <> 1 then
    raise exception 'clearing by provenance would have taken % rows, not 1', n;
  end if;

  -- ── 3. The vocabulary is closed ───────────────────────────────────────────
  begin
    insert into public.family_facts (family_id, category, label, value, source)
    values (fam, 'other', 'Bad source', 'x', 'whatever');
    raise exception 'family_facts accepted an unknown source';
  exception when check_violation then null;
  end;

  -- Confidence is the inbox's own 0..100 scale, so a value survives the move
  -- across unchanged, and null means nobody scored it — which is what a fact a
  -- person typed should say.
  begin
    insert into public.family_facts (family_id, category, label, value, confidence)
    values (fam, 'other', 'Impossible', 'x', 101);
    raise exception 'family_facts accepted a confidence above 100';
  exception when check_violation then null;
  end;
  select confidence is null into ok from public.family_facts where id = mine;
  if not ok then raise exception 'a fact a person typed was given a confidence score'; end if;

  -- ── 4. A fact can stop being true ─────────────────────────────────────────
  -- Nothing in 0123 could expire. A child's shoe size and a school year have a
  -- shelf life, and a stale fact steering a plan is worse than no fact,
  -- because it looks as certain as a fresh one.
  insert into public.family_facts (family_id, category, label, value, source, expires_at)
  values (fam, 'sizes', 'Coat size', 'Age 8', 'user', now() - interval '1 day')
  returning id into stale;

  -- The stale row has to be PRESENT for its absence from the live count to
  -- mean anything: a row-vetoing BEFORE trigger would leave `stale` null and
  -- the count at 2 for a reason that has nothing to do with expiry. Leg D
  -- proved a dated row CAN be stored; this proves this one WAS.
  select count(*) into n from public.family_facts where id = stale;
  if n <> 1 then
    raise exception 'the expired coat size is present as % rows, not 1 — it was never stored, so a live count of 2 would say nothing about expiry', n;
  end if;

  -- (Exactly 2 = mine + theirs: relies on the control having emptied this
  -- family above, which the control asserts of itself after its DELETE.)
  select count(*) into n
    from public.family_facts
   where family_id = fam and (expires_at is null or expires_at > now());
  if n <> 2 then
    raise exception 'live facts came back as % rows; the expired coat size is still being recalled', n;
  end if;

  -- ── 5. ATTRIBUTION, asserted out of the catalog ───────────────────────────
  -- The control and §3 together show that a 23514 is raised for 'whatever'
  -- and 101 and for nothing else on the row. They cannot show WHICH object
  -- raised it: a CHECK carrying 0265's predicate under a different name, or a
  -- BEFORE INSERT trigger doing `raise … using errcode = 'check_violation'`,
  -- passes every leg above and both refusals. The header credits 0265's two
  -- named constraints because its author read the migrations; this is what
  -- makes that credit self-verifying — 0265:52-55 queries pg_constraint for
  -- these same names, and 0357:147-186 proves its own policy out of pg_policy
  -- the same way. It runs AFTER the refusals on purpose: a LOOSENED guard must
  -- fail on the refusal it defeats (§3), a DECOY refuser on the control that
  -- trips over it, and only the third case — a same-predicate impostor —
  -- fails here.
  --
  -- (i) family_facts_source_check: a validated CHECK on public.family_facts,
  --     over `source`, admitting exactly the four members Leg A landed.
  select pg_get_constraintdef(oid), convalidated into def, ok
    from pg_constraint
   where conrelid = 'public.family_facts'::regclass
     and conname = 'family_facts_source_check' and contype = 'c';
  if def is null then
    raise exception 'ATTRIBUTION UNPROVEN: public.family_facts carries no CHECK constraint named family_facts_source_check — §3''s refusal of ''whatever'' held, but not for the reason this file names (0265:57-58)';
  end if;
  if not ok then
    raise exception 'ATTRIBUTION UNPROVEN: family_facts_source_check is NOT VALID, so rows already in the table were never checked against it: %', def;
  end if;
  if def !~ '\msource\M'
     or def !~ '''user''' or def !~ '''ai_conversation''' or def !~ '''ai_inferred''' or def !~ '''import'''
     or (select count(*) from regexp_matches(def, '''[^'']*''', 'g')) <> 4 then
    raise exception 'ATTRIBUTION UNPROVEN: family_facts_source_check no longer reads as `source in (user, ai_conversation, ai_inferred, import)` but as %, so the constraint under that name is not the one 0265:57-58 wrote', def;
  end if;

  -- (ii) family_facts_confidence_check: the same, over `confidence`, null or
  --      0..100 (pg_get_constraintdef renders BETWEEN as >= and <=).
  select pg_get_constraintdef(oid), convalidated into def, ok
    from pg_constraint
   where conrelid = 'public.family_facts'::regclass
     and conname = 'family_facts_confidence_check' and contype = 'c';
  if def is null then
    raise exception 'ATTRIBUTION UNPROVEN: public.family_facts carries no CHECK constraint named family_facts_confidence_check — §3''s refusal of 101 held, but not for the reason this file names (0265:69-70)';
  end if;
  if not ok then
    raise exception 'ATTRIBUTION UNPROVEN: family_facts_confidence_check is NOT VALID, so rows already in the table were never checked against it: %', def;
  end if;
  if def !~ '\mconfidence\M' or def !~* 'is null' or def !~ '>= 0' or def !~ '<= 100' then
    raise exception 'ATTRIBUTION UNPROVEN: family_facts_confidence_check no longer reads as `confidence is null or confidence between 0 and 100` but as %, so the constraint under that name is not the one 0265:69-70 wrote', def;
  end if;

  -- (iii) No trigger on public.family_facts beyond the one the header accounts
  --       for. A guard trigger refuses with the same 23514 the CHECKs raise,
  --       and a row-vetoing one lands zero rows without a word, so an unlisted
  --       trigger un-attributes every check above. Internal (FK) triggers are
  --       not counted. This is the census the header can only grep for; here it
  --       is read from the catalog every run.
  select string_agg(tgname, ', ' order by tgname) into stray
    from pg_trigger
   where tgrelid = 'public.family_facts'::regclass
     and not tgisinternal
     and tgname <> 'set_family_facts_updated';
  if stray is not null then
    raise exception 'ATTRIBUTION UNPROVEN: public.family_facts carries trigger(s) this probe does not account for (%) — read it, say why it cannot refuse or veto what the checks above measure, and list it, or the credit to 0265''s CHECKs does not hold', stray;
  end if;
  -- … and that one keeps the shape that keeps it inert here: BEFORE UPDATE FOR
  -- EACH ROW, running public.set_updated_at. tgtype bits: 1 = ROW, 2 = BEFORE,
  -- 4 = INSERT, 8 = DELETE, 16 = UPDATE — so `& 31 = 19` is "row, before,
  -- update, and NOT insert or delete": a trigger that never sees §3's INSERTs.
  -- Its behaviour on UPDATE is what Leg C measured (source moved, notes moved).
  select tgfoid = 'public.set_updated_at'::regproc
     and tgtype & 31 = 19
     and tgenabled in ('O', 'A')
    into ok
    from pg_trigger
   where tgrelid = 'public.family_facts'::regclass and tgname = 'set_family_facts_updated';
  if not coalesce(ok, false) then
    raise exception 'ATTRIBUTION UNPROVEN: set_family_facts_updated is missing, disabled, or no longer a BEFORE UPDATE FOR EACH ROW trigger running public.set_updated_at() (0123:29-31) — the header''s trigger inventory is stale, and a version that fires on INSERT is a candidate refuser of §3''s statements';
  end if;

  delete from public.family_facts where family_id = fam;
  delete from public.families where id = fam;
  raise notice 'family_facts provenance check passed (control held first: all four admitted sources and confidence 0/100 DO land in the exact statements the refusals are measured in, provenance moves when a statement names it, a fact expiring tomorrow is stored as given and counts as live; and the catalog names the mechanism: both CHECKs present under their 0265 names with their 0265 predicates, and no trigger on the table beyond 0123''s BEFORE UPDATE set_updated_at)';
end $$;
