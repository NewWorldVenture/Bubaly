-- Bubaly :: 0319 - a driving score is not the driver's to grade
-- ----------------------------------------------------------------------------
-- Raised by Claude-3, verified still open on a full replay.
--
-- `driving_trips` and `driver_licenses` are the two tables of one feature, added
-- together by 0114. They do not carry the same rule:
--
--   driver_licenses_{select,insert,update,delete}
--     is_family_member(family_id) and (can_manage_family(family_id)
--                                      or is_self_member(member_id))
--   driving_trips_{select,insert,update,delete}
--     is_family_member(family_id)
--
-- `driving_trips` is the telemetry — hard brakes, rapid accelerations, max mph,
-- phone-use seconds, and the 0-100 `score` a parent reads before deciding about
-- car keys or an insurance discount. Under plain membership the teenager the
-- report is ABOUT can rewrite it. Measured as a real child session on a trip a
-- parent recorded (score 41, 78 mph, 5 hard brakes, 240s phone use):
--
--   update driving_trips set score = 100  ->  UPDATE 1
--   delete from driving_trips             ->  DELETE 1
--
-- components/family/driving-safety-view.tsx is a client component writing with
-- the anon key, so RLS is the whole boundary; there is no server action and no
-- route in front of it.

-- ── UPDATE: managers only ────────────────────────────────────────────────────
-- Nothing in the product updates a trip. The view does exactly three things:
-- selects (:30), inserts (:115) and deletes (:40). So this policy is reachable
-- only by a hand-made PostgREST call, which is precisely the threat, and
-- narrowing it costs no rendered control anywhere.
--
-- Manager-only rather than `driver_licenses`' self-or-manager clause, and the
-- difference is the point: a licence is a record you KEEP about yourself — its
-- number, its expiry — and maintaining it is your job. A trip is a record OF
-- you. 0323 drew the same line across the health tables: a log you keep about
-- yourself may be corrected by its subject; a record of fact about someone may
-- not be rewritten by that someone.
drop policy if exists driving_trips_update on public.driving_trips;
create policy driving_trips_update on public.driving_trips
  for update to authenticated
  using (
    public.is_family_member(family_id)
    and public.can_manage_family(family_id)
  )
  with check (
    public.is_family_member(family_id)
    and public.can_manage_family(family_id)
  );

-- Symmetric WITH CHECK, deliberately. Postgres reuses a missing one from USING,
-- which is 0327's lesson; stating it means the row a manager turns the trip INTO
-- is checked as well as the row they reached for.

-- ── DELETE: managers, or whoever logged it ───────────────────────────────────
-- NOT managers-only, and the reason is the same one 0312 recorded when it left
-- immunizations alone: the view offers Delete to every member with no role gate
-- of any kind, so a manager-only rule would leave a UI whose primary control
-- fails for most of the household.
--
-- `created_by` is what separates the two cases. A trip you logged is an entry
-- you made and may withdraw — a mistyped distance, the wrong driver picked from
-- the dropdown. A trip a PARENT logged about you is their record, and erasing it
-- is the same act as regrading it. That distinction is the one 0324 and 0315
-- landed on for authorship, and `driving-safety-view.tsx:115` already writes
-- `created_by: userId` on every insert.
--
-- Legacy rows with a null `created_by` fall to managers only, which is the safe
-- direction.
drop policy if exists driving_trips_delete on public.driving_trips;
create policy driving_trips_delete on public.driving_trips
  for delete to authenticated
  using (
    public.is_family_member(family_id)
    and (
      public.can_manage_family(family_id)
      or created_by = auth.uid()
    )
  );

-- ── Left alone, so the omissions read as decisions ───────────────────────────
--
--   INSERT   stays `is_family_member`. The log-trip form picks the DRIVER from a
--            dropdown of the whole roster (driving-safety-view.tsx:132), so one
--            member logging a trip for another is the designed behaviour, not a
--            hole — a parent logs the teen's drive. Pinning `member_id` to self
--            here, the shape 0315 needed for journals, would break the feature.
--            That a member can log a FAKE trip for someone else is real and is
--            filed rather than guessed at: it needs a product answer about who
--            may log for whom, not a policy edit.
--
--   SELECT   stays family-wide. `driver_licenses` is narrower (self-or-manager)
--            because a licence number is PII; a trip score is the artifact the
--            household discusses. Narrowing it is a household policy question.

-- ── Sweep by shape ───────────────────────────────────────────────────────────
-- Permissive policies are OR'd, so one leftover PERMISSIVE write policy on this
-- table puts the score back within the driver's reach. Checked by shape rather
-- than by the names 0114 used.
--
-- Restrictive policies are deliberately excluded: they AND with the permissive
-- union and can only narrow, so one here is somebody else's tightening rather
-- than a hole. main is adding exactly those across the schema (0310's
-- `*_manager_*_guard` idiom), and a sweep that counted them would refuse to
-- apply over a change that makes this table stricter.
do $$
declare
  stray text;
begin
  select string_agg(format('%s [%s]', polname, polcmd), ', ' order by polname)
    into stray
  from pg_policy
  where polrelid = 'public.driving_trips'::regclass
    and polcmd in ('w', 'd', '*')
    and polpermissive
    and polname not in ('driving_trips_update', 'driving_trips_delete');

  if stray is not null then
    raise exception
      'driving_trips still carries another write policy, which ORs the narrowing away: %',
      stray;
  end if;

  raise notice '0319 OK: the score is a manager''s to change, and a trip is erasable only by its author';
end $$;
