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
-- 0265_family_facts_provenance.sql:51-72, and grepping BOTH names across
-- supabase/migrations returns that one file — nothing later drops, alters or
-- re-creates either, so 0265 is the GOVERNING migration and not merely the
-- first one to mention the columns.
--
-- RLS is not what refuses here even though 0264_ai_surface_role_privacy.sql
-- owns this table's four policies: verify-pg.sh runs every probe as `postgres`,
-- which bypasses both row-level security and table GRANTs, so no policy and no
-- missing privilege is in the path. Nor is a trigger: the ONLY trigger on
-- public.family_facts is `set_family_facts_updated` (0123:29-31), running
-- public.set_updated_at (0003:42-47), whose whole body is
-- `new.updated_at = now(); return new;` — it rejects nothing and touches no
-- column this probe reads. 0003:86-98 attaches that function to every table
-- carrying an `updated_at`, but it runs BEFORE 0123 creates this one, and every
-- later loop of that shape (0018, 0034, 0036, 0037, 0113, 0114, 0115, 0120,
-- 0151, 0237, 0250, 0282, 0284) is scoped to its own table list, or in 0034's
-- case to names beginning "social_". So nothing dynamic reaches family_facts
-- either.
--
-- So the mechanism keys on ONE COLUMN'S VALUE, and the control is that value
-- turned the other way: the same session running the same statement with an
-- ADMITTED value, which must land. The legs are at the top of the block below,
-- with what each one would catch.
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
        failures := array_append(failures, format('CONTROL FAILED: source=%L, an ADMITTED member of 0265''s vocabulary, stored %s rows in the exact statement §3 expects ''whatever'' to be refused in', s, n));
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
        failures := array_append(failures, format('CONTROL FAILED: confidence=%s, an ADMITTED value, stored %s rows in the exact statement §3 expects 101 to be refused in', conf, n));
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
    -- The handler above already spoke if the INSERT raised. This catches the
    -- other way to get here — an INSERT that returned no row at all — so the
    -- leg cannot be skipped silently, which is the failure mode the whole
    -- control exists to remove.
    if control_ok then
      control_ok := false;
      failures := array_append(failures, 'CONTROL FAILED: the control fact''s INSERT returned no row, so the notes/source leg never ran');
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
          failures := array_append(failures, format('CONTROL FAILED: after an UPDATE naming both columns the row reads source=%L notes=%L — provenance is not writable (or not readable) here, so §2 holds for a reason unrelated to notes and would not notice provenance being derived from notes again', ctl_src, ctl_notes));
        end if;
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: an UPDATE of notes AND source on this session''s own row raised %s: %s', sqlstate, sqlerrm));
    end;
  end if;

  -- Leg D — §4's live-facts count, for the same zero-row reason. A row this
  -- session cannot see is absent from that count exactly as readily as an
  -- expired one, so the count alone does not show the expiry filter working.
  -- Same predicate, `expires_at` the other way round: a fact that expires
  -- TOMORROW must be counted live.
  begin
    insert into public.family_facts (family_id, category, label, value, source, expires_at)
    values (fam, 'sizes', 'Coat size', 'Age 8', 'user', now() + interval '1 day')
    returning id into ctl_live;
    select count(*) into live
      from public.family_facts
     where family_id = fam and id = ctl_live and (expires_at is null or expires_at > now());
    if live <> 1 then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: a fact expiring TOMORROW came back as %s live rows under §4''s own predicate, so §4''s count of 2 would not distinguish an expiry filter that works from a row that cannot be seen', live));
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

  select count(*) into n
    from public.family_facts
   where family_id = fam and (expires_at is null or expires_at > now());
  if n <> 2 then
    raise exception 'live facts came back as % rows; the expired coat size is still being recalled', n;
  end if;

  delete from public.family_facts where family_id = fam;
  delete from public.families where id = fam;
  raise notice 'family_facts provenance check passed (control held first: all four admitted sources and confidence 0/100 DO land in the exact statements the refusals are measured in, provenance moves when a statement names it, and a fact expiring tomorrow counts as live)';
end $$;
