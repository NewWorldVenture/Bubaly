\set ON_ERROR_STOP on
SET client_min_messages = warning;
SET timezone = 'UTC';
SET statement_timeout = '20s';
SET lock_timeout = '15s';

DO $$
BEGIN
  IF current_database() <> 'bubaly_travel_import_ci'
     OR current_user <> 'postgres'
     OR inet_server_addr() IS NOT NULL
     OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
  THEN
    RAISE EXCEPTION 'Disposable CI database required';
  END IF;
  IF to_regprocedure('public.vacation_import_confirmation(uuid,uuid,uuid,jsonb,jsonb,jsonb,uuid)') IS NULL
     OR to_regclass('public.vacation_confirmation_imports') IS NULL
  THEN
    RAISE EXCEPTION 'Apply the actual 0270 migration before this fixture';
  END IF;
END
$$;

CREATE SCHEMA travel_import_ci;
GRANT USAGE ON SCHEMA travel_import_ci TO authenticated, anon;
CREATE TABLE travel_import_ci.cases (
  key text PRIMARY KEY,
  family_id uuid NOT NULL DEFAULT '20000000-0000-4000-8000-000000000001',
  vacation_id uuid NOT NULL DEFAULT '40000000-0000-4000-8000-000000000001',
  member_id uuid NOT NULL DEFAULT '30000000-0000-4000-8000-000000000001',
  source jsonb NOT NULL,
  fields jsonb NOT NULL,
  expected jsonb,
  request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  expected_date text,
  expected_time text,
  expected_part text
);
CREATE TABLE travel_import_ci.receipts (
  key text PRIMARY KEY,
  payload jsonb NOT NULL,
  transaction_id bigint NOT NULL
);
CREATE TABLE travel_import_ci.observations (
  label text PRIMARY KEY,
  observer name NOT NULL,
  rows jsonb NOT NULL,
  attempts jsonb NOT NULL
);
CREATE TABLE travel_import_ci.retained (payload jsonb NOT NULL);
GRANT SELECT, UPDATE ON travel_import_ci.cases TO authenticated;
GRANT SELECT ON travel_import_ci.cases TO anon;
GRANT SELECT, INSERT ON travel_import_ci.receipts TO authenticated;
CREATE SEQUENCE travel_import_ci.dml_attempts;

CREATE FUNCTION travel_import_ci.assert(p_ok boolean, p_label text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Travel confirmation assertion: %', p_label;
  END IF;
END
$$;

-- This counter is deliberately nontransactional: previews and early denials
-- cannot conceal attempted application DML by rolling back their own writes.
CREATE FUNCTION travel_import_ci.count_attempt() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, travel_import_ci AS $$
BEGIN
  PERFORM nextval('travel_import_ci.dml_attempts');
  RETURN NULL;
END
$$;
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format(
      'CREATE TRIGGER travel_ci_dml_attempt BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION travel_import_ci.count_attempt()',
      t.tablename
    );
  END LOOP;
END
$$;

-- Every observation is a separate top-level statement, always as postgres.
-- No cached STABLE helper, role switching inside a comparison, or RLS-filtered
-- before/after view is used. Fixture bookkeeping lives outside public.
CREATE FUNCTION travel_import_ci.observe(p_label text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE
  t record;
  v_rows jsonb := '{}'::jsonb;
  v_table jsonb;
  v_attempts jsonb;
BEGIN
  PERFORM travel_import_ci.assert(current_user = 'postgres', 'snapshot observer must be postgres');
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename LOOP
    EXECUTE format(
      'SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), ''[]''::jsonb) FROM public.%I r',
      t.tablename
    ) INTO v_table;
    v_rows := v_rows || jsonb_build_object(t.tablename, v_table);
  END LOOP;
  SELECT jsonb_build_array(last_value, is_called)
    INTO v_attempts FROM travel_import_ci.dml_attempts;
  INSERT INTO travel_import_ci.observations VALUES (p_label, current_user, v_rows, v_attempts);
END
$$;

CREATE FUNCTION travel_import_ci.assert_same(p_before text, p_after text, p_no_attempts boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE a travel_import_ci.observations; b travel_import_ci.observations;
BEGIN
  SELECT * INTO STRICT a FROM travel_import_ci.observations WHERE label = p_before;
  SELECT * INTO STRICT b FROM travel_import_ci.observations WHERE label = p_after;
  PERFORM travel_import_ci.assert(current_user = 'postgres' AND a.observer = b.observer AND a.observer = 'postgres', 'consistent snapshot roles');
  PERFORM travel_import_ci.assert(a.rows = b.rows, p_after || ': all public rows unchanged');
  IF p_no_attempts THEN
    PERFORM travel_import_ci.assert(a.attempts = b.attempts, p_after || ': no attempted application DML');
  END IF;
END
$$;

CREATE FUNCTION travel_import_ci.assert_delta(p_before text, p_after text, p_added jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE a travel_import_ci.observations; b travel_import_ci.observations; t record; old_row jsonb;
BEGIN
  SELECT * INTO STRICT a FROM travel_import_ci.observations WHERE label = p_before;
  SELECT * INTO STRICT b FROM travel_import_ci.observations WHERE label = p_after;
  PERFORM travel_import_ci.assert(current_user = 'postgres' AND a.observer = b.observer AND a.observer = 'postgres', 'consistent delta roles');
  PERFORM travel_import_ci.assert(
    (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(a.rows) AS keys(key)) =
    (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(b.rows) AS keys(key)),
    'no public table appeared or disappeared'
  );
  FOR t IN SELECT key, value FROM jsonb_each(a.rows) LOOP
    PERFORM travel_import_ci.assert(
      jsonb_array_length(b.rows -> t.key) - jsonb_array_length(t.value) = coalesce((p_added ->> t.key)::integer, 0),
      'only prescribed rows added to ' || t.key
    );
    FOR old_row IN SELECT value FROM jsonb_array_elements(t.value) LOOP
      PERFORM travel_import_ci.assert(
        EXISTS (SELECT 1 FROM jsonb_array_elements(b.rows -> t.key) AS r(value) WHERE r.value = old_row),
        'every preexisting field preserved in ' || t.key
      );
    END LOOP;
  END LOOP;
END
$$;

CREATE FUNCTION travel_import_ci.invoke(p_key text, p_apply boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE c travel_import_ci.cases;
BEGIN
  SELECT * INTO STRICT c FROM travel_import_ci.cases WHERE key = p_key;
  RETURN public.vacation_import_confirmation(
    c.family_id, c.vacation_id, c.member_id, c.source, c.fields,
    CASE WHEN p_apply THEN c.expected ELSE NULL END,
    CASE WHEN p_apply THEN c.request_id ELSE NULL END
  );
END
$$;

CREATE FUNCTION travel_import_ci.expect_error(p_sql text, p_state text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE caught text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS caught = RETURNED_SQLSTATE;
    PERFORM travel_import_ci.assert(caught = p_state, 'exact denial SQLSTATE');
    RETURN;
  END;
  RAISE EXCEPTION 'Expected SQLSTATE %, but statement succeeded', p_state;
END
$$;

CREATE FUNCTION travel_import_ci.assert_hidden() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE n bigint;
BEGIN
  BEGIN
    SELECT count(*) INTO n FROM public.vacation_confirmation_imports;
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN;
  END;
  PERFORM travel_import_ci.assert(n = 0, 'source records hidden from this role/identity');
END
$$;

CREATE FUNCTION travel_import_ci.assert_preview(p_key text, p_result jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE c travel_import_ci.cases; t public.vacations; wanted jsonb;
BEGIN
  SELECT * INTO STRICT c FROM travel_import_ci.cases WHERE key = p_key;
  SELECT * INTO STRICT t FROM public.vacations WHERE id = c.vacation_id;
  wanted := jsonb_build_object(
    'version', 1, 'familyId', c.family_id, 'vacationId', c.vacation_id, 'memberId', c.member_id,
    'trip', jsonb_build_object('id', t.id, 'title', t.title, 'startDate', t.start_date,
      'endDate', t.end_date, 'timezone', t.timezone, 'status', t.status, 'updatedAt', t.updated_at),
    'source', jsonb_build_object('title', btrim(c.source ->> 'title'), 'text', c.source ->> 'text',
      'sha256', encode(public.digest(convert_to(c.source ->> 'text', 'UTF8'), 'sha256'), 'hex')),
    'fields', jsonb_build_object(
      'name', btrim(c.fields ->> 'name'), 'kind', btrim(c.fields ->> 'kind'),
      'location', btrim(c.fields ->> 'location'), 'reservedAt', c.fields ->> 'reservedAt',
      'partySize', c.fields -> 'partySize', 'confirmationCode', btrim(c.fields ->> 'confirmationCode'),
      'booked', c.fields -> 'booked'),
    'itinerary', jsonb_build_object('date', c.expected_date, 'startTime', c.expected_time, 'dayPart', c.expected_part)
  );
  PERFORM travel_import_ci.assert(
    p_result = jsonb_build_object('preview', wanted, 'applied', false,
      'requestId', NULL, 'appliedAt', NULL, 'reservationId', NULL, 'itineraryItemId', NULL),
    p_key || ': complete normalized preview and null receipt'
  );
END
$$;

CREATE FUNCTION travel_import_ci.assert_receipt(p_key text, p_result jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE c travel_import_ci.cases; r public.vacation_reservations;
  i public.vacation_itinerary_items; d public.vacation_itinerary_days;
  s public.vacation_confirmation_imports; f jsonb;
BEGIN
  SELECT * INTO STRICT c FROM travel_import_ci.cases WHERE key = p_key;
  SELECT * INTO STRICT s FROM public.vacation_confirmation_imports WHERE id = c.request_id;
  SELECT * INTO STRICT r FROM public.vacation_reservations WHERE id = (p_result ->> 'reservationId')::uuid;
  SELECT * INTO STRICT i FROM public.vacation_itinerary_items WHERE id = (p_result ->> 'itineraryItemId')::uuid;
  SELECT * INTO STRICT d FROM public.vacation_itinerary_days WHERE id = i.day_id;
  f := c.expected -> 'fields';
  PERFORM travel_import_ci.assert(
    p_result = jsonb_build_object('preview', c.expected, 'applied', true,
      'requestId', c.request_id, 'appliedAt', p_result -> 'appliedAt',
      'reservationId', s.reservation_id, 'itineraryItemId', s.itinerary_item_id),
    p_key || ': complete receipt'
  );
  PERFORM travel_import_ci.assert(
    jsonb_typeof(p_result -> 'appliedAt') = 'string'
    AND (p_result ->> 'appliedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
    AND (p_result ->> 'appliedAt')::timestamptz IS NOT NULL,
    p_key || ': database timestamp permits microsecond precision'
  );
  PERFORM travel_import_ci.assert(
    s.reviewed = c.expected AND s.receipt = p_result AND s.family_id = c.family_id
    AND s.vacation_id = c.vacation_id AND s.actor_member_id = c.member_id
    AND s.actor_user_id = auth.uid()
    AND s.source_text = c.source ->> 'text'
    AND s.source_title = btrim(c.source ->> 'title')
    AND s.source_sha256 = c.expected #>> '{source,sha256}',
    p_key || ': source and review stored exactly'
  );
  PERFORM travel_import_ci.assert(
    r.family_id = c.family_id AND r.vacation_id = c.vacation_id AND r.created_by = auth.uid()
    AND r.name = f ->> 'name' AND r.kind = f ->> 'kind'
    AND r.location IS NOT DISTINCT FROM f ->> 'location'
    AND r.reserved_at = (f ->> 'reservedAt')::timestamptz
    AND r.party_size IS NOT DISTINCT FROM (f ->> 'partySize')::integer
    AND r.confirmation_code IS NOT DISTINCT FROM f ->> 'confirmationCode'
    AND r.booked = (f ->> 'booked')::boolean AND r.cost_cents IS NULL,
    p_key || ': reservation fields and actor'
  );
  PERFORM travel_import_ci.assert(
    i.family_id = c.family_id AND i.vacation_id = c.vacation_id AND i.created_by = auth.uid()
    AND i.kind = 'reservation' AND i.title = f ->> 'name'
    AND i.location IS NOT DISTINCT FROM f ->> 'location'
    AND i.confirmation_code IS NOT DISTINCT FROM f ->> 'confirmationCode'
    AND i.booked = (f ->> 'booked')::boolean
    AND i.start_time = (c.expected #>> '{itinerary,startTime}')::time
    AND i.day_part::text = c.expected #>> '{itinerary,dayPart}'
    AND i.end_time IS NULL AND i.duration_min IS NULL AND i.cost_cents IS NULL
    AND d.family_id = c.family_id AND d.vacation_id = c.vacation_id
    AND d.day_date = (c.expected #>> '{itinerary,date}')::date,
    p_key || ': itinerary wallclock, linkage, and no invented duration/cost'
  );
  PERFORM travel_import_ci.assert(
    position(c.request_id::text IN coalesce(r.notes, '')) > 0
    AND position(c.request_id::text IN coalesce(i.notes, '')) > 0
    AND r.notes ~* 'user[ -]confirmed' AND i.notes ~* 'user[ -]confirmed'
    AND r.notes ~* '(not|no)[ -]+(provider[ -]+)?verif'
    AND i.notes ~* '(not|no)[ -]+(provider[ -]+)?verif',
    p_key || ': notes link evidence without claiming provider verification'
  );
END
$$;

INSERT INTO public.vacations(
  id, family_id, title, kind, status, destination, start_date, end_date, timezone,
  cover_image_url, description, budget_cents, currency, is_international, notes, created_by, updated_at
) VALUES (
  '40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
  'CI original trip', 'road_trip', 'planning', 'Existing destination',
  '2026-09-06', '2026-09-08', 'America/Los_Angeles', 'ci-only-cover',
  'Preserve description', 123456, 'CAD', true, 'Preserve trip notes',
  '10000000-0000-4000-8000-000000000001', '2026-09-01T12:00:00.123456Z'
);
INSERT INTO public.vacations(id, family_id, title, start_date, end_date, timezone)
SELECT ('40000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  CASE WHEN n = 2 THEN '20000000-0000-4000-8000-000000000002'::uuid
       ELSE '20000000-0000-4000-8000-000000000001'::uuid END,
  'Synthetic CI trip ' || n, '2026-09-06'::date, '2026-09-08'::date, 'UTC'
FROM generate_series(2, 17) AS n;
UPDATE public.vacations SET start_date = '2026-11-01', end_date = '2026-11-01', timezone = 'America/New_York'
WHERE id = '40000000-0000-4000-8000-000000000005';
UPDATE public.vacations SET start_date = '2026-03-08', end_date = '2026-03-08', timezone = 'America/New_York'
WHERE id = '40000000-0000-4000-8000-000000000006';
UPDATE public.vacations SET start_date = '2028-02-29', end_date = '2028-02-29'
WHERE id = '40000000-0000-4000-8000-000000000007';
UPDATE public.vacations SET start_date = '0001-01-01', end_date = '0001-01-02'
WHERE id = '40000000-0000-4000-8000-000000000008';
UPDATE public.vacations SET start_date = '9999-12-30', end_date = '9999-12-31'
WHERE id = '40000000-0000-4000-8000-000000000009';
UPDATE public.vacations SET timezone = NULL WHERE id = '40000000-0000-4000-8000-000000000010';
UPDATE public.vacations SET timezone = 'CI/Invalid_Zone' WHERE id = '40000000-0000-4000-8000-000000000011';
UPDATE public.vacations SET start_date = NULL WHERE id = '40000000-0000-4000-8000-000000000012';
UPDATE public.vacations SET end_date = NULL WHERE id = '40000000-0000-4000-8000-000000000013';
UPDATE public.vacations SET start_date = '2026-09-09' WHERE id = '40000000-0000-4000-8000-000000000014';
UPDATE public.vacations SET status = 'cancelled' WHERE id = '40000000-0000-4000-8000-000000000015';
-- UTC is in range but the local date crosses the supported year boundary.
UPDATE public.vacations SET timezone = 'Etc/GMT+12' WHERE id = '40000000-0000-4000-8000-000000000008';
UPDATE public.vacations SET timezone = 'Pacific/Kiritimati' WHERE id = '40000000-0000-4000-8000-000000000009';

INSERT INTO public.vacation_itinerary_days(id, family_id, vacation_id, day_date, title, summary, created_by)
VALUES ('50000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001', '2026-09-06', 'Existing day title', 'Existing day summary',
  '10000000-0000-4000-8000-000000000001');
INSERT INTO public.vacation_reservations(
  id, family_id, vacation_id, kind, name, location, reserved_at, party_size,
  confirmation_code, cost_cents, booked, notes, created_by
) VALUES ('60000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001', 'existing-kind', 'Existing reservation', 'Existing place',
  '2026-09-06T16:00:00Z', 7, 'CI-EXISTING', 9876, true, 'Existing reservation notes',
  '10000000-0000-4000-8000-000000000001');
INSERT INTO public.vacation_itinerary_items(
  id, family_id, vacation_id, day_id, kind, day_part, title, location, start_time,
  end_time, duration_min, cost_cents, booked, confirmation_code, notes, member_ids, sort_order, created_by
) VALUES ('70000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001',
  'activity', 'all_day', 'Existing item', 'Existing item place', '09:00', '10:30', 90, 4321,
  true, 'CI-OLD-ITEM', 'Existing item notes', ARRAY['30000000-0000-4000-8000-000000000002'::uuid], 41,
  '10000000-0000-4000-8000-000000000002');
INSERT INTO public.vacation_budgets(family_id, vacation_id, category, planned_cents, notes)
VALUES ('20000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'food', 7654, 'Existing budget');
-- 0070 permits this owner-created inconsistency; import must not reuse it.
INSERT INTO public.vacation_itinerary_days(family_id, vacation_id, day_date, title)
VALUES ('20000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000017',
  '2026-09-06', 'Wrong-family synthetic day');

INSERT INTO travel_import_ci.cases(key, source, fields, request_id, expected_date, expected_time, expected_part)
VALUES ('main',
  jsonb_build_object('title', '  CI confirmation  ',
    'text', E'  CI ONLY\r\nName: Uncorrected source name\r\nBooked: YES\r\nCode: ORIGINAL-CI\r\n' || chr(233) || E'\r\n  '),
  '{"name":"  Reviewed corrected dinner  ","kind":" dining ","location":"  Reviewed location  ","reservedAt":"2026-09-07T01:30:00.999Z","partySize":4,"confirmationCode":" REVIEWED-CI ","booked":false}',
  '80000000-0000-4000-8000-000000000001', '2026-09-06', '18:30:00', 'evening');
INSERT INTO travel_import_ci.cases(key, source, fields, expected_date, expected_time, expected_part)
SELECT 'pending', source || '{"text":"CI ONLY pending distinct source"}', fields,
  expected_date, expected_time, expected_part FROM travel_import_ci.cases WHERE key = 'main';
INSERT INTO travel_import_ci.cases(key, source, fields, vacation_id, member_id, expected_date, expected_time, expected_part)
SELECT 'adult', source || '{"text":"CI ONLY adult distinct source"}',
  fields || '{"booked":true,"location":null,"partySize":null,"confirmationCode":null}',
  vacation_id, '30000000-0000-4000-8000-000000000002',
  expected_date, expected_time, expected_part FROM travel_import_ci.cases WHERE key = 'main';
INSERT INTO travel_import_ci.cases(key, family_id, vacation_id, member_id, source, fields, expected_date, expected_time, expected_part)
SELECT 'other-family', '20000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000004', source || '{"text":"CI ONLY family B source"}', fields,
  '2026-09-07', '01:30:00', 'morning' FROM travel_import_ci.cases WHERE key = 'main';
INSERT INTO travel_import_ci.cases(key, vacation_id, source, fields, expected_date, expected_time, expected_part)
SELECT 'wrong-day', '40000000-0000-4000-8000-000000000017', source || '{"text":"CI ONLY wrong-family day source"}',
  fields || '{"reservedAt":"2026-09-06T12:00:00Z"}', '2026-09-06', '12:00:00', 'afternoon'
FROM travel_import_ci.cases WHERE key = 'main';
INSERT INTO travel_import_ci.cases(key, vacation_id, source, fields, request_id, expected_date, expected_time, expected_part)
SELECT 'rollback', '40000000-0000-4000-8000-000000000004', source || '{"text":"CI ONLY deferred rollback source"}',
  fields || '{"reservedAt":"2026-09-07T12:00:00Z"}', '80000000-0000-4000-8000-000000000004',
  '2026-09-07', '12:00:00', 'afternoon' FROM travel_import_ci.cases WHERE key = 'main';
INSERT INTO travel_import_ci.cases(key, vacation_id, source, fields, request_id, expected_date, expected_time, expected_part)
SELECT 'concurrent', '40000000-0000-4000-8000-000000000003', source || '{"text":"CI ONLY simultaneous request source"}',
  fields || '{"reservedAt":"2026-09-07T12:00:00Z"}', '80000000-0000-4000-8000-000000000003',
  '2026-09-07', '12:00:00', 'afternoon' FROM travel_import_ci.cases WHERE key = 'main';

INSERT INTO travel_import_ci.cases(key, vacation_id, source, fields, expected_date, expected_time, expected_part)
SELECT b.key, ('40000000-0000-4000-8000-' || lpad(b.trip::text, 12, '0'))::uuid,
  c.source, c.fields || jsonb_build_object('reservedAt', b.instant), b.day, b.wallclock, b.part
FROM travel_import_ci.cases c CROSS JOIN (VALUES
  ('first-inclusive', 1, '2026-09-06T07:00:00Z', '2026-09-06', '00:00:00', 'morning'),
  ('last-inclusive', 1, '2026-09-09T06:59:59.999Z', '2026-09-08', '23:59:59', 'evening'),
  ('before-noon', 1, '2026-09-06T18:59:59.999Z', '2026-09-06', '11:59:59', 'morning'),
  ('at-noon', 1, '2026-09-06T19:00:00Z', '2026-09-06', '12:00:00', 'afternoon'),
  ('before-evening', 1, '2026-09-06T23:59:59.999Z', '2026-09-06', '16:59:59', 'afternoon'),
  ('at-evening', 1, '2026-09-07T00:00:00Z', '2026-09-06', '17:00:00', 'evening'),
  ('offset-plus14', 1, '2026-09-07T00:00:00+14:00', '2026-09-06', '03:00:00', 'morning'),
  ('offset-minus14', 1, '2026-09-06T00:00:00-14:00', '2026-09-06', '07:00:00', 'morning'),
  ('fraction-one', 1, '2026-09-07T01:30:00.9-00:00', '2026-09-06', '18:30:00', 'evening'),
  ('fraction-two', 1, '2026-09-07T01:30:00.99+00:00', '2026-09-06', '18:30:00', 'evening'),
  ('dst-first-fold', 5, '2026-11-01T01:30:00-04:00', '2026-11-01', '01:30:00', 'morning'),
  ('dst-second-fold', 5, '2026-11-01T01:30:00-05:00', '2026-11-01', '01:30:00', 'morning'),
  ('dst-spring', 6, '2026-03-08T07:00:00Z', '2026-03-08', '03:00:00', 'morning'),
  ('leap-day', 7, '2028-02-29T23:59:59.999Z', '2028-02-29', '23:59:59', 'evening'),
  ('year-one', 8, '0001-01-01T12:00:00Z', '0001-01-01', '00:00:00', 'morning'),
  ('year-last', 9, '9999-12-31T09:59:59.999Z', '9999-12-31', '23:59:59', 'evening')
) AS b(key, trip, instant, day, wallclock, part) WHERE c.key = 'main';

-- Parent/adult preview assertions include all six-digit DB updatedAt precision.
SELECT travel_import_ci.observe('preview-before');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
DO $$
DECLARE c record; result jsonb;
BEGIN
  FOR c IN SELECT key FROM travel_import_ci.cases WHERE key NOT IN ('adult', 'other-family') LOOP
    result := travel_import_ci.invoke(c.key);
    PERFORM travel_import_ci.assert_preview(c.key, result);
    UPDATE travel_import_ci.cases SET expected = result -> 'preview' WHERE key = c.key;
  END LOOP;
END
$$;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', false);
SELECT travel_import_ci.assert_preview('adult', travel_import_ci.invoke('adult'));
UPDATE travel_import_ci.cases SET expected = travel_import_ci.invoke('adult') -> 'preview' WHERE key = 'adult';
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', false);
SELECT travel_import_ci.assert_preview('other-family', travel_import_ci.invoke('other-family'));
UPDATE travel_import_ci.cases SET expected = travel_import_ci.invoke('other-family') -> 'preview' WHERE key = 'other-family';
RESET ROLE;
SELECT travel_import_ci.observe('preview-after');
SELECT travel_import_ci.assert_same('preview-before', 'preview-after', true);

-- The first save really commits before a later connection/transaction replays it.
SELECT travel_import_ci.observe('main-before');
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
INSERT INTO travel_import_ci.receipts VALUES ('main', travel_import_ci.invoke('main', true), txid_current());
SELECT travel_import_ci.assert_receipt('main', payload) FROM travel_import_ci.receipts WHERE key = 'main';
COMMIT;
SELECT travel_import_ci.observe('main-after');
SELECT travel_import_ci.assert_delta('main-before', 'main-after',
  '{"vacation_confirmation_imports":1,"vacation_reservations":1,"vacation_itinerary_items":1}');
INSERT INTO travel_import_ci.retained SELECT to_jsonb(s) FROM public.vacation_confirmation_imports s
WHERE id = '80000000-0000-4000-8000-000000000001';

UPDATE public.vacations SET title = 'CI changed after commit', status = 'cancelled',
  timezone = 'America/New_York', end_date = '2026-09-09'
WHERE id = '40000000-0000-4000-8000-000000000001';
SELECT travel_import_ci.observe('replay-before');
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
INSERT INTO travel_import_ci.receipts VALUES ('main-replay', travel_import_ci.invoke('main', true), txid_current());
COMMIT;
SELECT travel_import_ci.observe('replay-after');
SELECT travel_import_ci.assert_same('replay-before', 'replay-after', true);
SELECT travel_import_ci.assert(a.payload = b.payload AND a.transaction_id <> b.transaction_id,
  'committed retry returns original complete receipt despite changed/cancelled trip')
FROM travel_import_ci.receipts a JOIN travel_import_ci.receipts b ON b.key = 'main-replay' WHERE a.key = 'main';
UPDATE public.vacations SET title = 'CI original trip', status = 'planning',
  timezone = 'America/Los_Angeles', end_date = '2026-09-08'
WHERE id = '40000000-0000-4000-8000-000000000001';

-- Corrections/deletion of children do not replace the reviewed source/receipt.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
UPDATE public.vacation_reservations SET name = 'CI later corrected reservation',
  location = 'CI corrected place', party_size = 9, confirmation_code = 'CI-LATER', booked = true
WHERE id = (SELECT (payload ->> 'reservationId')::uuid FROM travel_import_ci.receipts WHERE key = 'main');
UPDATE public.vacation_itinerary_items SET title = 'CI later corrected item', start_time = '19:45:00', booked = true
WHERE id = (SELECT (payload ->> 'itineraryItemId')::uuid FROM travel_import_ci.receipts WHERE key = 'main');
COMMIT;
SELECT travel_import_ci.assert(to_jsonb(s) = r.payload, 'source and original reviewed receipt survive field corrections')
FROM public.vacation_confirmation_imports s CROSS JOIN travel_import_ci.retained r
WHERE s.id = '80000000-0000-4000-8000-000000000001';
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
DELETE FROM public.vacation_reservations
WHERE id = (SELECT (payload ->> 'reservationId')::uuid FROM travel_import_ci.receipts WHERE key = 'main');
DELETE FROM public.vacation_itinerary_items
WHERE id = (SELECT (payload ->> 'itineraryItemId')::uuid FROM travel_import_ci.receipts WHERE key = 'main');
COMMIT;
SELECT travel_import_ci.assert(
  (SELECT count(*) FROM public.vacation_confirmation_imports WHERE id = '80000000-0000-4000-8000-000000000001') = 1,
  'source row retained after child deletion');
SELECT travel_import_ci.assert(
  (to_jsonb(s) - 'reservation_id' - 'itinerary_item_id') = (r.payload - 'reservation_id' - 'itinerary_item_id'),
  'source, reviewed fields, and receipt retained independently of children')
FROM public.vacation_confirmation_imports s CROSS JOIN travel_import_ci.retained r
WHERE s.id = '80000000-0000-4000-8000-000000000001';
SELECT travel_import_ci.observe('deleted-replay-before');
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
INSERT INTO travel_import_ci.receipts VALUES ('deleted-replay', travel_import_ci.invoke('main', true), txid_current());
COMMIT;
SELECT travel_import_ci.observe('deleted-replay-after');
SELECT travel_import_ci.assert_same('deleted-replay-before', 'deleted-replay-after', true);
SELECT travel_import_ci.assert(a.payload = b.payload, 'deleted children do not change retry receipt')
FROM travel_import_ci.receipts a JOIN travel_import_ci.receipts b ON b.key = 'deleted-replay' WHERE a.key = 'main';

-- Another request cannot import the identical original text, even after edits
-- and child deletion. The same global request cannot be rebound to new inputs.
INSERT INTO travel_import_ci.cases(key, family_id, vacation_id, member_id, source, fields)
SELECT 'duplicate-source', family_id, vacation_id, member_id,
  source || '{"title":"A new title does not change original text identity"}',
  fields || '{"name":"Different reviewed name","booked":true}'
FROM travel_import_ci.cases WHERE key = 'main';
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
UPDATE travel_import_ci.cases SET expected = travel_import_ci.invoke(key) -> 'preview'
WHERE key IN ('duplicate-source', 'pending');
RESET ROLE;
INSERT INTO travel_import_ci.cases(key, source, fields, expected, request_id)
SELECT 'request-collision', source, fields, expected, '80000000-0000-4000-8000-000000000001'
FROM travel_import_ci.cases WHERE key = 'pending';
SELECT travel_import_ci.observe('duplicates-before');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('duplicate-source', true)$sql$, '23505');
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('request-collision', true)$sql$, '23505');
RESET ROLE;
SELECT travel_import_ci.observe('duplicates-after');
SELECT travel_import_ci.assert_same('duplicates-before', 'duplicates-after');

-- A second authorized actor and a different family also cannot claim a used
-- global request ID. Their own valid previews avoid relying on malformed scope.
UPDATE travel_import_ci.cases SET request_id = '80000000-0000-4000-8000-000000000001'
WHERE key IN ('adult', 'other-family');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', false);
UPDATE travel_import_ci.cases SET expected = travel_import_ci.invoke('adult') -> 'preview' WHERE key = 'adult';
RESET ROLE;
SELECT travel_import_ci.observe('actor-collisions-before');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', false);
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('adult', true)$sql$, '23505');
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', false);
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('other-family', true)$sql$, '23505');
SELECT travel_import_ci.assert_hidden();
RESET ROLE;
SELECT travel_import_ci.observe('actor-collisions-after');
SELECT travel_import_ci.assert_same('actor-collisions-before', 'actor-collisions-after');
UPDATE travel_import_ci.cases SET request_id = gen_random_uuid() WHERE key IN ('adult', 'other-family');

SELECT travel_import_ci.observe('adult-before');
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
INSERT INTO travel_import_ci.receipts VALUES ('adult', travel_import_ci.invoke('adult', true), txid_current());
SELECT travel_import_ci.assert_receipt('adult', payload) FROM travel_import_ci.receipts WHERE key = 'adult';
COMMIT;
SELECT travel_import_ci.observe('adult-after');
SELECT travel_import_ci.assert_delta('adult-before', 'adult-after',
  '{"vacation_confirmation_imports":1,"vacation_reservations":1,"vacation_itinerary_items":1}');

-- Fresh authorization is mandatory even for a previously committed request.
UPDATE public.family_members SET is_active = false WHERE id = '30000000-0000-4000-8000-000000000001';
SELECT travel_import_ci.observe('inactive-before');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('pending')$sql$, '42501');
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('pending', true)$sql$, '42501');
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('main', true)$sql$, '42501');
SELECT travel_import_ci.assert_hidden();
RESET ROLE;
SELECT travel_import_ci.observe('inactive-after');
SELECT travel_import_ci.assert_same('inactive-before', 'inactive-after', true);
UPDATE public.family_members SET is_active = true WHERE id = '30000000-0000-4000-8000-000000000001';

UPDATE public.family_members SET role = 'teen' WHERE id = '30000000-0000-4000-8000-000000000001';
SELECT travel_import_ci.observe('teen-before');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('pending')$sql$, '42501');
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('pending', true)$sql$, '42501');
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('main', true)$sql$, '42501');
SELECT travel_import_ci.assert_hidden();
RESET ROLE;
SELECT travel_import_ci.observe('teen-after');
SELECT travel_import_ci.assert_same('teen-before', 'teen-after', true);
UPDATE public.family_members SET role = 'parent' WHERE id = '30000000-0000-4000-8000-000000000001';

UPDATE public.family_members SET role = 'child' WHERE id = '30000000-0000-4000-8000-000000000001';
SELECT travel_import_ci.observe('child-before');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('pending')$sql$, '42501');
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('pending', true)$sql$, '42501');
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('main', true)$sql$, '42501');
SELECT travel_import_ci.assert_hidden();
RESET ROLE;
SELECT travel_import_ci.observe('child-after');
SELECT travel_import_ci.assert_same('child-before', 'child-after', true);
UPDATE public.family_members SET role = 'parent' WHERE id = '30000000-0000-4000-8000-000000000001';

UPDATE public.family_members SET role = 'caregiver' WHERE id = '30000000-0000-4000-8000-000000000001';
SELECT travel_import_ci.observe('caregiver-before');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('pending')$sql$, '42501');
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('pending', true)$sql$, '42501');
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('main', true)$sql$, '42501');
SELECT travel_import_ci.assert_hidden();
RESET ROLE;
SELECT travel_import_ci.observe('caregiver-after');
SELECT travel_import_ci.assert_same('caregiver-before', 'caregiver-after', true);
UPDATE public.family_members SET role = 'parent' WHERE id = '30000000-0000-4000-8000-000000000001';

UPDATE public.family_members SET role = 'guest' WHERE id = '30000000-0000-4000-8000-000000000001';
SELECT travel_import_ci.observe('guest-before');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('pending')$sql$, '42501');
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('pending', true)$sql$, '42501');
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('main', true)$sql$, '42501');
SELECT travel_import_ci.assert_hidden();
RESET ROLE;
SELECT travel_import_ci.observe('guest-after');
SELECT travel_import_ci.assert_same('guest-before', 'guest-after', true);
UPDATE public.family_members SET role = 'parent' WHERE id = '30000000-0000-4000-8000-000000000001';

-- Exact member/user/family bindings; a parent in A is only a child in B.
SELECT travel_import_ci.observe('scope-before');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('adult')$sql$, '42501');
SELECT travel_import_ci.expect_error($sql$
  SELECT public.vacation_import_confirmation(
    '20000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000001', source, fields, NULL, NULL)
  FROM travel_import_ci.cases WHERE key = 'main'
$sql$, '42501');
SELECT travel_import_ci.expect_error($sql$
  SELECT public.vacation_import_confirmation(
    '20000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000006', source, fields, NULL, NULL)
  FROM travel_import_ci.cases WHERE key = 'main'
$sql$, '42501');
SELECT travel_import_ci.expect_error($sql$
  SELECT public.vacation_import_confirmation(
    family_id, vacation_id, '30000000-0000-4000-8000-000000000099', source, fields, NULL, NULL)
  FROM travel_import_ci.cases WHERE key = 'main'
$sql$, '42501');
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', false);
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('pending')$sql$, '42501');
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('main', true)$sql$, '42501');
SELECT travel_import_ci.assert_hidden();
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000006', false);
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('pending')$sql$, '42501');
SELECT travel_import_ci.assert_hidden();
SELECT set_config('request.jwt.claim.sub', '', false);
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('pending')$sql$, '42501');
SELECT travel_import_ci.assert_hidden();
RESET ROLE;
SET ROLE anon;
SELECT set_config('request.jwt.claim.sub', '', false);
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('pending')$sql$, '42501');
SELECT travel_import_ci.assert_hidden();
RESET ROLE;
SELECT travel_import_ci.observe('scope-after');
SELECT travel_import_ci.assert_same('scope-before', 'scope-after', true);

-- Application roles must not INSERT, UPDATE, DELETE, or TRUNCATE source records.
SELECT travel_import_ci.assert(
  NOT has_table_privilege('authenticated', 'public.vacation_confirmation_imports', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  AND NOT has_table_privilege('anon', 'public.vacation_confirmation_imports', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  'source direct-write grants revoked');
SELECT travel_import_ci.assert(
  NOT EXISTS (
    SELECT 1 FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS a
    WHERE c.oid = 'public.vacation_confirmation_imports'::regclass AND a.grantee = 0
      AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  ), 'PUBLIC has no direct source-write grant');
SELECT travel_import_ci.observe('direct-write-before');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
SELECT travel_import_ci.assert((SELECT count(*) FROM public.vacation_confirmation_imports) = 2,
  'active parent can read retained source rows');
SELECT travel_import_ci.expect_error($sql$INSERT INTO public.vacation_confirmation_imports SELECT * FROM public.vacation_confirmation_imports$sql$, '42501');
SELECT travel_import_ci.expect_error($sql$UPDATE public.vacation_confirmation_imports SET source_text = 'CI forbidden replacement'$sql$, '42501');
SELECT travel_import_ci.expect_error($sql$DELETE FROM public.vacation_confirmation_imports$sql$, '42501');
SELECT travel_import_ci.expect_error($sql$TRUNCATE public.vacation_confirmation_imports$sql$, '42501');
RESET ROLE;
SET ROLE anon;
SELECT set_config('request.jwt.claim.sub', '', false);
SELECT travel_import_ci.expect_error($sql$INSERT INTO public.vacation_confirmation_imports SELECT * FROM public.vacation_confirmation_imports$sql$, '42501');
SELECT travel_import_ci.expect_error($sql$UPDATE public.vacation_confirmation_imports SET source_text = 'CI forbidden replacement'$sql$, '42501');
SELECT travel_import_ci.expect_error($sql$DELETE FROM public.vacation_confirmation_imports$sql$, '42501');
SELECT travel_import_ci.expect_error($sql$TRUNCATE public.vacation_confirmation_imports$sql$, '42501');
RESET ROLE;
SELECT travel_import_ci.observe('direct-write-after');
SELECT travel_import_ci.assert_same('direct-write-before', 'direct-write-after', true);

-- Valid maximum character/byte lengths, optional nulls, and explicit booked.
INSERT INTO travel_import_ci.cases(key, source, fields, expected_date, expected_time, expected_part)
SELECT 'maximum-valid',
  jsonb_build_object('title', repeat('T', 160), 'text', repeat(chr(233), 32768)),
  fields || jsonb_build_object('name', repeat('N', 200), 'kind', repeat('K', 40),
    'location', repeat('L', 500), 'confirmationCode', repeat('C', 120), 'partySize', 1000),
  expected_date, expected_time, expected_part FROM travel_import_ci.cases WHERE key = 'main';
INSERT INTO travel_import_ci.cases(key, source, fields, expected_date, expected_time, expected_part)
SELECT 'minimum-valid', '{"title":"T","text":"x"}', fields || '{"partySize":1,"name":"N","kind":"K"}',
  expected_date, expected_time, expected_part FROM travel_import_ci.cases WHERE key = 'main';
SELECT travel_import_ci.observe('length-preview-before');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
SELECT travel_import_ci.assert_preview('maximum-valid', travel_import_ci.invoke('maximum-valid'));
SELECT travel_import_ci.assert_preview('minimum-valid', travel_import_ci.invoke('minimum-valid'));
RESET ROLE;
SELECT travel_import_ci.observe('length-preview-after');
SELECT travel_import_ci.assert_same('length-preview-before', 'length-preview-after', true);

CREATE TABLE travel_import_ci.invalid_fields (label text PRIMARY KEY, fields jsonb NOT NULL);
INSERT INTO travel_import_ci.invalid_fields
SELECT v.label, c.fields || jsonb_build_object('reservedAt', v.instant)
FROM travel_import_ci.cases c CROSS JOIN (VALUES
  ('before-start', '2026-09-06T06:59:59.999Z'),
  ('after-end', '2026-09-09T07:00:00Z'),
  ('no-seconds', '2026-09-07T01:30Z'),
  ('no-offset', '2026-09-07T01:30:00'),
  ('too-many-fractions', '2026-09-07T01:30:00.1234Z'),
  ('offset-above14', '2026-09-07T01:30:00+14:01'),
  ('offset-below-minus14', '2026-09-07T01:30:00-14:01'),
  ('offset15', '2026-09-07T01:30:00+15:00'),
  ('compact-offset', '2026-09-07T01:30:00+0000'),
  ('offset-seconds', '2026-09-07T01:30:00+00:00:00'),
  ('space-separator', '2026-09-07 01:30:00Z'),
  ('invalid-leap', '2026-02-29T01:30:00Z'),
  ('invalid-day', '2026-04-31T01:30:00Z'),
  ('invalid-month', '2026-13-01T01:30:00Z'),
  ('hour24', '2026-09-06T24:00:00Z'),
  ('second60', '2026-09-07T01:30:60Z'),
  ('year-zero', '0000-09-07T01:30:00Z'),
  ('year10000', '10000-09-07T01:30:00Z'),
  ('date-only', '2026-09-07'),
  ('relative-time', 'tomorrow'),
  ('infinity', 'infinity')
) AS v(label, instant) WHERE c.key = 'main';
INSERT INTO travel_import_ci.invalid_fields
SELECT v.label, c.fields || v.change
FROM travel_import_ci.cases c CROSS JOIN (VALUES
  ('empty-name', '{"name":"   "}'::jsonb),
  ('name-number', '{"name":5}'::jsonb),
  ('empty-kind', '{"kind":"  "}'::jsonb),
  ('null-date', '{"reservedAt":null}'::jsonb),
  ('party-zero', '{"partySize":0}'::jsonb),
  ('party1001', '{"partySize":1001}'::jsonb),
  ('party-fraction', '{"partySize":1.5}'::jsonb),
  ('party-string', '{"partySize":"4"}'::jsonb),
  ('booked-string', '{"booked":"true"}'::jsonb),
  ('booked-null', '{"booked":null}'::jsonb),
  ('location-number', '{"location":7}'::jsonb),
  ('code-number', '{"confirmationCode":7}'::jsonb)
) AS v(label, change) WHERE c.key = 'main';
INSERT INTO travel_import_ci.invalid_fields
SELECT 'missing-booked', fields - 'booked' FROM travel_import_ci.cases WHERE key = 'main'
UNION ALL SELECT 'long-name', fields || jsonb_build_object('name', repeat('N', 201)) FROM travel_import_ci.cases WHERE key = 'main'
UNION ALL SELECT 'long-kind', fields || jsonb_build_object('kind', repeat('K', 41)) FROM travel_import_ci.cases WHERE key = 'main'
UNION ALL SELECT 'long-location', fields || jsonb_build_object('location', repeat('L', 501)) FROM travel_import_ci.cases WHERE key = 'main'
UNION ALL SELECT 'long-code', fields || jsonb_build_object('confirmationCode', repeat('C', 121)) FROM travel_import_ci.cases WHERE key = 'main';
CREATE TABLE travel_import_ci.invalid_sources (label text PRIMARY KEY, source jsonb NOT NULL);
INSERT INTO travel_import_ci.invalid_sources VALUES
  ('blank-title', '{"title":"  ","text":"CI source"}'),
  ('empty-text', '{"title":"CI","text":""}'),
  ('numeric-text', '{"title":"CI","text":42}'),
  ('null-text', '{"title":"CI","text":null}'),
  ('missing-text', '{"title":"CI"}'),
  ('source-array', '[]');
INSERT INTO travel_import_ci.invalid_sources VALUES
  ('long-title', jsonb_build_object('title', repeat('T', 161), 'text', 'CI')),
  ('character-limit', jsonb_build_object('title', 'CI', 'text', repeat('x', 32769))),
  ('byte-limit', jsonb_build_object('title', 'CI', 'text', repeat(chr(128512), 17000)));
GRANT SELECT ON travel_import_ci.invalid_fields, travel_import_ci.invalid_sources TO authenticated;
SELECT travel_import_ci.observe('invalid-before');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
DO $$
DECLARE v record; c travel_import_ci.cases;
BEGIN
  SELECT * INTO STRICT c FROM travel_import_ci.cases WHERE key = 'main';
  FOR v IN SELECT * FROM travel_import_ci.invalid_fields LOOP
    PERFORM travel_import_ci.expect_error(format(
      'SELECT public.vacation_import_confirmation(%L::uuid,%L::uuid,%L::uuid,%L::jsonb,%L::jsonb,NULL,NULL)',
      c.family_id, c.vacation_id, c.member_id, c.source, v.fields), '22023');
  END LOOP;
  FOR v IN SELECT * FROM travel_import_ci.invalid_sources LOOP
    PERFORM travel_import_ci.expect_error(format(
      'SELECT public.vacation_import_confirmation(%L::uuid,%L::uuid,%L::uuid,%L::jsonb,%L::jsonb,NULL,NULL)',
      c.family_id, c.vacation_id, c.member_id, v.source, c.fields), '22023');
  END LOOP;
END
$$;
SELECT travel_import_ci.expect_error($sql$
  SELECT public.vacation_import_confirmation(family_id, vacation_id, member_id, source, fields, expected, NULL)
  FROM travel_import_ci.cases WHERE key = 'pending'
$sql$, '22023');
SELECT travel_import_ci.expect_error($sql$
  SELECT public.vacation_import_confirmation(family_id, vacation_id, member_id, source, fields, NULL, request_id)
  FROM travel_import_ci.cases WHERE key = 'pending'
$sql$, '22023');
RESET ROLE;
SELECT travel_import_ci.observe('invalid-after');
SELECT travel_import_ci.assert_same('invalid-before', 'invalid-after', true);

-- UTC and local trip-day range are independently checked, including offsets.
SELECT travel_import_ci.observe('year-denials-before');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
DO $$
DECLARE v record; c travel_import_ci.cases;
BEGIN
  SELECT * INTO STRICT c FROM travel_import_ci.cases WHERE key = 'main';
  FOR v IN SELECT * FROM (VALUES
    ('40000000-0000-4000-8000-000000000008'::uuid, '0001-01-01T00:00:00+14:00'),
    ('40000000-0000-4000-8000-000000000009'::uuid, '9999-12-31T23:59:59-14:00'),
    ('40000000-0000-4000-8000-000000000008'::uuid, '0001-01-01T00:00:00Z'),
    ('40000000-0000-4000-8000-000000000009'::uuid, '9999-12-31T23:59:59Z')
  ) AS cases(trip, instant) LOOP
    PERFORM travel_import_ci.expect_error(format(
      'SELECT public.vacation_import_confirmation(%L::uuid,%L::uuid,%L::uuid,%L::jsonb,%L::jsonb,NULL,NULL)',
      c.family_id, v.trip, c.member_id, c.source,
      c.fields || jsonb_build_object('reservedAt', v.instant)), '22023');
  END LOOP;
END
$$;
RESET ROLE;
SELECT travel_import_ci.observe('year-denials-after');
SELECT travel_import_ci.assert_same('year-denials-before', 'year-denials-after', true);

SELECT travel_import_ci.observe('unavailable-before');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
DO $$
DECLARE n integer; c travel_import_ci.cases;
BEGIN
  SELECT * INTO STRICT c FROM travel_import_ci.cases WHERE key = 'main';
  FOR n IN 10..15 LOOP
    PERFORM travel_import_ci.expect_error(format(
      'SELECT public.vacation_import_confirmation(%L::uuid,%L::uuid,%L::uuid,%L::jsonb,%L::jsonb,NULL,NULL)',
      c.family_id, '40000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
      c.member_id, c.source, c.fields), '55000');
  END LOOP;
END
$$;
SELECT travel_import_ci.expect_error($sql$
  SELECT public.vacation_import_confirmation(family_id, '40000000-0000-4000-8000-000000000099',
    member_id, source, fields, NULL, NULL) FROM travel_import_ci.cases WHERE key = 'main'
$sql$, 'P0002');
SELECT travel_import_ci.expect_error($sql$
  SELECT public.vacation_import_confirmation(family_id, '40000000-0000-4000-8000-000000000002',
    member_id, source, fields, NULL, NULL) FROM travel_import_ci.cases WHERE key = 'main'
$sql$, 'P0002');
RESET ROLE;
SELECT travel_import_ci.observe('unavailable-after');
SELECT travel_import_ci.assert_same('unavailable-before', 'unavailable-after', true);

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
UPDATE travel_import_ci.cases SET expected = travel_import_ci.invoke('pending') -> 'preview' WHERE key = 'pending';
RESET ROLE;
UPDATE public.vacations SET title = 'CI stale title' WHERE id = '40000000-0000-4000-8000-000000000001';
SELECT travel_import_ci.observe('stale-title-before');
SET ROLE authenticated;
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('pending', true)$sql$, '40001');
RESET ROLE;
SELECT travel_import_ci.observe('stale-title-after');
SELECT travel_import_ci.assert_same('stale-title-before', 'stale-title-after', true);
UPDATE public.vacations SET title = 'CI original trip' WHERE id = '40000000-0000-4000-8000-000000000001';

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
UPDATE travel_import_ci.cases SET expected = travel_import_ci.invoke('pending') -> 'preview' WHERE key = 'pending';
RESET ROLE;
UPDATE public.vacations SET start_date = '2026-09-05' WHERE id = '40000000-0000-4000-8000-000000000001';
SELECT travel_import_ci.observe('stale-start-before');
SET ROLE authenticated;
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('pending', true)$sql$, '40001');
RESET ROLE;
SELECT travel_import_ci.observe('stale-start-after');
SELECT travel_import_ci.assert_same('stale-start-before', 'stale-start-after', true);
UPDATE public.vacations SET start_date = '2026-09-06' WHERE id = '40000000-0000-4000-8000-000000000001';

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
UPDATE travel_import_ci.cases SET expected = travel_import_ci.invoke('pending') -> 'preview' WHERE key = 'pending';
RESET ROLE;
UPDATE public.vacations SET end_date = '2026-09-09' WHERE id = '40000000-0000-4000-8000-000000000001';
SELECT travel_import_ci.observe('stale-end-before');
SET ROLE authenticated;
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('pending', true)$sql$, '40001');
RESET ROLE;
SELECT travel_import_ci.observe('stale-end-after');
SELECT travel_import_ci.assert_same('stale-end-before', 'stale-end-after', true);
UPDATE public.vacations SET end_date = '2026-09-08' WHERE id = '40000000-0000-4000-8000-000000000001';

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
UPDATE travel_import_ci.cases SET expected = travel_import_ci.invoke('pending') -> 'preview' WHERE key = 'pending';
RESET ROLE;
UPDATE public.vacations SET timezone = 'UTC' WHERE id = '40000000-0000-4000-8000-000000000001';
SELECT travel_import_ci.observe('stale-timezone-before');
SET ROLE authenticated;
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('pending', true)$sql$, '40001');
RESET ROLE;
SELECT travel_import_ci.observe('stale-timezone-after');
SELECT travel_import_ci.assert_same('stale-timezone-before', 'stale-timezone-after', true);
UPDATE public.vacations SET timezone = 'America/Los_Angeles' WHERE id = '40000000-0000-4000-8000-000000000001';

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
UPDATE travel_import_ci.cases SET expected = travel_import_ci.invoke('pending') -> 'preview' WHERE key = 'pending';
RESET ROLE;
UPDATE public.vacations SET status = 'booked' WHERE id = '40000000-0000-4000-8000-000000000001';
SELECT travel_import_ci.observe('stale-status-before');
SET ROLE authenticated;
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('pending', true)$sql$, '40001');
RESET ROLE;
SELECT travel_import_ci.observe('stale-status-after');
SELECT travel_import_ci.assert_same('stale-status-before', 'stale-status-after', true);
UPDATE public.vacations SET status = 'planning' WHERE id = '40000000-0000-4000-8000-000000000001';

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
UPDATE travel_import_ci.cases SET expected = travel_import_ci.invoke('pending') -> 'preview' WHERE key = 'pending';
RESET ROLE;
UPDATE public.vacations SET updated_at = '2026-09-01T00:00:00.654321Z' WHERE id = '40000000-0000-4000-8000-000000000001';
SELECT travel_import_ci.observe('stale-timestamp-before');
SET ROLE authenticated;
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('pending', true)$sql$, '40001');
RESET ROLE;
SELECT travel_import_ci.observe('stale-timestamp-after');
SELECT travel_import_ci.assert_same('stale-timestamp-before', 'stale-timestamp-after', true);
UPDATE public.vacations SET title = 'CI original trip' WHERE id = '40000000-0000-4000-8000-000000000001';

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
UPDATE travel_import_ci.cases SET expected = travel_import_ci.invoke('pending') -> 'preview' WHERE key = 'pending';
RESET ROLE;
SELECT travel_import_ci.observe('review-tamper-before');
SET ROLE authenticated;
DO $$
DECLARE v record; c travel_import_ci.cases;
BEGIN
  SELECT * INTO STRICT c FROM travel_import_ci.cases WHERE key = 'pending';
  FOR v IN SELECT * FROM (VALUES
    ('{version}'::text[], '2'::jsonb),
    ('{source,title}'::text[], '"CI changed reviewed title"'::jsonb),
    ('{source,text}'::text[], '"CI changed reviewed text"'::jsonb),
    ('{source,sha256}'::text[], to_jsonb(repeat('0', 64))),
    ('{fields,name}'::text[], '"CI changed reviewed name"'::jsonb),
    ('{fields,booked}'::text[], 'true'::jsonb),
    ('{itinerary,date}'::text[], '"2026-09-07"'::jsonb),
    ('{itinerary,startTime}'::text[], '"19:30:00"'::jsonb),
    ('{itinerary,dayPart}'::text[], '"morning"'::jsonb),
    ('{trip,title}'::text[], '"CI changed reviewed trip"'::jsonb),
    ('{memberId}'::text[], '"30000000-0000-4000-8000-000000000002"'::jsonb)
  ) AS changes(path, value) LOOP
    PERFORM travel_import_ci.expect_error(format(
      'SELECT public.vacation_import_confirmation(%L::uuid,%L::uuid,%L::uuid,%L::jsonb,%L::jsonb,%L::jsonb,%L::uuid)',
      c.family_id, c.vacation_id, c.member_id, c.source, c.fields,
      jsonb_set(c.expected, v.path, v.value), c.request_id), '40001');
  END LOOP;
  PERFORM travel_import_ci.expect_error(format(
    'SELECT public.vacation_import_confirmation(%L::uuid,%L::uuid,%L::uuid,%L::jsonb,%L::jsonb,%L::jsonb,%L::uuid)',
    c.family_id, c.vacation_id, c.member_id, c.source || '{"text":"CI unreviewed replacement"}',
    c.fields, c.expected, c.request_id), '40001');
  PERFORM travel_import_ci.expect_error(format(
    'SELECT public.vacation_import_confirmation(%L::uuid,%L::uuid,%L::uuid,%L::jsonb,%L::jsonb,%L::jsonb,%L::uuid)',
    c.family_id, c.vacation_id, c.member_id, c.source,
    c.fields || '{"booked":true}', c.expected, c.request_id), '40001');
END
$$;
RESET ROLE;
SELECT travel_import_ci.observe('review-tamper-after');
SELECT travel_import_ci.assert_same('review-tamper-before', 'review-tamper-after', true);

SELECT travel_import_ci.observe('wrong-day-before');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
SELECT travel_import_ci.expect_error($sql$SELECT travel_import_ci.invoke('wrong-day', true)$sql$, '42501');
RESET ROLE;
SELECT travel_import_ci.observe('wrong-day-after');
SELECT travel_import_ci.assert_same('wrong-day-before', 'wrong-day-after');

-- Fail at COMMIT, after the RPC has produced a complete receipt. The shell
-- fixture executes that transaction in its own psql session and requires P7701.
CREATE FUNCTION travel_import_ci.reject_deferred_commit() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
BEGIN
  IF NEW.id = '80000000-0000-4000-8000-000000000004'::uuid THEN
    RAISE EXCEPTION USING ERRCODE = 'P7701', MESSAGE = 'Synthetic CI deferred commit failure';
  END IF;
  RETURN NEW;
END
$$;
CREATE CONSTRAINT TRIGGER travel_ci_fail_at_commit
AFTER INSERT ON public.vacation_confirmation_imports
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION travel_import_ci.reject_deferred_commit();

SELECT travel_import_ci.observe('rollback-before');
