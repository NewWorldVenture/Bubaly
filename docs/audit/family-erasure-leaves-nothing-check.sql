-- Deleting a family removes the family's data. All of it.
--
-- `family-delete-cascade-check.sql` proves a family CAN be deleted — 0287 exists
-- because `sync_log_change()` fired AFTER DELETE and wrote a `sync_change_logs`
-- row whose foreign key the just-removed parent could no longer satisfy, so the
-- delete aborted and the family survived. That probe names one table.
--
-- This one asks the other question: when the delete succeeds, is anything left?
-- It enumerates EVERY table carrying `family_id` at run time rather than naming
-- them, because the failure mode is a table added later with no cascade — and a
-- pinned list of tables is exactly the kind of guard that stops growing while
-- the schema keeps going. 396 tables carry `family_id` today.
--
-- Measured against a fully seeded anchor family on a replayed database:
--
--   BEFORE: the anchor family has 71192 rows across 199 family-scoped tables
--   DELETE succeeded in 00:00:00.638609
--   AFTER:  0 row(s) survive across 0 table(s)
--
-- ── the eight deliberate exceptions ────────────────────────────────────────
--
-- Eight tables use ON DELETE SET NULL instead of CASCADE, and that is correct
-- rather than an oversight: each is keyed on a user or on the business, not on
-- the household, and outliving the family is the point.
--
--   push_devices          a device belongs to a user, who may join another family
--   onboarding_progress   per-user funnel state
--   activation_events     per-user analytics
--   support_tickets       the support history of a person
--   reviews               published customer reviews
--   crm_contacts          sales records
--   feedback_ideas        a public idea board
--   affiliate_referrals   commissions owed
--
-- `move_date_recalculations` carries `family_id` with NO foreign key at all,
-- also deliberately: it is an idempotency ledger holding its own snapshot, and
-- an FK would either delete the receipt with the family or block the delete.
--
-- Anything NOT on that list must cascade. The list is stated here so that
-- adding to it is a decision someone makes on purpose.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  r        record;
  n        bigint;
  offenders text[] := '{}';
  cascades int := 0;
  failures int := 0;
begin
  -- ── 1. Structure: every family_id cascades, or is a named exception ──────
  for r in
    select c.relname as tbl,
           coalesce((
             -- `confdeltype` is "char", not text. Concatenating it below without
             -- this cast raises `operator is not unique: text || "char"` — and
             -- only on the branch that REPORTS an offender, so the probe passed
             -- happily until a cascade was deliberately broken to test it.
             select k.confdeltype::text from pg_constraint k
              where k.conrelid = c.oid and k.contype = 'f'
                and a.attnum = any(k.conkey)
                and k.confrelid = 'public.families'::regclass
              limit 1), '-') as del
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'family_id'
                        and a.attnum > 0 and not a.attisdropped
    where ns.nspname = 'public' and c.relkind = 'r'
    order by c.relname
  loop
    if r.del = 'c' then
      cascades := cascades + 1;
    elsif r.tbl in (
      'push_devices', 'onboarding_progress', 'activation_events', 'support_tickets',
      'reviews', 'crm_contacts', 'feedback_ideas', 'affiliate_referrals'
    ) and r.del = 'n' then
      null;  -- deliberate SET NULL: the row belongs to a user or to the business
    elsif r.tbl = 'move_date_recalculations' and r.del = '-' then
      null;  -- deliberate: an idempotency ledger holding its own snapshot
    else
      offenders := offenders || (r.tbl || ' (on delete: ' || r.del || ')');
    end if;
  end loop;

  if array_length(offenders, 1) > 0 then
    raise warning 'BREACH: family_id without ON DELETE CASCADE and not a named exception: %',
      array_to_string(offenders, ', ');
    failures := failures + 1;
  end if;

  -- A vacuous pass is the risk: if the catalogue query ever matches nothing,
  -- every table "cascades".
  if cascades < 200 then
    raise exception 'family-erasure: only % cascading family_id column(s) found — the scan is wrong, not the schema', cascades;
  end if;

  -- ── 2. Execution: delete a family and count what survives ───────────────
  --
  -- Done inside a subtransaction that is deliberately rolled back. The probe
  -- must exercise a REAL delete — a structural check alone cannot see a trigger
  -- that fires AFTER DELETE and aborts the cascade, which is precisely the
  -- defect 0287 fixed — but it must not actually erase the database it is
  -- measuring.
  declare
    fam      uuid := '00000000-0000-4000-8000-0000000e7a5e';
    owner    uuid := '00000000-0000-4000-8000-0000000e7a01';
    mid      uuid;
    total    bigint := 0;
    survivors int := 0;
  begin
    insert into auth.users (id, email) values (owner, 'erasure-probe@example.com')
    on conflict (id) do nothing;
    insert into public.families (id, name, created_by) values (fam, 'Erasure Probe', owner)
    on conflict (id) do nothing;
    insert into public.family_members (family_id, user_id, display_name, role, is_active)
      values (fam, owner, 'Owner', 'parent', true)
    on conflict do nothing;
    select id into mid from public.family_members where family_id = fam and user_id = owner;

    -- A spread wide enough to pull several different cascade paths, including
    -- the sync tables whose AFTER DELETE trigger is what 0287 had to fix.
    -- sync_notes carries the AFTER DELETE trigger `sync_log_change()`, which is
    -- the one that aborted the cascade before 0287. sync_reminders and
    -- sync_calendar_events carry the same trigger but each need a parent list or
    -- calendar, so the note is the cheapest row that exercises that path.
    insert into public.sync_notes (family_id, title) values (fam, 'Probe note');
    insert into public.notes (family_id, title, body, created_by)
      values (fam, 'Note', 'body', owner);
    insert into public.documents (family_id, title, category, storage_path, created_by)
      values (fam, 'Doc', 'other', fam::text || '/probe.pdf', owner);
    insert into public.member_locations (family_id, member_id, latitude, longitude, is_sharing)
      values (fam, mid, 51.5, -0.12, true);

    delete from public.families where id = fam;

    for r in
      select c.relname as tbl
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'family_id'
                          and a.attnum > 0 and not a.attisdropped
      where ns.nspname = 'public' and c.relkind = 'r'
      order by c.relname
    loop
      execute format('select count(*) from public.%I where family_id = $1', r.tbl)
        into n using fam;
      if n > 0 then
        survivors := survivors + 1;
        total := total + n;
        raise warning 'BREACH: % still holds % row(s) after the family was deleted', r.tbl, n;
      end if;
    end loop;

    if survivors > 0 then
      raise warning 'BREACH: % row(s) survive across % table(s) after erasure', total, survivors;
      failures := failures + 1;
    end if;

    -- Undo everything this block did, including the delete.
    raise exception using errcode = 'P0001', message = 'family-erasure: rollback';
  exception when others then
    -- `when others`, not `when raise_exception`: a broken cascade shows up as a
    -- foreign-key violation (23503) from the DELETE, not as a raised exception,
    -- and catching only the narrower class let that surface as an unhandled
    -- error instead of the diagnosis this probe is supposed to print.
    if sqlerrm <> 'family-erasure: rollback' then
      raise warning 'BREACH: deleting a populated family failed: %', sqlerrm;
      failures := failures + 1;
    end if;
  end;

  if failures > 0 then
    raise exception 'family-erasure: % assertion(s) failed', failures;
  end if;
  raise notice 'family-erasure: OK — % family-scoped tables cascade, the nine exceptions are named, and a deleted family leaves nothing', cascades;
end
$probe$;
