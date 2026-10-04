-- A babysitter payment names only its own family's babysitter and event (0472).
--
-- Two halves.
--
-- STATIC. One session, one rolled-back transaction, judged on row counts: as a
-- parent of family A, a payment may name A's babysitter and A's event, and not
-- B's, whether written fresh or re-pointed. A reference to nothing is the
-- foreign key's error, not this guard's. As a manager of BOTH families, a
-- babysitter or event that A's payments name cannot be moved to B, a payment
-- filed in B cannot name A's babysitter, and A's payment cannot be moved to B:
-- the rule is about the rows, not the caller's rights. Still allowed: a
-- payment naming no babysitter, one naming A's archived babysitter, and
-- deleting a paid babysitter (ON DELETE SET NULL keeps the payment). Then,
-- still inside the same transaction, the guards are disabled and every refused
-- write (fresh, re-pointed, moved) is repeated by the same caller and must
-- land on exactly one row, or its refusal above was not the guards' doing.
--
-- RACES. What the server action could not close (#701): the reference is read,
-- Trust is awaited, and only then is the payment written. Two real sessions,
-- opened with dblink, interleave a payment and a move of the row it names:
--
--   move-first     the mover has moved the parent to B and not committed; the
--                  payer then files A's payment naming it. The payer must wait
--                  for the mover and then be refused, because its FOR SHARE
--                  read re-reads the moved row.
--   payment-first  the payer has filed A's payment and not committed; the mover
--                  then moves the parent to B. The mover must wait for the payer
--                  and then be refused, because the parent-side guard now sees
--                  the payment.
--
-- Each is run for a babysitter and for a calendar event. Waiting is observed
-- in pg_locks, not assumed from timing (see wallet-concurrency-check.sql for
-- why timing is not evidence). Two negative controls then run the same races:
--
--   no-lock          the payment side's FOR SHARE removed: move-first must now
--                    record a payment naming a row of another family.
--   no-parent-guard  the parent-side triggers disabled: payment-first must now
--                    move a named row to another family.
--
-- The real definitions are restored and compared byte for byte before any
-- verdict is allowed to fail the probe.
--
-- Everything the racing sessions must see is written by top-level statements,
-- so it is committed; everything is removed at the end.
\set ON_ERROR_STOP on

-- ── committed seed ──────────────────────────────────────────────────────────
delete from public.babysitter_payments where family_id in ('04720000-0000-4000-8000-00000000000a', '04720000-0000-4000-8000-00000000000b');
delete from public.babysitter_profiles where family_id in ('04720000-0000-4000-8000-00000000000a', '04720000-0000-4000-8000-00000000000b');
delete from public.calendar_events where family_id in ('04720000-0000-4000-8000-00000000000a', '04720000-0000-4000-8000-00000000000b');
delete from public.family_members where family_id in ('04720000-0000-4000-8000-00000000000a', '04720000-0000-4000-8000-00000000000b');
delete from public.families where id in ('04720000-0000-4000-8000-00000000000a', '04720000-0000-4000-8000-00000000000b');

insert into auth.users (id, email) values
  ('04720000-0000-4000-8000-0000000000a1', 'p0472-parent-a@example.test'),
  ('04720000-0000-4000-8000-0000000000b1', 'p0472-parent-b@example.test'),
  ('04720000-0000-4000-8000-0000000000ab', 'p0472-parent-both@example.test')
on conflict (id) do nothing;
insert into public.families (id, name, created_by) values
  ('04720000-0000-4000-8000-00000000000a', 'p0472 Family A', '04720000-0000-4000-8000-0000000000a1'),
  ('04720000-0000-4000-8000-00000000000b', 'p0472 Family B', '04720000-0000-4000-8000-0000000000b1');
insert into public.family_members (family_id, user_id, display_name, role, is_active) values
  ('04720000-0000-4000-8000-00000000000a', '04720000-0000-4000-8000-0000000000a1', 'Parent A', 'parent', true),
  ('04720000-0000-4000-8000-00000000000b', '04720000-0000-4000-8000-0000000000b1', 'Parent B', 'parent', true),
  ('04720000-0000-4000-8000-00000000000a', '04720000-0000-4000-8000-0000000000ab', 'Parent of both', 'parent', true),
  ('04720000-0000-4000-8000-00000000000b', '04720000-0000-4000-8000-0000000000ab', 'Parent of both', 'parent', true)
on conflict do nothing;
-- c1 A's sitter, c2 B's sitter, c3 A's sitter nobody has paid, c4/c5 A's sitters for the races.
insert into public.babysitter_profiles (id, family_id, name) values
  ('04720000-0000-4000-8000-0000000000c1', '04720000-0000-4000-8000-00000000000a', 'A sitter'),
  ('04720000-0000-4000-8000-0000000000c2', '04720000-0000-4000-8000-00000000000b', 'B sitter'),
  ('04720000-0000-4000-8000-0000000000c3', '04720000-0000-4000-8000-00000000000a', 'A sitter, unpaid'),
  ('04720000-0000-4000-8000-0000000000c4', '04720000-0000-4000-8000-00000000000a', 'A sitter, race 1'),
  ('04720000-0000-4000-8000-0000000000c5', '04720000-0000-4000-8000-00000000000a', 'A sitter, race 2');
-- c6 A's archived sitter, c7 A's sitter who will be deleted.
insert into public.babysitter_profiles (id, family_id, name, is_active) values
  ('04720000-0000-4000-8000-0000000000c6', '04720000-0000-4000-8000-00000000000a', 'A sitter, archived', false),
  ('04720000-0000-4000-8000-0000000000c7', '04720000-0000-4000-8000-00000000000a', 'A sitter, leaving', true);
-- e1 A's event, e2 B's event, e3 A's event nobody has paid for, e4/e5 A's events for the races.
insert into public.calendar_events (id, family_id, title, starts_at) values
  ('04720000-0000-4000-8000-0000000000e1', '04720000-0000-4000-8000-00000000000a', 'A date night', now()),
  ('04720000-0000-4000-8000-0000000000e2', '04720000-0000-4000-8000-00000000000b', 'B date night', now()),
  ('04720000-0000-4000-8000-0000000000e3', '04720000-0000-4000-8000-00000000000a', 'A dinner, unpaid', now()),
  ('04720000-0000-4000-8000-0000000000e4', '04720000-0000-4000-8000-00000000000a', 'A date night, race 1', now()),
  ('04720000-0000-4000-8000-0000000000e5', '04720000-0000-4000-8000-00000000000a', 'A date night, race 2', now());

-- ── static ──────────────────────────────────────────────────────────────────
begin;
do $static$
declare
  famA uuid := '04720000-0000-4000-8000-00000000000a';
  famB uuid := '04720000-0000-4000-8000-00000000000b';
  uA   uuid := '04720000-0000-4000-8000-0000000000a1';
  uAB  uuid := '04720000-0000-4000-8000-0000000000ab';
  sitterA uuid := '04720000-0000-4000-8000-0000000000c1';
  sitterB uuid := '04720000-0000-4000-8000-0000000000c2';
  sitterFree uuid := '04720000-0000-4000-8000-0000000000c3';
  eventA uuid := '04720000-0000-4000-8000-0000000000e1';
  eventB uuid := '04720000-0000-4000-8000-0000000000e2';
  eventFree uuid := '04720000-0000-4000-8000-0000000000e3';
  missing uuid := '04720000-0000-4000-8000-0000000000ff';
  sitterArchived uuid := '04720000-0000-4000-8000-0000000000c6';
  sitterLeaving uuid := '04720000-0000-4000-8000-0000000000c7';
  paid uuid;
  paidLeaving uuid;
  leftover uuid;
  probe text[];
  n int;
  failures int := 0;
begin
  -- As A's parent, through row-level security.
  perform set_config('request.jwt.claim.sub', uA::text, true);
  set local role authenticated;
  if not public.can_manage_family(famA) or public.is_family_member(famB) then
    raise exception 'CONTROL FAILED: not acting as a manager of A alone, so nothing below is a boundary';
  end if;

  -- 1. POSITIVE CONTROL: the same statements as 2-5, naming A's own rows.
  --    Without it, a refusal below could be anything saying no.
  begin
    insert into public.babysitter_payments (family_id, babysitter_id, event_id, amount_cents, status, created_by)
      values (famA, sitterA, eventA, 5000, 'completed', uA) returning id into paid;
    insert into public.babysitter_payments (family_id, babysitter_id, event_id, amount_cents, status, created_by)
      values (famA, sitterA, null, 2500, 'completed', uA);
    get diagnostics n = row_count;
    if paid is null or n <> 1 then
      raise exception 'CONTROL FAILED: A could not pay A''s own babysitter (rows: %)', n;
    end if;
  exception when others then
    raise exception 'CONTROL FAILED: A could not pay A''s own babysitter for A''s own event (% %)', sqlstate, sqlerrm;
  end;

  -- 2. B's babysitter.
  begin
    insert into public.babysitter_payments (family_id, babysitter_id, amount_cents, status, created_by)
      values (famA, sitterB, 5000, 'completed', uA);
    raise warning 'BREACH: A''s payment names B''s babysitter';
    failures := failures + 1;
  exception when insufficient_privilege then
    if sqlerrm not like '%babysitter in another family%' then
      raise warning 'REFUSED BY SOMETHING ELSE: %', sqlerrm; failures := failures + 1;
    end if;
  end;

  -- 3. A's babysitter, B's event.
  begin
    insert into public.babysitter_payments (family_id, babysitter_id, event_id, amount_cents, status, created_by)
      values (famA, sitterA, eventB, 5000, 'completed', uA);
    raise warning 'BREACH: A''s payment names B''s calendar event';
    failures := failures + 1;
  exception when insufficient_privilege then
    if sqlerrm not like '%calendar event in another family%' then
      raise warning 'REFUSED BY SOMETHING ELSE: %', sqlerrm; failures := failures + 1;
    end if;
  end;

  -- 4 and 5. A clean payment re-pointed afterwards.
  begin
    update public.babysitter_payments set babysitter_id = sitterB where id = paid;
    get diagnostics n = row_count;
    if n > 0 then raise warning 'BREACH: A''s payment was re-pointed at B''s babysitter'; failures := failures + 1; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    update public.babysitter_payments set event_id = eventB where id = paid;
    get diagnostics n = row_count;
    if n > 0 then raise warning 'BREACH: A''s payment was re-pointed at B''s event'; failures := failures + 1; end if;
  exception when insufficient_privilege then null;
  end;

  -- 6. A reference to nothing is the foreign key's to refuse, with its own error.
  begin
    insert into public.babysitter_payments (family_id, babysitter_id, amount_cents, status, created_by)
      values (famA, missing, 5000, 'completed', uA);
    raise warning 'BREACH: a payment names a babysitter that does not exist';
    failures := failures + 1;
  exception
    when foreign_key_violation then null;
    when insufficient_privilege then
      raise warning 'WRONG REFUSAL: a missing babysitter was refused as another family''s (%)', sqlerrm;
      failures := failures + 1;
  end;

  -- 7. Other columns are not references: an amount can be corrected, an event cleared.
  update public.babysitter_payments set amount_cents = 6000 where id = paid;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'OVER-BLOCKED: A could not correct a payment''s amount (rows: %)', n; failures := failures + 1; end if;
  update public.babysitter_payments set event_id = null where id = paid;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'OVER-BLOCKED: A could not clear a payment''s event (rows: %)', n; failures := failures + 1; end if;
  update public.babysitter_payments set event_id = eventA where id = paid;

  -- 7b. No babysitter at all, and A's own archived babysitter, are A's to record.
  insert into public.babysitter_payments (family_id, babysitter_id, event_id, amount_cents, status, created_by)
    values (famA, null, null, 1000, 'completed', uA);
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'OVER-BLOCKED: a payment naming no babysitter was refused (rows: %)', n; failures := failures + 1; end if;
  insert into public.babysitter_payments (family_id, babysitter_id, amount_cents, status, created_by)
    values (famA, sitterArchived, 1000, 'completed', uA);
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'OVER-BLOCKED: a late payment to A''s archived babysitter was refused (rows: %)', n; failures := failures + 1; end if;

  -- 7c. Deleting a babysitter A has paid is the foreign key's ON DELETE SET
  --     NULL: the payment stays, its reference cleared. The guard, which fires
  --     on that cascaded update, must not stand in its way.
  insert into public.babysitter_payments (family_id, babysitter_id, event_id, amount_cents, status, created_by)
    values (famA, sitterLeaving, eventA, 1000, 'completed', uA) returning id into paidLeaving;
  begin
    delete from public.babysitter_profiles where id = sitterLeaving;
    get diagnostics n = row_count;
    if n <> 1 then raise warning 'OVER-BLOCKED: A could not delete its own paid babysitter (rows: %)', n; failures := failures + 1; end if;
  exception when others then
    raise warning 'OVER-BLOCKED: deleting A''s paid babysitter raised % %', sqlstate, sqlerrm; failures := failures + 1;
  end;
  select babysitter_id into leftover from public.babysitter_payments where id = paidLeaving;
  if not found or leftover is not null then
    raise warning 'WRONG: the payment to a deleted babysitter was not kept with its reference cleared (found: %, babysitter_id: %)', found, leftover;
    failures := failures + 1;
  end if;

  reset role;

  -- As a parent of BOTH families. 0322 checks rights in the old and the new
  -- family, and this caller has both; only 0472 can say no.
  perform set_config('request.jwt.claim.sub', uAB::text, true);
  set local role authenticated;
  if not (public.can_manage_family(famA) and public.can_manage_family(famB)) then
    raise exception 'CONTROL FAILED: not acting as a manager of both families';
  end if;

  -- 8. POSITIVE CONTROL: a babysitter and an event nobody's payment names still move.
  update public.babysitter_profiles set family_id = famB where id = sitterFree;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'CONTROL FAILED: a manager of both could not move an unpaid babysitter (rows: %)', n; end if;
  update public.calendar_events set family_id = famB where id = eventFree;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'CONTROL FAILED: a member of both could not move an unpaid event (rows: %)', n; end if;

  -- 9 and 10. The ones A's payments name do not.
  begin
    update public.babysitter_profiles set family_id = famB where id = sitterA;
    get diagnostics n = row_count;
    if n > 0 then raise warning 'BREACH: a babysitter A''s payments name was moved to B'; failures := failures + 1; end if;
  exception when insufficient_privilege then
    if sqlerrm not like '%cannot move to another family%' then
      raise warning 'REFUSED BY SOMETHING ELSE: %', sqlerrm; failures := failures + 1;
    end if;
  end;
  begin
    update public.calendar_events set family_id = famB where id = eventA;
    get diagnostics n = row_count;
    if n > 0 then raise warning 'BREACH: an event A''s payment names was moved to B'; failures := failures + 1; end if;
  exception when insufficient_privilege then
    if sqlerrm not like '%cannot move to another family%' then
      raise warning 'REFUSED BY SOMETHING ELSE: %', sqlerrm; failures := failures + 1;
    end if;
  end;

  -- 11. Rights in both families do not make A's babysitter B's to pay:
  --     neither a new B payment naming it, nor A's payment moved to B.
  begin
    update public.babysitter_payments set family_id = famB where id = paid;
    get diagnostics n = row_count;
    if n > 0 then raise warning 'BREACH: a manager of both moved A''s payment, still naming A''s babysitter, to B'; failures := failures + 1; end if;
  exception when insufficient_privilege then
    if sqlerrm not like '%in another family%' then
      raise warning 'REFUSED BY SOMETHING ELSE: %', sqlerrm; failures := failures + 1;
    end if;
  end;
  begin
    insert into public.babysitter_payments (family_id, babysitter_id, amount_cents, status, created_by)
      values (famB, sitterA, 5000, 'completed', uAB);
    raise warning 'BREACH: a manager of both filed a B payment naming A''s babysitter';
    failures := failures + 1;
  exception when insufficient_privilege then
    if sqlerrm not like '%babysitter in another family%' then
      raise warning 'REFUSED BY SOMETHING ELSE: %', sqlerrm; failures := failures + 1;
    end if;
  end;

  reset role;

  -- 12. NEGATIVE CONTROL, in this same rolled-back transaction: with the three
  --     triggers disabled, every write refused in 2-5 and 9-11 is repeated by
  --     the same caller and must land on exactly one row. If one does not, its
  --     refusal above came from something other than 0472. The payment moved
  --     to B (11) and the re-points (4, 5) are put back before the parent
  --     moves, so 9 and 10 still move rows that A's payments name. The undo
  --     steps are writes the guards allow anyway; they are counted only so a
  --     silent no-op cannot pass.
  alter table public.babysitter_payments disable trigger trg_babysitter_payments_reference_family;
  alter table public.babysitter_profiles disable trigger trg_babysitter_profiles_keep_paid_family;
  alter table public.calendar_events disable trigger trg_calendar_events_keep_paid_family;
  foreach probe slice 1 in array array[
    ['2', uA::text, format('insert into public.babysitter_payments (family_id, babysitter_id, amount_cents, status, created_by) values (%L, %L, 5000, %L, %L)', famA, sitterB, 'completed', uA)],
    ['3', uA::text, format('insert into public.babysitter_payments (family_id, babysitter_id, event_id, amount_cents, status, created_by) values (%L, %L, %L, 5000, %L, %L)', famA, sitterA, eventB, 'completed', uA)],
    ['4', uA::text, format('update public.babysitter_payments set babysitter_id = %L where id = %L', sitterB, paid)],
    ['4 undone', uA::text, format('update public.babysitter_payments set babysitter_id = %L where id = %L', sitterA, paid)],
    ['5', uA::text, format('update public.babysitter_payments set event_id = %L where id = %L', eventB, paid)],
    ['5 undone', uA::text, format('update public.babysitter_payments set event_id = %L where id = %L', eventA, paid)],
    ['11 (payment moved)', uAB::text, format('update public.babysitter_payments set family_id = %L where id = %L', famB, paid)],
    ['11 undone', uAB::text, format('update public.babysitter_payments set family_id = %L where id = %L', famA, paid)],
    ['11 (B payment)', uAB::text, format('insert into public.babysitter_payments (family_id, babysitter_id, amount_cents, status, created_by) values (%L, %L, 5000, %L, %L)', famB, sitterA, 'completed', uAB)],
    ['9', uAB::text, format('update public.babysitter_profiles set family_id = %L where id = %L', famB, sitterA)],
    ['10', uAB::text, format('update public.calendar_events set family_id = %L where id = %L', famB, eventA)]
  ] loop
    perform set_config('request.jwt.claim.sub', probe[2], true);
    set local role authenticated;
    begin
      execute probe[3];
      get diagnostics n = row_count;
      if n <> 1 then
        raise warning 'UNPROVEN: with the guards disabled, write % did not land (rows: %)', probe[1], n;
        failures := failures + 1;
      end if;
    exception when others then
      raise warning 'UNPROVEN: with the guards disabled, write % was still refused (% %)', probe[1], sqlstate, sqlerrm;
      failures := failures + 1;
    end;
    reset role;
  end loop;

  if failures > 0 then
    raise exception '0472 static: % assertion(s) failed', failures;
  end if;
  raise notice '0472 static: OK — A pays only A''s babysitter and event; named rows stay; a manager of both is held to it, payment moves included; missing ids are the foreign key''s; no babysitter, an archived one and a deleted one (reference cleared) are still A''s; with the guards disabled, each refused write (2, 3, 4, 5, 9, 10, 11) lands on one row';
end
$static$;
rollback;

-- ── races ───────────────────────────────────────────────────────────────────
create extension if not exists dblink;

-- As in wallet-concurrency-check.sql: pg-bootstrap.sh's default privileges
-- hand every new public function to anon and authenticated, dblink's
-- SECURITY DEFINER connect functions included. Only this probe calls them.
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_proc p
    join pg_depend d on d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
    join pg_extension e on e.oid = d.refobjid
    where e.extname = 'dblink'
      and p.proowner = (select oid from pg_roles where rolname = current_user)
      and (has_function_privilege('anon', p.oid, 'execute')
           or has_function_privilege('authenticated', p.oid, 'execute'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

drop table if exists p0472_verdict;
create temp table p0472_verdict (
  stage text, kind text, race text, waited boolean, answer text, breach boolean,
  primary key (stage, kind, race));

drop table if exists p0472_saved_fn;
create temp table p0472_saved_fn as
select pg_get_functiondef(p.oid) as def, p.prosrc as body
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'babysitter_payment_references_own_family';

create or replace procedure public.p0472_race(p_stage text, p_kind text)
language plpgsql
as $proc$
declare
  famA uuid := '04720000-0000-4000-8000-00000000000a';
  famB uuid := '04720000-0000-4000-8000-00000000000b';
  uA   uuid := '04720000-0000-4000-8000-0000000000a1';
  uAB  uuid := '04720000-0000-4000-8000-0000000000ab';
  sitterA uuid := '04720000-0000-4000-8000-0000000000c1';
  conn text;
  tbl text; col text;
  race text; target uuid;
  pay_sql text; move_sql text;
  waiter text; waiter_pid int; seen boolean; waited_ms int;
  err text; n int;
begin
  conn := 'dbname=' || current_database()
    || ' host=' || split_part(current_setting('unix_socket_directories'), ',', 1)
    || ' port=' || current_setting('port')
    || ' user=' || current_user;
  if p_kind = 'babysitter' then tbl := 'babysitter_profiles'; col := 'babysitter_id';
  else tbl := 'calendar_events'; col := 'event_id'; end if;

  foreach race in array array['move-first', 'payment-first'] loop
    if p_kind = 'babysitter' then
      target := case race when 'move-first' then '04720000-0000-4000-8000-0000000000c4'::uuid else '04720000-0000-4000-8000-0000000000c5'::uuid end;
      pay_sql := format('insert into public.babysitter_payments (family_id, babysitter_id, amount_cents, status, created_by) values (%L, %L, 5000, ''completed'', %L) returning ''INSERTED''', famA, target, uA);
    else
      target := case race when 'move-first' then '04720000-0000-4000-8000-0000000000e4'::uuid else '04720000-0000-4000-8000-0000000000e5'::uuid end;
      pay_sql := format('insert into public.babysitter_payments (family_id, babysitter_id, event_id, amount_cents, status, created_by) values (%L, %L, %L, 5000, ''completed'', %L) returning ''INSERTED''', famA, sitterA, target, uA);
    end if;
    move_sql := format('update public.%I set family_id = %L where id = %L returning ''MOVED''', tbl, famB, target);

    -- A clean start, as the trusted owner: the row in A, no payment naming it.
    -- Through its own short connection, so it is COMMITTED: done here, inside
    -- this CALL's transaction, it would hold the row lock the mover then waits
    -- on forever.
    perform dblink_exec(conn, format(
      'delete from public.babysitter_payments where %I = %L; update public.%I set family_id = %L where id = %L',
      col, target, tbl, famA, target));

    perform dblink_connect('p0472_mover', conn || ' application_name=p0472_mover');
    perform dblink_connect('p0472_payer', conn || ' application_name=p0472_payer');
    perform dblink_exec('p0472_mover', 'begin');
    perform * from dblink('p0472_mover', format('select set_config(''request.jwt.claim.sub'', %L, true)', uAB)) as t(v text);
    perform dblink_exec('p0472_mover', 'set local role authenticated');
    perform dblink_exec('p0472_payer', 'begin');
    perform * from dblink('p0472_payer', format('select set_config(''request.jwt.claim.sub'', %L, true)', uA)) as t(v text);
    perform dblink_exec('p0472_payer', 'set local role authenticated');

    -- The first party acts and holds its transaction open; the second is sent
    -- and must queue behind it.
    if race = 'move-first' then
      perform * from dblink('p0472_mover', move_sql) as t(v text);
      waiter := 'p0472_payer';
      select pid into waiter_pid from dblink(waiter, 'select pg_backend_pid()') as t(pid int);
      perform dblink_send_query('p0472_payer', pay_sql);
    else
      perform * from dblink('p0472_payer', pay_sql) as t(v text);
      waiter := 'p0472_mover';
      select pid into waiter_pid from dblink(waiter, 'select pg_backend_pid()') as t(pid int);
      perform dblink_send_query('p0472_mover', move_sql);
    end if;

    -- By the waiter's own backend pid, in pg_locks, which is read live.
    -- pg_stat_activity is snapshotted once per transaction, and this whole CALL
    -- is one transaction: the second race of a call polled the first race's
    -- sessions and never saw its own waiter.
    seen := false; waited_ms := 0;
    while waited_ms < 5000 loop
      if exists (select 1 from pg_locks where pid = waiter_pid and not granted) then
        seen := true; exit;
      end if;
      exit when dblink_is_busy(waiter) = 0;
      perform pg_sleep(0.005);
      waited_ms := waited_ms + 5;
    end loop;

    -- Release the first party, then read the second's answer without raising.
    if race = 'move-first' then perform dblink_exec('p0472_mover', 'commit');
    else perform dblink_exec('p0472_payer', 'commit'); end if;
    perform * from dblink_get_result(waiter, false) as t(v text);
    err := dblink_error_message(waiter);
    perform * from dblink_get_result(waiter, false) as t(v text);
    if err is null or err = 'OK' then
      err := null;
      perform dblink_exec(waiter, 'commit');
    else
      perform dblink_exec(waiter, 'rollback');
    end if;
    perform dblink_disconnect('p0472_mover');
    perform dblink_disconnect('p0472_payer');

    -- The breach itself: an A payment naming a row that is no longer A's.
    execute format(
      'select count(*) from public.babysitter_payments p join public.%I r on r.id = p.%I where p.%I = %L and r.family_id is distinct from p.family_id',
      tbl, col, col, target) into n;
    insert into p0472_verdict values (p_stage, p_kind, race, seen, coalesce(err, 'accepted'), n > 0);
  end loop;
exception when others then
  begin perform dblink_disconnect('p0472_mover'); exception when others then null; end;
  begin perform dblink_disconnect('p0472_payer'); exception when others then null; end;
  insert into p0472_verdict values (p_stage, p_kind, coalesce(race, '?'), null, 'raised: ' || sqlerrm, null)
  on conflict (stage, kind, race) do update set answer = excluded.answer, breach = null;
end
$proc$;

-- Stage 1: as installed.
call public.p0472_race('real', 'babysitter');
call public.p0472_race('real', 'event');

-- Stage 2: the payment side's FOR SHARE removed.
do $$
declare v_def text;
begin
  select def into v_def from p0472_saved_fn;
  if v_def is null then raise exception '0472 FAIL: the payment-side function was not found to save'; end if;
  execute replace(v_def, 'for share', '');
end $$;
call public.p0472_race('no-lock', 'babysitter');
call public.p0472_race('no-lock', 'event');
do $$
declare v_def text; v_body text;
begin
  select def, body into v_def, v_body from p0472_saved_fn;
  execute v_def;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'babysitter_payment_references_own_family'
                    and p.prosrc = v_body) then
    raise exception '0472 FAIL: babysitter_payment_references_own_family was NOT restored to the saved body; re-apply supabase/migrations/0472_a_babysitter_payment_names_its_own_familys_sitter_and_event.sql before trusting this database';
  end if;
end $$;

-- Stage 3: the parent-side guards disabled.
alter table public.babysitter_profiles disable trigger trg_babysitter_profiles_keep_paid_family;
alter table public.calendar_events disable trigger trg_calendar_events_keep_paid_family;
call public.p0472_race('no-parent-guard', 'babysitter');
call public.p0472_race('no-parent-guard', 'event');
alter table public.babysitter_profiles enable trigger trg_babysitter_profiles_keep_paid_family;
alter table public.calendar_events enable trigger trg_calendar_events_keep_paid_family;
do $$
begin
  if exists (select 1 from pg_trigger
              where tgname in ('trg_babysitter_profiles_keep_paid_family', 'trg_calendar_events_keep_paid_family')
                and tgenabled <> 'O') then
    raise exception '0472 FAIL: a parent-side guard was left disabled; re-enable it before trusting this database';
  end if;
end $$;

-- ── verdict ─────────────────────────────────────────────────────────────────
do $$
declare
  v record;
  failures int := 0;
  unobserved int := 0;
  summary text := '';
begin
  for v in select * from p0472_verdict order by stage, kind, race loop
    summary := summary || format(E'\n  %s %s %s: waited=%s breach=%s answer=%s', v.stage, v.kind, v.race, v.waited, v.breach, v.answer);
  end loop;

  -- As installed: every second party queued and was refused; nothing crossed.
  for v in select * from p0472_verdict where stage = 'real' loop
    if v.breach is null then
      raise warning '0472 FAIL: real % % did not complete: %', v.kind, v.race, v.answer; failures := failures + 1;
    elsif v.breach then
      raise warning '0472 BREACH: real % %: a payment of A names a row now in B (%)', v.kind, v.race, v.answer; failures := failures + 1;
    elsif not v.waited then
      unobserved := unobserved + 1;
    elsif v.race = 'move-first' and v.answer not like '%in another family%' then
      raise warning '0472 FAIL: real % move-first: the payment was not refused by the guard (%)', v.kind, v.answer; failures := failures + 1;
    elsif v.race = 'payment-first' and v.answer not like '%cannot move to another family%' then
      raise warning '0472 FAIL: real % payment-first: the move was not refused by the guard (%)', v.kind, v.answer; failures := failures + 1;
    end if;
  end loop;
  if (select count(*) from p0472_verdict where stage = 'real') <> 4 then
    raise warning '0472 FAIL: expected 4 real races, recorded %', (select count(*) from p0472_verdict where stage = 'real');
    failures := failures + 1;
  end if;

  -- Negative controls: the race each mechanism exists for must now cross.
  for v in select * from p0472_verdict
            where (stage = 'no-lock' and race = 'move-first') or (stage = 'no-parent-guard' and race = 'payment-first') loop
    if v.breach is distinct from true then
      raise warning '0472 UNPROVEN: % % %: the race did not cross with the mechanism removed (%), so the real stage''s refusal is not shown to be its doing',
        v.stage, v.kind, v.race, v.answer;
      failures := failures + 1;
    end if;
  end loop;
  if (select count(*) from p0472_verdict
       where (stage = 'no-lock' and race = 'move-first') or (stage = 'no-parent-guard' and race = 'payment-first')) <> 4 then
    raise warning '0472 FAIL: expected 4 negative-control races'; failures := failures + 1;
  end if;

  if failures > 0 then
    raise exception '0472 races: % assertion(s) failed:%', failures, summary;
  end if;
  if unobserved > 0 then
    raise notice '0472 SKIP: % of 4 real races never observed the second session waiting in 5s; concurrency was NOT exercised:%', unobserved, summary;
    return;
  end if;
  raise notice '0472 races: OK — a payment and a move of the row it names serialize, and the second is refused, for a babysitter and for an event; each negative control crosses:%', summary;
end $$;

-- ── cleanup ─────────────────────────────────────────────────────────────────
drop procedure if exists public.p0472_race(text, text);
drop table if exists p0472_verdict;
drop table if exists p0472_saved_fn;
delete from public.babysitter_payments where family_id in ('04720000-0000-4000-8000-00000000000a', '04720000-0000-4000-8000-00000000000b');
delete from public.babysitter_profiles where family_id in ('04720000-0000-4000-8000-00000000000a', '04720000-0000-4000-8000-00000000000b');
delete from public.calendar_events where family_id in ('04720000-0000-4000-8000-00000000000a', '04720000-0000-4000-8000-00000000000b');
delete from public.family_members where family_id in ('04720000-0000-4000-8000-00000000000a', '04720000-0000-4000-8000-00000000000b');
delete from public.families where id in ('04720000-0000-4000-8000-00000000000a', '04720000-0000-4000-8000-00000000000b');
delete from auth.users where id in ('04720000-0000-4000-8000-0000000000a1', '04720000-0000-4000-8000-0000000000b1', '04720000-0000-4000-8000-0000000000ab');
