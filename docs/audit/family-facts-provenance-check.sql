-- Behavioural proof for 0265: a memory says where it came from, and an edit
-- cannot take that away.
--
-- The scheme this replaces put provenance in the `notes` text column: an
-- inferred fact's notes began "Learned by Bubaly". Two things broke, and both
-- are asserted below against a real Postgres.
do $$
declare
  fam    uuid := 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  mine   uuid; theirs uuid; stale uuid;
  src    text;
  n      int;
  ok     boolean;
begin
  insert into public.families (id, name) values (fam, 'Provenance') on conflict do nothing;
  delete from public.family_facts where family_id = fam;

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
  raise notice 'family_facts provenance check passed';
end $$;
