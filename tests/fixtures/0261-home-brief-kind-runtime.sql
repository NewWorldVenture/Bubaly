-- Invoked only inside the runner's ownership-checked, empty disposable database.
-- pg_temp.apply_0261 executes the actual migration text, not a copied migration.
-- The runner wraps this entire fixture in a transaction and rolls it back.

CREATE FUNCTION pg_temp.require_proof(condition boolean, detail text)
RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  IF condition IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0261 acceptance: %', detail;
  END IF;
END;
$function$;

CREATE FUNCTION pg_temp.reset_briefs()
RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  DROP TABLE IF EXISTS public.home_briefs;
  CREATE TABLE public.home_briefs (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    family_id uuid NOT NULL,
    as_of_date date NOT NULL,
    kind text NOT NULL,
    payload text NOT NULL,
    CONSTRAINT obsolete_brief_by_day UNIQUE (family_id, as_of_date),
    CONSTRAINT "Renamed Legacy Date First" UNIQUE (as_of_date, family_id),
    CONSTRAINT keep_unrelated_key UNIQUE (id, kind)
  );
  CREATE UNIQUE INDEX uq_home_briefs_family_date_kind
    ON public.home_briefs (family_id, as_of_date, kind);
  INSERT INTO public.home_briefs (family_id, as_of_date, kind, payload)
  VALUES ('00000000-0000-4000-8000-000000000261', DATE '2026-01-01', 'daily', 'synthetic daily');
END;
$function$;

-- Capture identities as well as definitions: a drop/recreate is not a no-op.
CREATE FUNCTION pg_temp.brief_snapshot()
RETURNS jsonb LANGUAGE plpgsql AS $function$
DECLARE result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'table_oid', 'public.home_briefs'::regclass::oid,
    'constraints', (
      SELECT jsonb_agg(jsonb_build_object('oid', c.oid, 'name', c.conname,
        'definition', pg_catalog.pg_get_constraintdef(c.oid)) ORDER BY c.conname)
      FROM pg_catalog.pg_constraint c WHERE c.conrelid = 'public.home_briefs'::regclass
    ),
    'indexes', (
      SELECT jsonb_agg(jsonb_build_object('oid', i.indexrelid,
        'definition', pg_catalog.pg_get_indexdef(i.indexrelid),
        'valid', i.indisvalid, 'ready', i.indisready) ORDER BY i.indexrelid)
      FROM pg_catalog.pg_index i WHERE i.indrelid = 'public.home_briefs'::regclass
    ),
    'rows', (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM public.home_briefs b)
  ) INTO result;
  RETURN result;
END;
$function$;

CREATE FUNCTION pg_temp.expect_atomic_rejection(case_name text, expected_message text)
RETURNS void LANGUAGE plpgsql AS $function$
DECLARE
  before_state jsonb := pg_temp.brief_snapshot();
  observed_state text;
  observed_message text;
BEGIN
  -- Catch the actual migration failure in a PostgreSQL subtransaction. The
  -- success path does not manufacture an exception that could be mistaken for it.
  BEGIN
    PERFORM pg_temp.apply_0261();
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS observed_state = RETURNED_SQLSTATE,
      observed_message = MESSAGE_TEXT;
  END;
  PERFORM pg_temp.require_proof(observed_state = 'P0001'
    AND observed_message = expected_message, case_name || ': expected migration rejection');
  PERFORM pg_temp.require_proof(pg_temp.brief_snapshot() = before_state,
    case_name || ': migration changed fixture data or catalogs on failure');
  INSERT INTO pg_temp.proof_results VALUES (case_name);
END;
$function$;

DO $acceptance$
DECLARE
  before_rerun jsonb;
  duplicate_state text;
  duplicate_constraint text;
  replacement_error constant text := '0261: the 0258 family/date/kind unique index is missing or unusable; review this baseline';
BEGIN
  PERFORM pg_temp.reset_briefs();
  PERFORM pg_temp.apply_0261();
  PERFORM pg_temp.require_proof(NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.home_briefs'::regclass
      AND conname IN ('obsolete_brief_by_day', 'Renamed Legacy Date First')
  ), 'renamed and reordered obsolete constraints must both disappear');
  PERFORM pg_temp.require_proof((
    SELECT count(*) = 2 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.home_briefs'::regclass
      AND conname IN ('home_briefs_pkey', 'keep_unrelated_key')
  ), 'unrelated unique and primary key constraints must remain');
  INSERT INTO pg_temp.proof_results VALUES ('renamed_reordered_legacy_removed');

  INSERT INTO public.home_briefs (family_id, as_of_date, kind, payload)
  VALUES ('00000000-0000-4000-8000-000000000261', DATE '2026-01-01', 'evening', 'synthetic evening');
  PERFORM pg_temp.require_proof((SELECT count(*) = 2 AND count(DISTINCT kind) = 2
    FROM public.home_briefs
    WHERE family_id = '00000000-0000-4000-8000-000000000261' AND as_of_date = DATE '2026-01-01'),
    'daily and evening must coexist for the same family/date');
  INSERT INTO pg_temp.proof_results VALUES ('daily_evening_coexist');

  BEGIN
    INSERT INTO public.home_briefs (family_id, as_of_date, kind, payload)
    VALUES ('00000000-0000-4000-8000-000000000261', DATE '2026-01-01', 'daily', 'synthetic duplicate');
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS duplicate_state = RETURNED_SQLSTATE,
      duplicate_constraint = CONSTRAINT_NAME;
  END;
  PERFORM pg_temp.require_proof(duplicate_state = '23505'
    AND duplicate_constraint = 'uq_home_briefs_family_date_kind',
    'same-kind duplicates must be rejected by the replacement unique index');
  PERFORM pg_temp.require_proof((SELECT count(*) = 2 FROM public.home_briefs), 'duplicate insert must not persist');
  INSERT INTO pg_temp.proof_results VALUES ('same_kind_duplicate_rejected');

  before_rerun := pg_temp.brief_snapshot();
  PERFORM pg_temp.apply_0261();
  PERFORM pg_temp.require_proof(pg_temp.brief_snapshot() = before_rerun, 'migration rerun must preserve data and catalog identities');
  INSERT INTO pg_temp.proof_results VALUES ('rerun_idempotent');

  PERFORM pg_temp.reset_briefs();
  DROP INDEX public.uq_home_briefs_family_date_kind;
  PERFORM pg_temp.expect_atomic_rejection('missing_replacement_atomic', replacement_error);

  PERFORM pg_temp.reset_briefs();
  DROP INDEX public.uq_home_briefs_family_date_kind;
  CREATE UNIQUE INDEX uq_home_briefs_family_date_kind ON public.home_briefs (family_id, as_of_date, kind)
    WHERE kind = 'daily';
  PERFORM pg_temp.expect_atomic_rejection('partial_replacement_atomic', replacement_error);

  PERFORM pg_temp.reset_briefs();
  DROP INDEX public.uq_home_briefs_family_date_kind;
  CREATE UNIQUE INDEX uq_home_briefs_family_date_kind ON public.home_briefs (family_id, as_of_date, payload);
  PERFORM pg_temp.expect_atomic_rejection('wrong_replacement_atomic', replacement_error);

  PERFORM pg_temp.reset_briefs();
  CREATE UNIQUE INDEX unknown_standalone_family_date ON public.home_briefs (as_of_date, family_id);
  PERFORM pg_temp.expect_atomic_rejection('unknown_standalone_unique_atomic',
    '0261: unexpected family/date unique index; review this baseline before removing constraints');
END;
$acceptance$;

SELECT '0261_OK ' || case_name FROM pg_temp.proof_results ORDER BY case_name;
