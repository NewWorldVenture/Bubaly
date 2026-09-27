-- ── The urgent fallback number is stored the only way it can be used (m13, 0384) ──
--
-- `public.family_contact_channels.forward_to_phone` is the number a family says
-- to call or text when something at their Contact Center line is urgent. Every
-- consumer of it requires E.164 and none of them can say so out loud:
-- `sendSmsWithReceipt` (lib/guardian/twilio.ts) refuses anything that is not
-- /^\+[1-9]\d{7,14}$/ before the urgent text leaves the server, and `twimlDial`
-- interpolates the value into a `<Dial>`, where a stored '&' or '<' makes the
-- TwiML unparseable and the caller hears an application error. The field's own
-- placeholder, "+1 555 123 4567", was stored exactly as typed and never worked.
--
-- `0384_the_urgent_fallback_number_is_stored_the_only_way_it_can_be_used.sql`
-- makes the database hold the contract 0214's column comment already claimed:
--
--   1. it keeps what was stored (`forward_to_phone_legacy`), then normalizes
--      it as lib/contact-center/phone.ts `normalizeFallbackPhone` does: a
--      '+'-prefixed number keeps its digits, NO country code is guessed, and
--      everything else becomes null;
--   2. it adds CHECK `family_contact_channels_forward_to_phone_e164`:
--        forward_to_phone is null or forward_to_phone ~ '^\+[1-9][0-9]{7,14}$'
--
-- The shipped vitest (tests/the-urgent-fallback-number-a-parent-types-still-
-- reaches-their-phone.test.ts) runs against an in-memory stand-in and cannot see
-- a CHECK constraint at all. This file is the proof, executed as the roles.
--
-- WHO THE ACTOR IS, AND WHY IT IS NOT `authenticated`
-- ---------------------------------------------------------------------------
-- 0214 gives this table a SELECT policy and nothing else, so under RLS a
-- signed-in client can write no row of it; `updateConciergeAction` writes it
-- through `createServiceClient()`, i.e. as `service_role`, which bypasses RLS.
-- The constraint is therefore the ONLY thing between that writer (and the next
-- one) and a number nothing can dial. So the boundary is proved as
-- `service_role`, with `request.jwt.claim.role` set the way PostgREST sets it
-- for the service key. A signed-in manager is tried too, at the end of PART 1,
-- and what refused them is RECORDED rather than credited to 0384 — today it is
-- RLS, and a probe that took RLS's refusal as the constraint's would be the
-- decoration this directory exists to avoid.
--
-- PROVES
-- ---------------------------------------------------------------------------
--   PART 1 — the write boundary, one transaction, rolled back:
--     a. NEGATIVE CONTROL (first): the service role UPDATEs and INSERTs an
--        E.164 number — the same statements, the same column, the same row and
--        key as every refusal below, the value the only difference — and BOTH
--        MUST LAND;
--     b. ten malformed values are refused on UPDATE and on INSERT with SQLSTATE
--        23514 AND `constraint_name = family_contact_channels_forward_to_phone_
--        e164`, and the stored value / absent row is unchanged: the field's own
--        placeholder, "(555) 123-4567", a TwiML-breaking "Mom & Dad <…>", a
--        trailing newline (JS's `$` refuses it, so the DB must too), the empty
--        string, a leading zero, 7 and 16 digits, and E.164 missing its plus;
--     c. the constraint is no stricter than `isE164`: null (clearing the
--        field), the 8- and 15-digit edges and a non-US number all land;
--     d. a signed-in manager's attempt stores nothing (mechanism recorded).
--
--   PART 2 — the normalize step, by running THE MIGRATION FILE ITSELF (`\ir`,
--     as wallet-write-rls-check.sql does with 0275; a copy pasted here would
--     drift and start proving the wrong thing). The constraint is dropped
--     inside this transaction, nine legacy rows are planted with an old
--     `updated_at`, 0384 is applied, and each row must come out the way the
--     header says: a spaced / punctuated '+' number keeps its digits; a bare
--     ten-digit US-looking number, an eleven-digit one with the 1, and a
--     country code that lost its plus all become NULL — the migration must not
--     guess +1, because "312 345 6789" read as +1 is a real Chicago number and
--     the urgent text would reach a stranger; what cannot be a number becomes
--     null; every rewritten row keeps what it held in `forward_to_phone_legacy`
--     and no untouched row gets one; a row that already satisfied the contract
--     is NOT touched (its `updated_at` survives); and the constraint is back and
--     VALIDATED. Then the family whose "(555) 123-4567" was cleared saves its
--     concierge greeting — the write the header says a legacy value would
--     otherwise have blocked.
--
-- WHAT THE NEGATIVE CONTROL CATCHES
-- ---------------------------------------------------------------------------
-- Every refusal in 1b is a raised error, and an error proves nothing on its
-- own. Revoke INSERT/UPDATE on this table from service_role and all ten are
-- refused with 42501; add a guard trigger for an unrelated rule — even one that
-- raises 23514 — and all ten are refused with the very SQLSTATE this file
-- looks for. In both cases the control's E.164 write is refused TOO, and the
-- probe goes red on "CONTROL FAILED" instead of reporting a boundary it cannot
-- see. The `constraint_name` check covers the remaining case: a different
-- CHECK constraint on this column (a length cap, say) refusing these values
-- while 0384's has been dropped.
--
-- UUIDs: 00000000-0000-4000-8000-00000384e1xx, unique across docs/audit and
-- supabase/migrations at the time of writing (grep before reusing the range).
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 \
--       -f docs/audit/the-urgent-fallback-number-is-stored-the-only-way-it-can-be-used-check.sql

\set U  '00000000-0000-4000-8000-00000384e100'
\set F  '00000000-0000-4000-8000-00000384e101'
\set F2 '00000000-0000-4000-8000-00000384e102'
-- PART 2's legacy households, one channel row each (family_id is the key).
\set L1 '00000000-0000-4000-8000-00000384e111'
\set L2 '00000000-0000-4000-8000-00000384e112'
\set L3 '00000000-0000-4000-8000-00000384e113'
\set L4 '00000000-0000-4000-8000-00000384e114'
\set L5 '00000000-0000-4000-8000-00000384e115'
\set L6 '00000000-0000-4000-8000-00000384e116'
\set L7 '00000000-0000-4000-8000-00000384e117'
\set L8 '00000000-0000-4000-8000-00000384e118'
\set L9 '00000000-0000-4000-8000-00000384e119'

begin;

-- ── Seed, as postgres ───────────────────────────────────────────────────────
insert into auth.users (id, email) values (:'U', 'm13-fallback-parent@example.com') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'F',  'Fallback House',          :'U') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'F2', 'Fallback House, no line', :'U') on conflict do nothing;
-- on_family_created files the creator as a parent; re-assert rather than
-- assume, since PART 1d reads what a MANAGER can do.
update public.family_members set role = 'parent', is_active = true
 where family_id in (:'F', :'F2') and user_id = :'U';

-- F has a channel row with no fallback yet — the shape `getOrCreateChannelResult`
-- leaves before `updateConciergeAction` patches it. F2 has none, so the INSERT
-- path has an empty key to write to.
insert into public.family_contact_channels (family_id, forward_to_phone) values (:'F', null)
  on conflict (family_id) do update set forward_to_phone = null;
delete from public.family_contact_channels where family_id = :'F2';

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1 — THE WRITE BOUNDARY
-- ═══════════════════════════════════════════════════════════════════════════
do $m13$
declare
  fam      constant uuid := '00000000-0000-4000-8000-00000384e101';
  fam2     constant uuid := '00000000-0000-4000-8000-00000384e102';
  parent_u constant uuid := '00000000-0000-4000-8000-00000384e100';
  conname  constant text := 'family_contact_channels_forward_to_phone_e164';
  good     constant text := '+15555550384';
  bad      text[] := array[
    '+1 555 123 4567',                 -- the field's own placeholder
    '(555) 123-4567',                  -- what a US parent types
    '555-123-4567',
    'Mom & Dad <555-0200>',            -- an unparseable <Dial>
    '+15555550384' || chr(10),         -- a trailing newline
    '',                                -- empty is not "no number"; null is
    '+05555550384',                    -- a leading zero after the plus
    '+1234567',                        -- 7 digits: too short
    '+1234567890123456',               -- 16 digits: too long
    '15555550384'                      -- E.164 that lost its plus
  ];
  edges    text[] := array[
    '+12345678',                       -- 8 digits, the shortest isE164 allows
    '+123456789012345',                -- 15 digits, the longest
    '+442079460958'                    -- not a US number
  ];
  b        text;
  shown    text;                     -- b, with a newline made visible
  v        text;
  n        int;
  st       text;
  cn       text;
  msg      text;
  landed   boolean;
  failures text[] := '{}';
  control_ok boolean := true;
begin
  -- ── As the service role: the writer `updateConciergeAction` actually uses ──
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);

  -- ── a. NEGATIVE CONTROL — the same statements with an E.164 value ─────────
  -- UPDATE: the statement the server action sends, on the row the refusals
  -- below target. It must change exactly that row, to exactly that value.
  begin
    update public.family_contact_channels set forward_to_phone = good where family_id = fam;
    get diagnostics n = row_count;
    select forward_to_phone into v from public.family_contact_channels where family_id = fam;
    if n <> 1 or v is distinct from good then
      control_ok := false;
      failures := array_append(failures, format(
        'CONTROL FAILED: the service role''s UPDATE of forward_to_phone to the E.164 %s changed %s row(s) and left %L stored, so a refusal below would prove nothing about 0384''s constraint',
        good, n, v));
    end if;
  exception when others then
    get stacked diagnostics st = returned_sqlstate, msg = message_text;
    control_ok := false;
    failures := array_append(failures, format(
      'CONTROL FAILED: the service role was refused an UPDATE of forward_to_phone to the E.164 %s (%s: %s). Something other than 0384 refuses this write — a revoked grant, a guard trigger, an unrelated constraint — so the refusals below would prove only that something said no',
      good, st, msg));
  end;

  -- INSERT: the same key the INSERT refusals use. The row is undone by its own
  -- savepoint (the sentinel raise below) so those refusals meet the SAME empty
  -- key and cannot be explained by a duplicate.
  begin
    begin
      insert into public.family_contact_channels (family_id, forward_to_phone) values (fam2, good);
      get diagnostics n = row_count;
      select forward_to_phone into v from public.family_contact_channels where family_id = fam2;
      if n <> 1 or v is distinct from good then
        control_ok := false;
        failures := array_append(failures, format(
          'CONTROL FAILED: the service role''s INSERT of a channel row with the E.164 fallback %s stored %s row(s) holding %L',
          good, n, v));
      end if;
      raise exception using errcode = 'P0001', message = 'm13-control-insert-landed';
    exception when others then
      get stacked diagnostics st = returned_sqlstate, msg = message_text;
      if msg <> 'm13-control-insert-landed' then
        control_ok := false;
        failures := array_append(failures, format(
          'CONTROL FAILED: the service role was refused an INSERT of a channel row with the E.164 fallback %s (%s: %s), so the INSERT refusals below would prove nothing about 0384''s constraint',
          good, st, msg));
      end if;
    end;
  end;

  if not control_ok then
    raise exception 'm13 FAIL (the negative control did not land — nothing below can be attributed to 0384): %',
      array_to_string(failures, E'\n  ');
  end if;
  raise notice 'm13: control OK — the service role UPDATEs and INSERTs an E.164 fallback number (%)', good;

  -- ── b. The refusals 0384 introduces ───────────────────────────────────────
  foreach b in array bad loop
    shown := replace(b, chr(10), '[LF]');
    -- UPDATE of the row the control just wrote.
    landed := false;
    begin
      update public.family_contact_channels set forward_to_phone = b where family_id = fam;
      get diagnostics n = row_count;
      landed := n > 0;
      if landed then
        failures := array_append(failures, format(
          'the service role STORED %L as the urgent fallback number (UPDATE changed %s row) — the provider refuses it on every send and a forwarded call cannot be dialled',
          shown, n));
      else
        failures := array_append(failures, format(
          'the service role''s UPDATE to %L changed 0 rows without an error — the control''s row is not reachable, so this is not the constraint', shown));
      end if;
    exception when others then
      get stacked diagnostics st = returned_sqlstate, cn = constraint_name, msg = message_text;
      if st <> '23514' or cn is distinct from conname then
        failures := array_append(failures, format(
          'the UPDATE to %L was refused, but by %s (constraint %L: %s), not by %s', shown, st, cn, msg, conname));
      end if;
    end;
    if not landed then
      select forward_to_phone into v from public.family_contact_channels where family_id = fam;
      if v is distinct from good then
        failures := array_append(failures, format(
          'after the refused UPDATE to %L the stored fallback is %L, not the control''s %L', shown, v, good));
      end if;
    else
      -- Put the control's value back so the next value is tried against the
      -- same starting row (only reachable when the constraint is missing).
      update public.family_contact_channels set forward_to_phone = good where family_id = fam;
    end if;

    -- INSERT of a new channel row carrying the value.
    begin
      insert into public.family_contact_channels (family_id, forward_to_phone) values (fam2, b);
      failures := array_append(failures, format(
        'the service role INSERTed a channel row whose urgent fallback number is %L', shown));
      delete from public.family_contact_channels where family_id = fam2;
    exception when others then
      get stacked diagnostics st = returned_sqlstate, cn = constraint_name, msg = message_text;
      if st <> '23514' or cn is distinct from conname then
        failures := array_append(failures, format(
          'the INSERT of %L was refused, but by %s (constraint %L: %s), not by %s', shown, st, cn, msg, conname));
      end if;
    end;
    if exists (select 1 from public.family_contact_channels where family_id = fam2) then
      failures := array_append(failures, format('a channel row exists for the INSERT key after the refused INSERT of %L', shown));
    end if;
  end loop;

  if cardinality(failures) = 0 then
    raise notice 'm13: refusal OK — % malformed fallback numbers refused on UPDATE and on INSERT with 23514 by %, stored value unchanged',
      cardinality(bad), conname;
  end if;

  -- ── c. What the action stores must still land ─────────────────────────────
  -- `normalizeFallbackPhone` stores null for a blank field and any isE164
  -- value otherwise; a constraint stricter than that breaks a legitimate save.
  begin
    update public.family_contact_channels set forward_to_phone = null where family_id = fam;
    get diagnostics n = row_count;
    select forward_to_phone into v from public.family_contact_channels where family_id = fam;
    if n <> 1 or v is not null then
      failures := array_append(failures, format('clearing the fallback number (null) changed %s row(s) and left %L', n, v));
    end if;
  exception when others then
    get stacked diagnostics st = returned_sqlstate, msg = message_text;
    failures := array_append(failures, format('clearing the fallback number (null) was refused (%s: %s)', st, msg));
  end;
  foreach b in array edges loop
    begin
      update public.family_contact_channels set forward_to_phone = b where family_id = fam;
      get diagnostics n = row_count;
      select forward_to_phone into v from public.family_contact_channels where family_id = fam;
      if n <> 1 or v is distinct from b then
        failures := array_append(failures, format('the valid E.164 %L changed %s row(s) and left %L', b, n, v));
      end if;
    exception when others then
      get stacked diagnostics st = returned_sqlstate, msg = message_text;
      failures := array_append(failures, format(
        'the valid E.164 %L was refused (%s: %s) — the constraint is stricter than isE164 and breaks a legitimate save', b, st, msg));
    end;
  end loop;
  if cardinality(failures) = 0 then
    raise notice 'm13: legitimate writes OK — null, the 8- and 15-digit edges and a non-US number all land';
  end if;

  -- ── d. A signed-in manager (recorded mechanism, asserted outcome) ─────────
  update public.family_contact_channels set forward_to_phone = good where family_id = fam;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  begin
    update public.family_contact_channels set forward_to_phone = '+1 555 123 4567' where family_id = fam;
    get diagnostics n = row_count;
    if n = 0 then
      raise notice 'm13: a signed-in manager''s UPDATE changed 0 rows — refused by RLS (0214 grants no client write policy), as 0384''s header says; not credited to 0384';
    end if;
  exception when others then
    get stacked diagnostics st = returned_sqlstate, cn = constraint_name, msg = message_text;
    raise notice 'm13: a signed-in manager''s UPDATE was refused with % (constraint %)', st, coalesce(nullif(cn, ''), 'none');
  end;
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  select forward_to_phone into v from public.family_contact_channels where family_id = fam;
  if v is distinct from good then
    failures := array_append(failures, format(
      'a signed-in manager stored %L as the urgent fallback number', v));
  end if;

  if cardinality(failures) > 0 then
    raise exception 'm13 FAIL (0384 does not hold the urgent fallback number to E.164):%',
      E'\n  ' || array_to_string(failures, E'\n  ');
  end if;
  raise notice 'm13: PART 1 OK — the urgent fallback number can only be stored as E.164 or null';
end
$m13$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2 — THE NORMALIZE STEP, BY RUNNING 0384 ITSELF
-- ═══════════════════════════════════════════════════════════════════════════
-- Back to postgres: the DO block's set_config(..., true) calls are
-- transaction-local and would otherwise outlive it.
reset role;
do $$
begin
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
end
$$;

-- The legacy state: rows written before the constraint existed. Dropping it
-- here is undone by the final rollback.
alter table public.family_contact_channels drop constraint if exists family_contact_channels_forward_to_phone_e164;

insert into public.families (id, name, created_by) values
  (:'L1', 'Legacy 1', :'U'), (:'L2', 'Legacy 2', :'U'), (:'L3', 'Legacy 3', :'U'),
  (:'L4', 'Legacy 4', :'U'), (:'L5', 'Legacy 5', :'U'), (:'L6', 'Legacy 6', :'U'),
  (:'L7', 'Legacy 7', :'U'), (:'L8', 'Legacy 8', :'U'), (:'L9', 'Legacy 9', :'U')
on conflict do nothing;

-- An old updated_at on every row: the BEFORE UPDATE trigger restamps it, so a
-- row that keeps 2020 is a row the migration did not touch.
insert into public.family_contact_channels (family_id, forward_to_phone, updated_at) values
  (:'L1', '+1 555 123 4567',      '2020-01-01 00:00:00+00'),
  (:'L2', '(555) 123-4567',       '2020-01-01 00:00:00+00'),
  (:'L3', '44 20 7946 0958',      '2020-01-01 00:00:00+00'),
  (:'L4', 'Mom & Dad <555-0200>', '2020-01-01 00:00:00+00'),
  (:'L5', 'call my cell',         '2020-01-01 00:00:00+00'),
  (:'L6', '+0 20 7946 0958',      '2020-01-01 00:00:00+00'),
  (:'L7', '+15555550384',         '2020-01-01 00:00:00+00'),
  (:'L8', null,                   '2020-01-01 00:00:00+00'),
  (:'L9', '1 (555) 123-4567',     '2020-01-01 00:00:00+00')
on conflict (family_id) do update set forward_to_phone = excluded.forward_to_phone, forward_to_phone_legacy = null, updated_at = excluded.updated_at;

\ir ../../supabase/migrations/0384_the_urgent_fallback_number_is_stored_the_only_way_it_can_be_used.sql

do $m13n$
declare
  r record;
  v text;
  kept text;
  ts timestamptz;
  n int;
  failures text[] := '{}';
  old_ts constant timestamptz := '2020-01-01 00:00:00+00';
begin
  for r in
    select * from (values
      ('00000000-0000-4000-8000-00000384e111'::uuid, '+1 555 123 4567',      '+15551234567', true,  'the field''s own placeholder: spacing removed'),
      ('00000000-0000-4000-8000-00000384e112'::uuid, '(555) 123-4567',       null,           true,  'ten digits with no country code: NOT read as +1'),
      ('00000000-0000-4000-8000-00000384e113'::uuid, '44 20 7946 0958',      null,           true,  'a country code without its plus is a guess, not a number'),
      ('00000000-0000-4000-8000-00000384e114'::uuid, 'Mom & Dad <555-0200>', null,           true,  'not a number'),
      ('00000000-0000-4000-8000-00000384e115'::uuid, 'call my cell',         null,           true,  'no digits at all'),
      ('00000000-0000-4000-8000-00000384e116'::uuid, '+0 20 7946 0958',      null,           true,  'a leading zero after the plus'),
      ('00000000-0000-4000-8000-00000384e117'::uuid, '+15555550384',         '+15555550384', false, 'already E.164'),
      ('00000000-0000-4000-8000-00000384e118'::uuid, null,                   null,           false, 'no fallback set'),
      ('00000000-0000-4000-8000-00000384e119'::uuid, '1 (555) 123-4567',     null,           true,  'eleven digits without the plus: NOT read as +1')
    ) as t(fam, legacy, expected, touched, why)
  loop
    select forward_to_phone, forward_to_phone_legacy, updated_at into v, kept, ts
      from public.family_contact_channels where family_id = r.fam;
    if v is distinct from r.expected then
      failures := array_append(failures, format('legacy %L (%s) became %L, expected %L', r.legacy, r.why, v, r.expected));
    end if;
    -- What 0384 replaced is kept beside the row — and only on rows it changed.
    if r.touched and kept is distinct from r.legacy then
      failures := array_append(failures, format('legacy %L (%s) was rewritten but forward_to_phone_legacy holds %L, not what the parent typed', r.legacy, r.why, kept));
    elsif not r.touched and kept is not null then
      failures := array_append(failures, format('%L (%s) was not changed, yet forward_to_phone_legacy holds %L', r.legacy, r.why, kept));
    end if;
    if r.touched and ts = old_ts then
      failures := array_append(failures, format('legacy %L (%s) was not rewritten (updated_at still %s)', r.legacy, r.why, ts));
    elsif not r.touched and ts <> old_ts then
      failures := array_append(failures, format('%L (%s) satisfied the contract but was rewritten anyway (updated_at %s)', r.legacy, r.why, ts));
    end if;
  end loop;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.family_contact_channels'::regclass
       and conname = 'family_contact_channels_forward_to_phone_e164'
       and contype = 'c' and convalidated
  ) then
    failures := array_append(failures, 'after 0384 ran, family_contact_channels_forward_to_phone_e164 is missing or NOT VALID');
  end if;

  -- The save the header says a legacy value would have blocked: the family
  -- whose "(555) 123-4567" was cleared (and kept in forward_to_phone_legacy)
  -- edits its concierge greeting, as the action does.
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  begin
    update public.family_contact_channels set ai_greeting = 'Hi, you have reached the family line.'
     where family_id = '00000000-0000-4000-8000-00000384e112';
    get diagnostics n = row_count;
    if n <> 1 then
      failures := array_append(failures, format('the normalized legacy family''s greeting save changed %s rows', n));
    end if;
  exception when others then
    failures := array_append(failures, format('the normalized legacy family could not save its greeting (%s: %s)', sqlstate, sqlerrm));
  end;

  if cardinality(failures) > 0 then
    raise exception 'm13 FAIL (0384''s normalize step):%', E'\n  ' || array_to_string(failures, E'\n  ');
  end if;
  raise notice 'm13: PART 2 OK — 0384 normalizes legacy fallback numbers as its header says, leaves valid rows untouched, and re-adds a validated constraint';
end
$m13n$;

rollback;
