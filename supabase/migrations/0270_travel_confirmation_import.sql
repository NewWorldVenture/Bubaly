-- Reviewed, source-linked travel confirmation imports. Application writes enter
-- through the RPC only; the retained source and receipt have no mutation API.
-- Family/trip removal intentionally cascades private source cleanup. Child and
-- actor IDs are historical identifiers, without FKs that could alter history.
-- Database owners remain able to administer this table.

CREATE TABLE IF NOT EXISTS public.vacation_confirmation_imports (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL,
  actor_member_id uuid NOT NULL,
  source_title text NOT NULL,
  source_text text NOT NULL,
  source_sha256 text NOT NULL,
  reviewed jsonb NOT NULL,
  receipt jsonb NOT NULL,
  reservation_id uuid NOT NULL,
  itinerary_item_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT vacation_confirmation_imports_source_title_check CHECK (
    char_length(source_title) BETWEEN 1 AND 160
    AND source_title = btrim(source_title,
      U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
  ),
  CONSTRAINT vacation_confirmation_imports_source_text_check CHECK (
    char_length(source_text) BETWEEN 1 AND 32768
    AND octet_length(convert_to(source_text, 'UTF8')) <= 65536
  ),
  CONSTRAINT vacation_confirmation_imports_source_hash_check CHECK (
    source_sha256 ~ '^[0-9a-f]{64}$'
    AND source_sha256 = encode(pg_catalog.sha256(convert_to(source_text, 'UTF8')), 'hex')
  ),
  CONSTRAINT vacation_confirmation_imports_reviewed_check CHECK ((
    jsonb_typeof(reviewed) = 'object'
    AND reviewed ?& ARRAY['version', 'familyId', 'vacationId', 'memberId', 'trip', 'source', 'fields', 'itinerary']
    AND reviewed - ARRAY['version', 'familyId', 'vacationId', 'memberId', 'trip', 'source', 'fields', 'itinerary'] = '{}'::jsonb
    AND reviewed -> 'version' = '1'::jsonb
    AND reviewed -> 'familyId' = to_jsonb(family_id)
    AND reviewed -> 'vacationId' = to_jsonb(vacation_id)
    AND reviewed -> 'memberId' = to_jsonb(actor_member_id)
    AND jsonb_typeof(reviewed -> 'trip') = 'object'
    AND reviewed -> 'trip' -> 'id' = to_jsonb(vacation_id)
    AND reviewed -> 'source' = jsonb_build_object(
      'title', source_title, 'text', source_text, 'sha256', source_sha256
    )
    AND jsonb_typeof(reviewed -> 'fields') = 'object'
    AND jsonb_typeof(reviewed -> 'itinerary') = 'object'
  ) IS TRUE),
  CONSTRAINT vacation_confirmation_imports_created_at_check CHECK (
    created_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
    AND created_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'
  ),
  CONSTRAINT vacation_confirmation_imports_receipt_check CHECK ((
    receipt = jsonb_build_object(
      'preview', reviewed,
      'applied', true,
      'requestId', id,
      'appliedAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'reservationId', reservation_id,
      'itineraryItemId', itinerary_item_id
    )
  ) IS TRUE),
  CONSTRAINT vacation_confirmation_imports_exact_source_key UNIQUE (vacation_id, source_sha256)
);

CREATE INDEX IF NOT EXISTS vacation_confirmation_imports_family_trip_idx
  ON public.vacation_confirmation_imports (family_id, vacation_id, created_at DESC);

ALTER TABLE public.vacation_confirmation_imports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.vacation_confirmation_imports FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.vacation_confirmation_imports TO authenticated;

DROP POLICY IF EXISTS vacation_confirmation_imports_adult_read
  ON public.vacation_confirmation_imports;
CREATE POLICY vacation_confirmation_imports_adult_read
  ON public.vacation_confirmation_imports
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.family_members AS fm
      WHERE fm.family_id = vacation_confirmation_imports.family_id
        AND fm.user_id = auth.uid()
        AND fm.is_active IS TRUE
        AND fm.role IN ('parent', 'adult')
    )
  );

CREATE OR REPLACE FUNCTION public.vacation_import_confirmation(
  p_family_id uuid,
  p_vacation_id uuid,
  p_member_id uuid,
  p_source jsonb,
  p_fields jsonb,
  p_expected jsonb DEFAULT NULL,
  p_request_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
SET timezone = 'UTC'
SET datestyle = 'ISO, YMD'
AS $function$
DECLARE
  -- Match ECMAScript trim without modifying the original evidence text.
  v_trim_characters CONSTANT text :=
    U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
  v_actor_user_id uuid := auth.uid();
  v_trip public.vacations%ROWTYPE;
  v_saved public.vacation_confirmation_imports%ROWTYPE;
  v_pass integer;
  v_source_title text;
  v_source_text text;
  v_source_sha256 text;
  v_name text;
  v_kind text;
  v_location text;
  v_reserved_text text;
  v_reserved_at timestamptz;
  v_party_number numeric;
  v_party_size integer;
  v_confirmation_code text;
  v_booked boolean;
  v_source jsonb;
  v_fields jsonb;
  v_trip_snapshot jsonb;
  v_preview jsonb;
  v_receipt jsonb;
  v_local_at timestamp without time zone;
  v_local_date date;
  v_start_time time without time zone;
  v_day_part public.vac_day_part;
  v_new_day_id uuid;
  v_day_id uuid;
  v_day_family_id uuid;
  v_reservation_id uuid;
  v_itinerary_item_id uuid;
  v_applied_at timestamptz;
  v_notes text;
BEGIN
  IF v_actor_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'An authenticated member is required';
  END IF;
  IF p_family_id IS NULL OR p_vacation_id IS NULL OR p_member_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Family, trip and member IDs are required';
  END IF;

  -- A fresh, exact membership check on every call, including receipt retries.
  -- SHARE prevents concurrent role/activity changes until this transaction ends.
  PERFORM fm.id
  FROM public.family_members AS fm
  WHERE fm.id = p_member_id
    AND fm.family_id = p_family_id
    AND fm.user_id = v_actor_user_id
    AND fm.is_active IS TRUE
    AND fm.role IN ('parent', 'adult')
  FOR SHARE OF fm;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'An active parent or adult membership is required';
  END IF;

  IF (p_expected IS NULL) IS DISTINCT FROM (p_request_id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Expected preview and request ID must be supplied together';
  END IF;
  IF p_expected IS NOT NULL AND jsonb_typeof(p_expected) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Expected preview must be an object';
  END IF;

  -- Test object types before key operations or scalar extraction. JSON null is
  -- not SQL NULL, and strings containing numbers/booleans are not those types.
  IF jsonb_typeof(p_source) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Source must be an object';
  END IF;
  IF NOT (p_source ?& ARRAY['title', 'text'])
    OR p_source - ARRAY['title', 'text'] <> '{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Source must contain exactly title and text';
  END IF;
  IF jsonb_typeof(p_source -> 'title') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_source -> 'text') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Source title and text must be strings';
  END IF;

  v_source_title := btrim(p_source ->> 'title', v_trim_characters);
  v_source_text := p_source ->> 'text';
  IF char_length(v_source_title) NOT BETWEEN 1 AND 160
    OR char_length(v_source_text) NOT BETWEEN 1 AND 32768
    OR octet_length(convert_to(v_source_text, 'UTF8')) > 65536 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Source title or text exceeds the permitted bounds or is empty';
  END IF;
  v_source_sha256 := encode(pg_catalog.sha256(convert_to(v_source_text, 'UTF8')), 'hex');

  IF jsonb_typeof(p_fields) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Confirmation fields must be an object';
  END IF;
  IF NOT (p_fields ?& ARRAY['name', 'kind', 'location', 'reservedAt', 'partySize', 'confirmationCode', 'booked'])
    OR p_fields - ARRAY['name', 'kind', 'location', 'reservedAt', 'partySize', 'confirmationCode', 'booked'] <> '{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Confirmation fields must contain exactly the seven reviewed fields';
  END IF;
  IF jsonb_typeof(p_fields -> 'name') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_fields -> 'kind') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_fields -> 'reservedAt') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_fields -> 'booked') IS DISTINCT FROM 'boolean'
    OR (jsonb_typeof(p_fields -> 'location') IN ('string', 'null')) IS NOT TRUE
    OR (jsonb_typeof(p_fields -> 'confirmationCode') IN ('string', 'null')) IS NOT TRUE
    OR (jsonb_typeof(p_fields -> 'partySize') IN ('number', 'null')) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Confirmation fields have invalid JSON types';
  END IF;

  v_name := btrim(p_fields ->> 'name', v_trim_characters);
  v_kind := btrim(p_fields ->> 'kind', v_trim_characters);
  v_location := btrim(p_fields ->> 'location', v_trim_characters);
  v_confirmation_code := btrim(p_fields ->> 'confirmationCode', v_trim_characters);
  v_reserved_text := p_fields ->> 'reservedAt';
  v_booked := (p_fields ->> 'booked')::boolean;
  IF char_length(v_name) NOT BETWEEN 1 AND 200
    OR char_length(v_kind) NOT BETWEEN 1 AND 40
    OR char_length(v_location) > 500
    OR char_length(v_confirmation_code) > 120 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Confirmation field text exceeds the permitted bounds or is empty';
  END IF;

  IF jsonb_typeof(p_fields -> 'partySize') = 'number' THEN
    v_party_number := (p_fields ->> 'partySize')::numeric;
    IF v_party_number < 1 OR v_party_number > 1000 OR v_party_number <> trunc(v_party_number) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Party size must be an integer from 1 through 1000 or null';
    END IF;
    v_party_size := v_party_number::integer;
  END IF;

  -- Reject PostgreSQL's permissive datetime forms, leap seconds, 24:00, missing
  -- offsets, year zero and offsets beyond 14:00 before casting. The cast then
  -- checks real calendar dates, including leap years, without normalizing input.
  IF char_length(v_reserved_text) NOT BETWEEN 20 AND 29
    OR v_reserved_text !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,3})?(Z|[+-]((0[0-9]|1[0-3]):[0-5][0-9]|14:00))$'
    OR left(v_reserved_text, 4) = '0000' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reservedAt must be a bounded ISO datetime with seconds and an explicit offset';
  END IF;
  BEGIN
    v_reserved_at := v_reserved_text::timestamptz;
  EXCEPTION
    WHEN datetime_field_overflow OR invalid_datetime_format THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reservedAt must contain a real calendar date and time';
  END;
  IF v_reserved_at < TIMESTAMPTZ '0001-01-01 00:00:00+00'
    OR v_reserved_at >= TIMESTAMPTZ '10000-01-01 00:00:00+00' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reservedAt must also remain within years 0001 through 9999 in UTC';
  END IF;

  v_source := jsonb_build_object(
    'title', v_source_title, 'text', v_source_text, 'sha256', v_source_sha256
  );
  v_fields := jsonb_build_object(
    'name', v_name,
    'kind', v_kind,
    'location', v_location,
    'reservedAt', v_reserved_text,
    'partySize', v_party_size,
    'confirmationCode', v_confirmation_code,
    'booked', v_booked
  );

  -- Look for an original receipt before consulting mutable trip settings, then
  -- again after the trip lock: another same-trip call may have saved while this
  -- call waited. VOLATILE statements obtain fresh READ COMMITTED snapshots.
  FOR v_pass IN 1..2 LOOP
    IF p_request_id IS NOT NULL THEN
      SELECT saved.* INTO v_saved
      FROM public.vacation_confirmation_imports AS saved
      WHERE saved.id = p_request_id;
      IF FOUND THEN
        IF v_saved.family_id IS DISTINCT FROM p_family_id
          OR v_saved.vacation_id IS DISTINCT FROM p_vacation_id
          OR v_saved.actor_user_id IS DISTINCT FROM v_actor_user_id
          OR v_saved.actor_member_id IS DISTINCT FROM p_member_id
          OR v_saved.reviewed IS DISTINCT FROM p_expected
          OR v_saved.reviewed -> 'source' IS DISTINCT FROM v_source
          OR v_saved.reviewed -> 'fields' IS DISTINCT FROM v_fields THEN
          RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'Request ID already belongs to a different confirmation import';
        END IF;
        RETURN v_saved.receipt;
      END IF;
    END IF;
    EXIT WHEN v_pass = 2;

    SELECT trip.* INTO v_trip
    FROM public.vacations AS trip
    WHERE trip.id = p_vacation_id AND trip.family_id = p_family_id
    FOR UPDATE OF trip;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Trip is unavailable';
    END IF;
  END LOOP;

  v_trip_snapshot := jsonb_build_object(
    'id', v_trip.id,
    'title', v_trip.title,
    'startDate', v_trip.start_date,
    'endDate', v_trip.end_date,
    'timezone', v_trip.timezone,
    'status', v_trip.status::text,
    'updatedAt', v_trip.updated_at
  );
  -- Report a changed trip as stale even when its new dates, status or timezone
  -- would make a fresh preview unavailable.
  IF p_expected IS NOT NULL AND p_expected -> 'trip' IS DISTINCT FROM v_trip_snapshot THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Trip changed; review a fresh confirmation preview';
  END IF;

  IF v_trip.status IS NULL OR v_trip.status::text NOT IN ('planning', 'booked', 'active', 'completed') THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'This trip does not accept confirmation imports';
  END IF;
  IF v_trip.start_date IS NULL OR v_trip.end_date IS NULL
    OR v_trip.start_date < DATE '0001-01-01'
    OR v_trip.end_date >= DATE '10000-01-01'
    OR v_trip.start_date > v_trip.end_date
    OR v_trip.updated_at IS NULL
    OR v_trip.updated_at < TIMESTAMPTZ '0001-01-01 00:00:00+00'
    OR v_trip.updated_at >= TIMESTAMPTZ '10000-01-01 00:00:00+00' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Trip requires valid bounded dates and a recorded update timestamp';
  END IF;
  IF v_trip.timezone IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names AS zone WHERE zone.name = v_trip.timezone
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Trip requires a recorded valid timezone';
  END IF;

  v_local_at := v_reserved_at AT TIME ZONE v_trip.timezone;
  v_local_date := v_local_at::date;
  IF v_local_date < v_trip.start_date OR v_local_date > v_trip.end_date THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Reservation date in the trip timezone must fall within the trip dates';
  END IF;
  v_start_time := date_trunc('second', v_local_at)::time;
  v_day_part := CASE
    WHEN extract(hour FROM v_local_at) < 12 THEN 'morning'::public.vac_day_part
    WHEN extract(hour FROM v_local_at) < 17 THEN 'afternoon'::public.vac_day_part
    ELSE 'evening'::public.vac_day_part
  END;
  v_preview := jsonb_build_object(
    'version', 1,
    'familyId', p_family_id,
    'vacationId', p_vacation_id,
    'memberId', p_member_id,
    'trip', v_trip_snapshot,
    'source', v_source,
    'fields', v_fields,
    'itinerary', jsonb_build_object(
      'date', to_char(v_local_date, 'YYYY-MM-DD'),
      'startTime', to_char(v_local_at, 'HH24:MI:SS'),
      'dayPart', v_day_part::text
    )
  );

  -- Preview exits before UUID allocation, receipt claims or any DML.
  IF p_expected IS NULL THEN
    RETURN jsonb_build_object(
      'preview', v_preview,
      'applied', false,
      'requestId', NULL,
      'appliedAt', NULL,
      'reservationId', NULL,
      'itineraryItemId', NULL
    );
  END IF;
  IF p_expected IS DISTINCT FROM v_preview THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Confirmation preview changed; review a fresh preview';
  END IF;

  v_reservation_id := gen_random_uuid();
  v_itinerary_item_id := gen_random_uuid();
  v_new_day_id := gen_random_uuid();
  v_applied_at := clock_timestamp();
  v_notes := 'Travel confirmation import ' || p_request_id::text
    || '. Recorded user-confirmed evidence; no provider verification.';
  v_receipt := jsonb_build_object(
    'preview', v_preview,
    'applied', true,
    'requestId', p_request_id,
    'appliedAt', to_char(v_applied_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'reservationId', v_reservation_id,
    'itineraryItemId', v_itinerary_item_id
  );

  -- Claim both globally unique request identity and exact source identity first.
  -- Any later failure rolls this complete receipt back with all child writes.
  -- A different-trip concurrent request collision is rejected by the global PK.
  INSERT INTO public.vacation_confirmation_imports (
    id, family_id, vacation_id, actor_user_id, actor_member_id,
    source_title, source_text, source_sha256, reviewed, receipt,
    reservation_id, itinerary_item_id, created_at
  ) VALUES (
    p_request_id, p_family_id, p_vacation_id, v_actor_user_id, p_member_id,
    v_source_title, v_source_text, v_source_sha256, v_preview, v_receipt,
    v_reservation_id, v_itinerary_item_id, v_applied_at
  );

  -- Existing day rows are reused without touching any field or update trigger.
  INSERT INTO public.vacation_itinerary_days (
    id, family_id, vacation_id, day_date, created_by
  ) VALUES (
    v_new_day_id, p_family_id, p_vacation_id, v_local_date, v_actor_user_id
  ) ON CONFLICT (vacation_id, day_date) DO NOTHING;

  SELECT day.id, day.family_id INTO v_day_id, v_day_family_id
  FROM public.vacation_itinerary_days AS day
  WHERE day.vacation_id = p_vacation_id AND day.day_date = v_local_date
  FOR UPDATE OF day;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Itinerary day changed during confirmation import';
  END IF;
  IF v_day_family_id IS DISTINCT FROM p_family_id THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Existing itinerary day has an incompatible family';
  END IF;

  INSERT INTO public.vacation_reservations (
    id, family_id, vacation_id, kind, name, location, reserved_at,
    party_size, confirmation_code, booked, notes, created_by
  ) VALUES (
    v_reservation_id, p_family_id, p_vacation_id, v_kind, v_name, v_location, v_reserved_at,
    v_party_size, v_confirmation_code, v_booked, v_notes, v_actor_user_id
  );

  INSERT INTO public.vacation_itinerary_items (
    id, family_id, vacation_id, day_id, kind, day_part, title, location,
    start_time, booked, confirmation_code, notes, created_by
  ) VALUES (
    v_itinerary_item_id, p_family_id, p_vacation_id, v_day_id, 'reservation', v_day_part, v_name, v_location,
    v_start_time, v_booked, v_confirmation_code, v_notes, v_actor_user_id
  );

  RETURN v_receipt;
END;
$function$;

REVOKE ALL ON FUNCTION public.vacation_import_confirmation(uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vacation_import_confirmation(uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid)
  TO authenticated;
