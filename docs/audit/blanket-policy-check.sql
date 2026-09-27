-- ── A-16 Blanket-policy probe ───────────────────────────────────────────────
-- Every table has RLS enabled (A-03 asserts that). RLS with a policy whose
-- USING or WITH CHECK is literally `true` is RLS that permits everything, so
-- "RLS is on" is not by itself the property anyone cares about.
--
-- wallet-write-rls-check.sql already forbids a stray permissive write policy on
-- the MONEY tables. This asks the same question of all of them, because the next
-- blanket policy will not necessarily be written on a money table.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/blanket-policy-check.sql
--
-- Exit is non-zero (via RAISE EXCEPTION) if any invariant fails.

-- Reference data: catalogues with no family in them, deliberately readable by
-- everyone. Each is listed by name so that ADDING one is a decision someone
-- makes here, not a side effect of writing a policy somewhere — and the block
-- after the invariant holds this list to exactly these four names and to the
-- premise that none of them is family-scoped, so adding one is TWO edits, the
-- second of them an assertion a reviewer reads.
create temporary table blanket_allowlist (relname text primary key, why text);
insert into blanket_allowlist values
  ('badges',               'the badge catalogue — the same badges for every family'),
  ('feature_flags',        'flag names and states; read-only to authenticated, no family column'),
  ('meal_ideas',           'the seeded recipe catalogue, shared by every household'),
  ('service_descriptions', 'public marketing copy, served by the public /api/services/descriptions route');

-- ONE definition of the rule, used by the invariant and by the controls,
-- so they can never drift apart.
create or replace function pg_temp.blanket_policies()
returns table (relname text, polname text, cmd "char", roles text, expr text)
language sql as $fn$
  select c.relname::text,
         p.polname::text,
         p.polcmd,
         coalesce((select string_agg(r.rolname, ',' order by r.rolname)
                   from pg_roles r where r.oid = any(p.polroles)), 'PUBLIC'),
         coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' / '
           || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and (pg_get_expr(p.polqual, p.polrelid) = 'true'
      or pg_get_expr(p.polwithcheck, p.polrelid) = 'true')
    -- service_role bypasses RLS entirely, so a `true` policy naming only it
    -- grants nothing it did not already have.
    and not (not (0 = any(p.polroles))
             and not exists (select 1 from pg_roles r
                             where r.oid = any(p.polroles) and r.rolname <> 'service_role'))
    and c.relname not in (select relname from blanket_allowlist)
$fn$;

-- ── NEGATIVE CONTROL, and it runs FIRST, before the invariant ───────────────
-- The mechanism under test here is NOT RLS enforcement at runtime: nothing in
-- this file attempts a write, catches `insufficient_privilege` or counts
-- affected rows. It is a CATALOGUE assertion — `pg_temp.blanket_policies()` is
-- read against `pg_policy`, and the green line below is a COUNT OF ZERO. So the
-- thing that can be wrong is not a missing GRANT, a column denial or a guard
-- trigger; it is the DETECTOR. A count of zero means "no blanket policy outside
-- the allowlist" only if the detector would have counted one. If it would not,
-- zero means "the detector is blind", and those are not the same sentence.
--
-- The rule above has four arms — the USING half of the disjunction, the WITH
-- CHECK half, the role exemption's PUBLIC test and the role exemption's
-- quantifier — and each is a way this probe stays green while the class it
-- forbids walks straight in. Before this block existed the only control was the
-- self-test at the foot of this file, which plants ONE shape (`for select to
-- authenticated using (true)`), exercises ONE arm (the USING half), runs AFTER
-- the invariant has already printed its green line, and used to DECLINE with
-- `A-16 SKIP:` when calendar_events was absent — a skip that run-probes.sh's
-- PROBES_ALLOW_SKIP=1 turns into an exit of zero. So every arm gets a leg here,
-- ahead of the invariant, and no leg may decline:
--
--   1. THE ROLE EXEMPTION'S PUBLIC ARM. The clause above is a double negative
--      over `polroles`, and it is load-bearing RIGHT NOW: without it this probe
--      would fail on `service_role_all`, which
--      `0219_admin_tables_service_role_rls_lockdown.sql` left as
--      `to service_role using (true) with check (true)` on support_tickets and
--      admin_users. 0219 is the LAST migration to create a policy on either
--      table — `00101_support_tickets_admin_users.sql` (the migration 0219's own
--      header calls 0010) wrote the first as the PLA-0590 bug, with no `TO`
--      clause at all; 0219 dropped and re-created both under the same name WITH
--      the role clause; and nothing after it touches either table's policies, so
--      the rule being controlled is 0219's and not 00101's. `grep -l` for the
--      policy name across supabase/migrations returns those two files and 0219
--      is the last; the one catalogue-driven policy loop that could reach a
--      table it does not name — 0118, over every `family_id` table — skips any
--      table already carrying a SELECT or ALL policy, which 00101 gave
--      support_tickets before 0118 ran (0004 and 0034 loop only to ENABLE RLS
--      and write their policies over hard-coded lists naming neither table);
--      and pg_policy on a replay shows `service_role_all` as the ONLY policy on
--      either table. Now drop the `not (0 = any(polroles))` arm
--      and a policy with NO `TO` clause is exempted: polroles is `{0}`, no
--      pg_roles row has oid 0, so `not exists` answers true and the worst
--      blanket policy there is — one that reaches `anon` — is filed as harmless.
--      Nothing in this file would otherwise notice. That is not a hypothetical
--      shape either: `meal_ideas_select` (0139) carries no `TO` clause and is
--      PUBLIC in this schema today, and it is invisible to the failure because
--      the ALLOWLIST already drops it. So a broken PUBLIC arm changes not one
--      line of this probe's output, and the next `to public with check (true)`
--      on wallet_transactions — verbatim the worst case 0275's header says
--      wallet-write-rls-check injects — is reported as nothing at all. Leg 1
--      (`a16_ctl_public_blanket`, no TO clause) catches exactly this arm and
--      ONLY this arm: WIDENING the rolname exclusion instead (say `rolname not
--      in ('service_role','anon')`) cannot exempt a no-TO-clause policy, because
--      `{0}` already makes the first conjunct false whatever `not exists`
--      answers. Widening is leg 3's to catch, below.
--   2. THE `with check` DISJUNCT. This file's header claims "USING or WITH
--      CHECK is literally `true`", and the money-table probe it generalises is
--      about WRITES. A policy with `polqual` NULL and `with check (true)` is
--      matched only by the second half of that disjunction, and before leg 2
--      (`a16_ctl_withcheck_only`, `for insert … with check (true)`) no line in
--      this file had ever exercised it. Delete that half and every read-side
--      blanket policy is still caught, the foot self-test still passes green,
--      and a blanket INSERT policy is free.
--   3. A MIXED `TO` LIST, AND A WIDENED EXCLUSION. `to anon, service_role using
--      (true)` must be reported, because a non-service role is named. Written
--      with the quantifier the other way round — "ANY named role is
--      service_role" instead of "EVERY named role is" — the exemption swallows
--      it, and any blanket policy is smuggled past simply by adding service_role
--      to its TO list. The same leg (`a16_ctl_mixed_roles`) is what dies when
--      the exclusion is widened to a second name: with `rolname not in
--      ('service_role','anon')` its polroles `{anon, service_role}` has no
--      remaining named role, `not exists` answers true, and it is exempted.
--   4. THE `using` DISJUNCT ON ITS OWN. Legs 1, 3 and 4 all carry `with check
--      (true)` as well as `using (true)`, and leg 2 is with-check-only by
--      design, so deleting `pg_get_expr(p.polqual, …) = 'true'` from the rule
--      leaves every one of them matching through polwithcheck. The half of the
--      disjunction this file's header leads with would then have no control
--      ahead of the invariant at all — its only witness would be the foot
--      self-test, after the green line, and formerly skippable. Leg 5
--      (`a16_ctl_using_only`, `for select to authenticated using (true)`,
--      polwithcheck NULL) is that witness, moved to where it is load-bearing.
--
-- So the control is the same detector, the same catalogue and the same
-- `true`-bodied policy, with THE ONE THING THE RULE KEYS ON changed each time,
-- and each of legs 1, 2, 3 and 5 MUST BE REPORTED. That is the catalogue-probe
-- form of "the same actor through the same predicate with the answer the other
-- way, and it must land": for a detector, landing is being counted.
--
-- Leg 4 is the exemption's width the other way, and it is recorded rather than
-- defended: 0219's own shape, `to service_role`, must NOT be reported, so that
-- a future red cannot be turned green by widening the exemption instead of
-- dropping the offending policy. If someone decides service_role `true`
-- policies should be flagged after all, this leg fails and that decision gets
-- revisited on purpose — the same bargain child-login's open-read line makes.
-- It is a scope note, not an independent detection: remove the exemption
-- outright and the invariant below already fails on `service_role_all` on
-- support_tickets and admin_users, and the only state in which leg 4 fires
-- while the invariant would not — support_tickets allowlisted AND the
-- exemption gone — is one legs 1, 3 and 5 already fail in. What leg 4 buys is
-- the message: its red names the exemption as the thing that moved, where the
-- invariant's red would only list `service_role_all` and leave the reader to
-- work out why a policy 0219 wrote deliberately is suddenly a hole.
--
-- It plants on support_tickets, the table the exemption exists FOR, so the
-- control is anchored to the live exemption rather than to a table picked for
-- convenience. Two consequences worth having: legs 1-3 and 5 also fail if
-- someone quiets a future red by adding support_tickets to `blanket_allowlist`,
-- since the detector drops allowlisted tables before it reports — though ONLY
-- for support_tickets, which is the one table nobody needs to allowlist because
-- the exemption already covers its only `true` policy; allowlisting any OTHER
-- table leaves every leg green, and that loosening is the allowlist assertion's
-- to catch, after the invariant. And the control never drops or alters
-- `service_role_all` — every leg is an addition under its own name, checked,
-- dropped, and the whole thing rolled back besides.
--
-- No rows and no UUIDs: this control is pure catalogue, so it cannot collide
-- with anything the other probes in this directory seed into the shared
-- database, and the five policy names appear nowhere else in the corpus.
--
-- What no leg controls, and why the header says "literally": the rule matches
-- the deparsed text `true` and nothing else, so `using (1 = 1)` or `using (true
-- and true)` — which pg_get_expr renders as `(1 = 1)` and `(true AND true)` —
-- is not this probe's class and would need a different detector. polpermissive
-- is not consulted, so a RESTRICTIVE `using (true)` (a no-op, since restrictive
-- policies AND with the permissive union) would be reported as a hole: a false
-- red, never a false green, and no such policy exists on a replay today. And
-- polcmd is not in the predicate at all, so whether a blanket policy is `for
-- select`, `for insert`, `for update`, `for delete` or `for all` cannot change
-- whether it is seen — there is no command-shaped arm to control.
--
-- It cannot precede the allowlist and the function, because those are the two
-- things it interrogates; it precedes everything that ASSERTS. An absent
-- support_tickets RAISES rather than declining quietly: 0219 runs `alter table
-- public.support_tickets enable row level security` unguarded, and 0203 grants
-- `to anon, authenticated` unguarded, so if either the table or the three roles
-- this control names were missing the replay would already have failed — and
-- the invariant below would then be unattributed rather than fairly declined.
-- The foot self-test now says the same about calendar_events, so the two halves
-- of this file agree about an absent table, and PROBES_ALLOW_SKIP=1 has no arm
-- of the rule left to excuse.
begin;
do $$
declare
  n int;
  failures text[] := '{}';
begin
  if to_regclass('public.support_tickets') is null then
    raise exception 'A-16 UNPROVEN: public.support_tickets is absent, so the detector cannot be shown to see anything; 0219 enables RLS on that table unguarded, so its absence means this database is not the migration replay this probe assumes';
  end if;

  -- 1. No TO clause at all: polroles = {0}, which is PUBLIC and reaches anon.
  begin
    execute 'create policy a16_ctl_public_blanket on public.support_tickets using (true) with check (true)';
    select count(*) into n from pg_temp.blanket_policies() where polname = 'a16_ctl_public_blanket';
    if n <> 1 then
      failures := array_append(failures, 'CONTROL FAILED: a PUBLIC (no TO clause) `using (true) with check (true)` policy was NOT reported — the role exemption''s PUBLIC arm is gone, so the zero count below says nothing whatever about a blanket policy granted to anon');
    end if;
    execute 'drop policy a16_ctl_public_blanket on public.support_tickets';
  exception when others then
    failures := array_append(failures, format('CONTROL FAILED: the PUBLIC blanket leg could not be planted (%s: %s), so the detector was never asked the question', sqlstate, sqlerrm));
  end;

  -- 2. The WITH CHECK half of the disjunction on its own: polqual is NULL here,
  --    so only `pg_get_expr(polwithcheck, …) = 'true'` can match this row.
  begin
    execute 'create policy a16_ctl_withcheck_only on public.support_tickets for insert to authenticated with check (true)';
    select count(*) into n from pg_temp.blanket_policies() where polname = 'a16_ctl_withcheck_only';
    if n <> 1 then
      failures := array_append(failures, 'CONTROL FAILED: a blanket INSERT policy (`with check (true)`, no USING) was NOT reported — this probe only sees the read half, and its header''s claim to cover WITH CHECK is false');
    end if;
    execute 'drop policy a16_ctl_withcheck_only on public.support_tickets';
  exception when others then
    failures := array_append(failures, format('CONTROL FAILED: the WITH CHECK leg could not be planted (%s: %s), so the detector was never asked the question', sqlstate, sqlerrm));
  end;

  -- 3. service_role named ALONGSIDE a real role. Exempting this would let any
  --    blanket policy through on the strength of one extra name in its TO list,
  --    and it is also the leg that dies if the rolname exclusion is widened.
  begin
    execute 'create policy a16_ctl_mixed_roles on public.support_tickets to anon, service_role using (true) with check (true)';
    select count(*) into n from pg_temp.blanket_policies() where polname = 'a16_ctl_mixed_roles';
    if n <> 1 then
      failures := array_append(failures, 'CONTROL FAILED: a `to anon, service_role using (true)` policy was NOT reported — either the exemption tests whether ANY named role is service_role rather than whether EVERY one is, or its exclusion has been widened past service_role; either way a blanket policy is smuggled past by naming a second role');
    end if;
    execute 'drop policy a16_ctl_mixed_roles on public.support_tickets';
  exception when others then
    failures := array_append(failures, format('CONTROL FAILED: the mixed-roles leg could not be planted (%s: %s), so the detector was never asked the question', sqlstate, sqlerrm));
  end;

  -- 4. The exemption's width, recorded rather than defended: 0219's own shape
  --    must stay exempt, so that widening the exemption is never the way a red
  --    line gets made green.
  begin
    execute 'create policy a16_ctl_service_only on public.support_tickets to service_role using (true) with check (true)';
    select count(*) into n from pg_temp.blanket_policies() where polname = 'a16_ctl_service_only';
    if n <> 0 then
      failures := array_append(failures, 'CONTROL FAILED: a `to service_role`-only `true` policy WAS reported — that is 0219''s own shape on this very table, so the invariant below is now failing on a policy this file deliberately exempts; if service_role blanket policies should be flagged after all, say so here and in the allowlist rather than leaving the two disagreeing');
    end if;
    execute 'drop policy a16_ctl_service_only on public.support_tickets';
  exception when others then
    failures := array_append(failures, format('CONTROL FAILED: the service_role-only leg could not be planted (%s: %s), so the exemption''s width was never measured', sqlstate, sqlerrm));
  end;

  -- 5. The USING half of the disjunction on its own: polwithcheck is NULL here,
  --    so only `pg_get_expr(polqual, …) = 'true'` can match this row. Every
  --    other reported leg also carries `with check (true)` and would survive
  --    the loss of this half; this one does not.
  begin
    execute 'create policy a16_ctl_using_only on public.support_tickets for select to authenticated using (true)';
    select count(*) into n from pg_temp.blanket_policies() where polname = 'a16_ctl_using_only';
    if n <> 1 then
      failures := array_append(failures, 'CONTROL FAILED: a blanket SELECT policy (`using (true)`, no WITH CHECK) was NOT reported — the USING half of the disjunction is gone, so every read-side blanket policy in this schema is now invisible to the zero count below');
    end if;
    execute 'drop policy a16_ctl_using_only on public.support_tickets';
  exception when others then
    failures := array_append(failures, format('CONTROL FAILED: the USING-only leg could not be planted (%s: %s), so the detector was never asked the question', sqlstate, sqlerrm));
  end;

  -- A failed control makes the zero count below unreadable. The boundary is not
  -- reported as holding and it is not reported as broken: it is reported as
  -- unproven, and the build is red either way.
  if array_length(failures, 1) is not null then
    raise exception 'A-16 blanket-policy invariant UNPROVEN (the detector this probe rests on did not see what it claims to see): %', array_to_string(failures, ' | ');
  end if;
  raise notice 'A-16 OK: the detector reports a PUBLIC blanket policy, a WITH-CHECK-only one, a USING-only one and a mixed to-anon,service_role one, and exempts service_role alone — so the zero count below is a statement about policies, not about a blind query';
end $$;
rollback;

-- The control planted five policies on a live table; none of them may outlive
-- it, because run-probes.sh runs every probe in this directory against ONE
-- database in sequence and a stray `using (true)` on support_tickets would fail
-- THIS invariant on the next run and every metadata audit after it. As the
-- file stands this count is structurally zero — each leg drops its own policy,
-- a leg that raises has its sub-block's CREATE rolled back with it, and the
-- `rollback` above undoes the lot — so this is a tripwire for the edit that
-- turns that `rollback` into a `commit` or moves a leg outside the
-- transaction, the same tripwire the foot of the file keeps for the self-test.
do $$
declare n int; detail text;
begin
  select count(*), string_agg(polname::text, ', ') into n, detail
  from pg_policy
  where polname in ('a16_ctl_public_blanket','a16_ctl_withcheck_only',
                    'a16_ctl_mixed_roles','a16_ctl_service_only','a16_ctl_using_only');
  if n <> 0 then
    raise exception 'A-16 FAIL: control policy(ies) survived the rollback: %', detail;
  end if;
  raise notice 'A-16 OK: the control planted nothing that outlived it';
end $$;

-- ── Invariant: no blanket policy outside the allowlist ──────────────────────
do $$
declare n int; detail text;
begin
  select count(*), string_agg(format('%s.%s (%s) %s', relname, polname, roles, expr), E'\n  ')
    into n, detail from pg_temp.blanket_policies();
  if n > 0 then
    raise exception 'A-16 FAIL: % policy(ies) permit every row to a non-service role:%  %',
      n, E'\n  ', detail;
  end if;
  raise notice 'A-16 OK: no table outside the reference-data allowlist has an unconditional policy';
end $$;

-- ── The allowlist is held to its four names and to its premise ──────────────
-- The allowlist is the cheapest loosening in this file: one line exempts any
-- table, and every leg of the control stays green unless that table is
-- support_tickets. So the allowlist is pinned two ways. By NAME — exactly the
-- four the top of the file lists, so that adding a fifth is two edits here, the
-- second of them this assertion — and by PREMISE: the header calls these
-- "catalogues with no family in them", so none may carry a `family_id` column
-- or a foreign key to public.families. Allowlisting wallet_transactions fails
-- the second even after someone has updated the first.
do $$
declare n int; extra int; detail text; scoped text;
begin
  select count(*),
         count(*) filter (where relname not in ('badges','feature_flags','meal_ideas','service_descriptions')),
         string_agg(relname, ', ' order by relname)
    into n, extra, detail
  from blanket_allowlist;
  if n <> 4 or extra <> 0 then
    raise exception 'A-16 FAIL: blanket_allowlist is not the four reference catalogues this file names (badges, feature_flags, meal_ideas, service_descriptions); it holds: % — an exemption was added or removed without the decision being recorded in this assertion', detail;
  end if;

  select string_agg(c.relname::text, ', ' order by c.relname) into scoped
  from blanket_allowlist a
  join pg_class c on c.relname = a.relname
  join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'public'
  where exists (select 1 from pg_attribute att
                where att.attrelid = c.oid and att.attnum > 0 and not att.attisdropped
                  and att.attname = 'family_id')
     or exists (select 1 from pg_constraint k
                where k.conrelid = c.oid and k.contype = 'f'
                  and k.confrelid = to_regclass('public.families'));
  if scoped is not null then
    raise exception 'A-16 FAIL: allowlisted table(s) % carry a family_id column or a foreign key to families — that is a family-scoped table, not a reference catalogue, and a blanket policy on it is exactly what this probe exists to report', scoped;
  end if;

  select count(*) into n from blanket_allowlist a
  join pg_class c on c.relname = a.relname
  join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'public';
  raise notice 'A-16 OK: % of the 4 allowlisted reference table(s) exist, none family-scoped, each named with a reason', n;
end $$;

-- ── The probe detects the state it forbids, on a SECOND table ───────────────
-- Leg 5 of the control already proves this shape (`for select to authenticated
-- using (true)`) is seen, ahead of the invariant. This plants it on a
-- family-scoped table whose other policies are real `is_family_member` ones, so
-- the detector is shown to pick a blanket policy out from BESIDE genuine ones
-- and not only on the exemption's own table. It used to decline with `A-16
-- SKIP:` when calendar_events was absent; it now RAISES, for the reason the
-- control gives about support_tickets — 0002_tables.sql creates calendar_events
-- as part of the core schema, so its absence means this is not the replay — and
-- because a declined self-test under PROBES_ALLOW_SKIP=1 was the one path left
-- on which this file exited zero with an arm of its rule unexercised.
begin;
do $$
declare n int;
begin
  if to_regclass('public.calendar_events') is null then
    raise exception 'A-16 UNPROVEN: public.calendar_events is absent, so the detector cannot be shown to see a blanket policy beside real ones; 0002_tables.sql creates that table, so its absence means this database is not the migration replay this probe assumes';
  end if;
  execute 'create policy a16_planted_blanket on public.calendar_events for select to authenticated using (true)';
  select count(*) into n from pg_temp.blanket_policies() where polname = 'a16_planted_blanket';
  if n <> 1 then
    raise exception 'A-16 FAIL: a planted blanket policy was NOT detected — this probe proves nothing';
  end if;
  raise notice 'A-16 OK: a planted blanket policy on calendar_events was detected — not decoration';
end $$;
rollback;

-- And it is really gone, so the probe leaves no trace.
do $$
declare n int;
begin
  select count(*) into n from pg_policy where polname = 'a16_planted_blanket';
  if n <> 0 then
    raise exception 'A-16 FAIL: the planted policy survived the rollback';
  end if;
  raise notice 'A-16 OK: the planted policy was rolled back';
end $$;
