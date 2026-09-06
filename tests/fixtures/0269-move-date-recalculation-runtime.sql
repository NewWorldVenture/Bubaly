-- Single-session executable proof for actual migrations 0245 and 0269.
-- BEGIN is in the bootstrap; every fixture object and row is rolled back below.
-- No migration/function copies, imports, credentials, network calls, or services.
-- HELD/UNPROVEN: a later relative INSERT can retain an old app-computed due_date
-- after waiting on the parent's FK lock. This suite neither fixes nor proves
-- that concurrent-insert requirement, or multi-session lock/race behavior.

DO $guard$
BEGIN
  IF pg_catalog.current_database() <> 'bubaly_move_recalc_ci'
    OR CURRENT_USER <> 'postgres'
    OR pg_catalog.to_regclass('public.move_date_recalculations') IS NULL
  THEN
    RAISE EXCEPTION '0269 runtime requires its isolated bootstrap and actual migrations';
  END IF;
END;
$guard$;

CREATE TABLE public.test_0269_proofs (name text PRIMARY KEY);
CREATE TABLE public.test_0269_state (name text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE public.test_0269_writes (
  table_name text NOT NULL,
  operation text NOT NULL,
  row_id uuid NOT NULL
);
GRANT INSERT ON TABLE public.test_0269_proofs TO anon;

CREATE FUNCTION public.test_0269_assert(p_condition boolean, p_label text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_condition IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0269 assertion failed: %', p_label;
  END IF;
  INSERT INTO public.test_0269_proofs(name) VALUES (p_label);
END;
$function$;

-- INVOKER on purpose: normal test calls observe the actual authenticated RLS.
-- The write log covers every instrumented row, including any otherwise-hidden
-- accidental write. Duplicate updates produce duplicate entries and are counted.
CREATE FUNCTION public.test_0269_snapshot()
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'moves', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.id), '[]'::jsonb) FROM public.moves AS row),
    'tasks', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.id), '[]'::jsonb) FROM public.move_tasks AS row),
    'boxes', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.id), '[]'::jsonb) FROM public.move_boxes AS row),
    'history', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.request_id), '[]'::jsonb) FROM public.move_date_recalculations AS row),
    'writes', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.table_name, row.operation, row.row_id), '[]'::jsonb) FROM public.test_0269_writes AS row)
  )
$function$;

CREATE FUNCTION public.test_0269_expect_error(
  p_sql text, p_sqlstate text, p_label text,
  p_message text DEFAULT NULL, p_snapshot boolean DEFAULT true
)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_state text;
  v_message text;
  v_before jsonb;
BEGIN
  IF p_snapshot THEN
    v_before := public.test_0269_snapshot();
  END IF;
  -- Only the submitted operation is inside the exception-catching block.
  -- Assertions are OUTSIDE it and cannot be mistaken for expected failures.
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
  END;
  PERFORM public.test_0269_assert(
    v_state IS NOT DISTINCT FROM p_sqlstate
      AND (p_message IS NULL OR v_message IS NOT DISTINCT FROM p_message),
    p_label || '_sqlstate'
  );
  IF p_snapshot THEN
    PERFORM public.test_0269_assert(
      public.test_0269_snapshot() IS NOT DISTINCT FROM v_before,
      p_label || '_no_writes'
    );
  END IF;
END;
$function$;

CREATE FUNCTION public.test_0269_observe_write()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  INSERT INTO public.test_0269_writes(table_name, operation, row_id)
  VALUES (
    TG_TABLE_NAME, TG_OP,
    COALESCE(
      pg_catalog.to_jsonb(NEW)->>'id', pg_catalog.to_jsonb(NEW)->>'request_id',
      pg_catalog.to_jsonb(OLD)->>'id', pg_catalog.to_jsonb(OLD)->>'request_id'
    )::uuid
  );
  RETURN NULL;
END;
$function$;

CREATE FUNCTION public.test_0269_fail_task_update()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF pg_catalog.current_setting('bubaly_0269.inject_task_failure', true) = 'on'
    AND NEW.id = '50000000-0000-4000-8000-000000000003'::uuid
    AND NEW.due_date IS DISTINCT FROM OLD.due_date
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0269', MESSAGE = '0269_injected_task_update_failure';
  END IF;
  RETURN NEW;
END;
$function$;

INSERT INTO auth.users(id, email) VALUES
  ('20000000-0000-4000-8000-000000000001', 'parent@example.test'),
  ('20000000-0000-4000-8000-000000000002', 'adult@example.test'),
  ('20000000-0000-4000-8000-000000000003', 'child@example.test'),
  ('20000000-0000-4000-8000-000000000004', 'inactive@example.test'),
  ('20000000-0000-4000-8000-000000000005', 'foreign@example.test');

INSERT INTO public.families(id, name, created_by) VALUES
  ('10000000-0000-4000-8000-000000000001', 'Synthetic family A', '20000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002', 'Synthetic family B', '20000000-0000-4000-8000-000000000005');

INSERT INTO public.family_members(id, family_id, user_id, role, display_name, is_active) VALUES
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'parent', 'Synthetic Parent', true),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 'adult', 'Synthetic Adult', true),
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000003', 'child', 'Synthetic Child', true),
  ('30000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000004', 'parent', 'Synthetic Inactive', false),
  ('30000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 'parent', 'Synthetic Foreign', true);

INSERT INTO public.moves
  (id, family_id, title, from_address, to_address, move_date, move_kind,
   budget_cents, spent_cents, mover_name, mover_phone, mover_quote_cents,
   has_kids, has_pets, is_renting_out, notes, created_by)
VALUES
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Synthetic move', '1 Example Lane', '2 Example Lane',
   DATE '2026-09-06', 'local', 50000, 1200, 'Example Movers', '+1 2025550100',
   10000, true, false, true, 'KEEP move notes', '20000000-0000-4000-8000-000000000001');

INSERT INTO public.moves(id, family_id, title, move_date, status) VALUES
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'Foreign move', DATE '2026-09-06', 'planning'),
  ('40000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'Done move', DATE '2026-09-06', 'done'),
  ('40000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'Cancelled move', DATE '2026-09-06', 'cancelled'),
  ('40000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'Lower overflow move', DATE '0002-01-01', 'planning'),
  ('40000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001', 'Upper overflow move', DATE '9998-12-31', 'planning'),
  ('40000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000001', 'Corrupt child family move', DATE '2026-09-06', 'planning'),
  ('40000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000001', 'Task limit move', DATE '2026-09-06', 'planning'),
  ('40000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000001', 'Empty boundary move', DATE '2026-09-06', 'planning');

-- Fixed rows intentionally omit date_mode, even with nonzero offsets/template
-- keys. This exercises the legacy/default policy without inferring intent.
INSERT INTO public.move_tasks
  (id, family_id, move_id, title, status, offset_days, due_date, completed_at,
   assignee_id, notes, template_key, created_by)
VALUES
  ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Legacy fixed', 'todo', -5, DATE '2026-09-01', NULL::timestamptz, '30000000-0000-4000-8000-000000000002', 'KEEP task notes', 'synthetic-template', '20000000-0000-4000-8000-000000000001'),
  ('50000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Done fixed', 'done', 0, DATE '2026-09-06', NULL::timestamptz, '30000000-0000-4000-8000-000000000002', 'KEEP task notes', 'synthetic-template', '20000000-0000-4000-8000-000000000001'),
  ('50000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Skipped fixed', 'skipped', 0, NULL::date, NULL::timestamptz, '30000000-0000-4000-8000-000000000002', 'KEEP task notes', 'synthetic-template', '20000000-0000-4000-8000-000000000001'),
  ('50000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Fixed without date', 'todo', 0, NULL::date, NULL::timestamptz, '30000000-0000-4000-8000-000000000002', 'KEEP task notes', 'synthetic-template', '20000000-0000-4000-8000-000000000001');

INSERT INTO public.move_tasks
  (id, family_id, move_id, title, status, offset_days, due_date, completed_at,
   assignee_id, notes, template_key, created_by, date_mode)
VALUES
  ('50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Relative todo', 'todo', -7, DATE '2026-08-30', NULL::timestamptz, '30000000-0000-4000-8000-000000000002', 'KEEP task notes', 'synthetic-template', '20000000-0000-4000-8000-000000000001', 'relative'),
  ('50000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Relative doing', 'doing', 2, DATE '2026-09-08', NULL::timestamptz, '30000000-0000-4000-8000-000000000002', 'KEEP task notes', 'synthetic-template', '20000000-0000-4000-8000-000000000001', 'relative'),
  ('50000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Done without completion timestamp', 'done', -1, DATE '2026-09-05', NULL::timestamptz, '30000000-0000-4000-8000-000000000002', 'KEEP task notes', 'synthetic-template', '20000000-0000-4000-8000-000000000001', 'relative'),
  ('50000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Skipped relative', 'skipped', 0, DATE '2026-09-06', NULL::timestamptz, '30000000-0000-4000-8000-000000000002', 'KEEP task notes', 'synthetic-template', '20000000-0000-4000-8000-000000000001', 'relative'),
  ('50000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Todo with completion timestamp', 'todo', 1, DATE '2026-09-07', TIMESTAMPTZ '2026-09-01 12:00:00+00', '30000000-0000-4000-8000-000000000002', 'KEEP task notes', 'synthetic-template', '20000000-0000-4000-8000-000000000001', 'relative'),
  ('50000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Relative without date', 'doing', 0, NULL::date, NULL::timestamptz, '30000000-0000-4000-8000-000000000002', 'KEEP task notes', 'synthetic-template', '20000000-0000-4000-8000-000000000001', 'relative'),
  ('50000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Manually rescheduled relative', 'todo', -3, DATE '2026-09-01', NULL::timestamptz, '30000000-0000-4000-8000-000000000002', 'KEEP task notes', 'synthetic-template', '20000000-0000-4000-8000-000000000001', 'relative'),
  ('50000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Skipped with completion timestamp', 'skipped', 0, DATE '2026-09-06', TIMESTAMPTZ '2026-09-01 12:00:00+00', '30000000-0000-4000-8000-000000000002', 'KEEP task notes', 'synthetic-template', '20000000-0000-4000-8000-000000000001', 'relative');

INSERT INTO public.move_tasks
  (id, family_id, move_id, title, date_mode, offset_days, due_date)
VALUES
  ('50000000-0000-4000-8000-000000000020', '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000005', 'Lower boundary relative', 'relative', -365, DATE '0001-01-01'),
  ('50000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000006', 'Upper boundary relative', 'relative', 365, DATE '9999-12-31'),
  ('50000000-0000-4000-8000-000000000022', '10000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000007', 'FOREIGN TASK MUST NOT APPEAR', 'fixed', 0, DATE '2026-09-06');

INSERT INTO public.move_boxes
  (id, family_id, move_id, box_number, label, from_room, to_room, contents,
   is_fragile, is_essential, status, packed_by, photo_path, notes)
VALUES
  ('80000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 1, 'KEEP box label',
   'Kitchen', 'Kitchen', ARRAY['Synthetic cup'], true, true, 'packed',
   '30000000-0000-4000-8000-000000000001', 'https://example.test/synthetic-box.jpg', 'KEEP box notes');

-- All instrumentation is created after seed writes and disappears at ROLLBACK.
CREATE TRIGGER test_0269_moves_writes
  AFTER INSERT OR UPDATE OR DELETE ON public.moves
  FOR EACH ROW EXECUTE FUNCTION public.test_0269_observe_write();
CREATE TRIGGER test_0269_tasks_writes
  AFTER INSERT OR UPDATE OR DELETE ON public.move_tasks
  FOR EACH ROW EXECUTE FUNCTION public.test_0269_observe_write();
CREATE TRIGGER test_0269_boxes_writes
  AFTER INSERT OR UPDATE OR DELETE ON public.move_boxes
  FOR EACH ROW EXECUTE FUNCTION public.test_0269_observe_write();
CREATE TRIGGER test_0269_history_writes
  AFTER INSERT OR UPDATE OR DELETE ON public.move_date_recalculations
  FOR EACH ROW EXECUTE FUNCTION public.test_0269_observe_write();
CREATE TRIGGER zz_test_0269_injected_failure
  BEFORE UPDATE ON public.move_tasks
  FOR EACH ROW EXECUTE FUNCTION public.test_0269_fail_task_update();

SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000001', true);

DO $preview$
DECLARE
  v_before jsonb := public.test_0269_snapshot();
  v_actual jsonb;
  v_expected_tasks jsonb;
  v_expected jsonb;
BEGIN
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', expected.id, 'title', expected.title, 'status', expected.status,
    'mode', expected.mode, 'offsetDays', expected.offset_days,
    'dueDate', expected.due_date, 'nextDueDate', expected.next_due_date,
    'updatedAt', task.updated_at, 'action', expected.action, 'reason', expected.reason
  ) ORDER BY expected.id)
  INTO v_expected_tasks
  FROM (VALUES
      ('50000000-0000-4000-8000-000000000001'::uuid, 'Legacy fixed', 'todo', 'fixed', -5, DATE '2026-09-01', DATE '2026-09-01', 'preserve', 'fixed'),
      ('50000000-0000-4000-8000-000000000002'::uuid, 'Relative todo', 'todo', 'relative', -7, DATE '2026-08-30', DATE '2026-09-13', 'shift', 'relative'),
      ('50000000-0000-4000-8000-000000000003'::uuid, 'Relative doing', 'doing', 'relative', 2, DATE '2026-09-08', DATE '2026-09-22', 'shift', 'relative'),
      ('50000000-0000-4000-8000-000000000004'::uuid, 'Done without completion timestamp', 'done', 'relative', -1, DATE '2026-09-05', DATE '2026-09-05', 'preserve', 'completed'),
      ('50000000-0000-4000-8000-000000000005'::uuid, 'Skipped relative', 'skipped', 'relative', 0, DATE '2026-09-06', DATE '2026-09-06', 'preserve', 'skipped'),
      ('50000000-0000-4000-8000-000000000006'::uuid, 'Todo with completion timestamp', 'todo', 'relative', 1, DATE '2026-09-07', DATE '2026-09-07', 'preserve', 'completed'),
      ('50000000-0000-4000-8000-000000000007'::uuid, 'Relative without date', 'doing', 'relative', 0, NULL::date, NULL::date, 'preserve', 'no_date'),
      ('50000000-0000-4000-8000-000000000008'::uuid, 'Manually rescheduled relative', 'todo', 'relative', -3, DATE '2026-09-01', DATE '2026-09-01', 'preserve', 'out_of_sync'),
      ('50000000-0000-4000-8000-000000000009'::uuid, 'Skipped with completion timestamp', 'skipped', 'relative', 0, DATE '2026-09-06', DATE '2026-09-06', 'preserve', 'completed'),
      ('50000000-0000-4000-8000-000000000010'::uuid, 'Done fixed', 'done', 'fixed', 0, DATE '2026-09-06', DATE '2026-09-06', 'preserve', 'completed'),
      ('50000000-0000-4000-8000-000000000011'::uuid, 'Skipped fixed', 'skipped', 'fixed', 0, NULL::date, NULL::date, 'preserve', 'skipped'),
      ('50000000-0000-4000-8000-000000000012'::uuid, 'Fixed without date', 'todo', 'fixed', 0, NULL::date, NULL::date, 'preserve', 'fixed')
  ) AS expected(id, title, status, mode, offset_days, due_date, next_due_date, action, reason)
  JOIN public.move_tasks AS task ON task.id = expected.id;

  v_expected := pg_catalog.jsonb_build_object(
    'version', 1, 'familyId', '10000000-0000-4000-8000-000000000001'::uuid, 'moveId', '40000000-0000-4000-8000-000000000001'::uuid,
    'memberId', '30000000-0000-4000-8000-000000000001'::uuid, 'fromDate', DATE '2026-09-06', 'toDate', DATE '2026-09-20',
    'moveUpdatedAt', (SELECT updated_at FROM public.moves WHERE id = '40000000-0000-4000-8000-000000000001'),
    'tasks', v_expected_tasks, 'changes', 2
  );
  v_actual := public.move_recalculate_date('10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', DATE '2026-09-20');

  PERFORM public.test_0269_assert(
    pg_catalog.jsonb_array_length(v_expected_tasks) = 12
      AND v_actual = pg_catalog.jsonb_build_object(
        'preview', v_expected, 'applied', false, 'requestId', NULL, 'appliedAt', NULL
      ),
    'preview_exact_keys_sorted_tasks_reason_priority_and_two_changes'
  );
  PERFORM public.test_0269_assert(public.test_0269_snapshot() = v_before, 'preview_read_only');
  PERFORM public.test_0269_assert((
    SELECT date_mode = 'fixed' AND offset_days = -5 AND template_key IS NOT NULL
    FROM public.move_tasks WHERE id = '50000000-0000-4000-8000-000000000001'
  ), 'legacy_template_offset_does_not_opt_in');
  INSERT INTO public.test_0269_state(name, payload) VALUES ('review', v_actual->'preview');
END;
$preview$;

SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000001''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''2026-09-20'', (SELECT payload FROM public.test_0269_state WHERE name = ''review'') || ''{"unexpected":true}''::jsonb, ''60000000-0000-4000-8000-000000000002''::uuid)', '40001', 'whole_snapshot_extra_key_rejected', 'stale_review', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000001''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''2026-09-20'', pg_catalog.jsonb_set((SELECT payload FROM public.test_0269_state WHERE name = ''review''), ''{tasks}'', (SELECT pg_catalog.jsonb_agg(item.value ORDER BY item.ordinality DESC) FROM pg_catalog.jsonb_array_elements((SELECT payload FROM public.test_0269_state WHERE name = ''review'')->''tasks'') WITH ORDINALITY AS item(value, ordinality))), ''60000000-0000-4000-8000-000000000002''::uuid)', '40001', 'whole_snapshot_task_order_rejected', 'stale_review', true);

-- A real intervening task edit invalidates the old review. Keep that manual edit
-- as the new baseline; the recalculation must preserve the edited title.
UPDATE public.move_tasks SET title = 'Legacy fixed after manual edit' WHERE id = '50000000-0000-4000-8000-000000000001';
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000001''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''2026-09-20'', (SELECT payload FROM public.test_0269_state WHERE name = ''review''), ''60000000-0000-4000-8000-000000000002''::uuid)', '40001', 'intervening_task_edit_stale', 'stale_review', true);
UPDATE public.test_0269_state
SET payload = public.move_recalculate_date('10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', DATE '2026-09-20')->'preview'
WHERE name = 'review';

-- The actual RPC inserts history and updates the move before task UPDATE.
-- A known task-trigger failure must roll ALL those effects back, including logs.
SELECT pg_catalog.set_config('bubaly_0269.inject_task_failure', 'on', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000001''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''2026-09-20'', (SELECT payload FROM public.test_0269_state WHERE name = ''review''), ''60000000-0000-4000-8000-000000000001''::uuid)', 'P0269', 'injected_task_failure_atomic_rollback', '0269_injected_task_update_failure', true);
SELECT pg_catalog.set_config('bubaly_0269.inject_task_failure', 'off', true);
SELECT public.test_0269_assert(
  NOT EXISTS (SELECT 1 FROM public.move_date_recalculations WHERE request_id = '60000000-0000-4000-8000-000000000001')
    AND (SELECT move_date = DATE '2026-09-06' FROM public.moves WHERE id = '40000000-0000-4000-8000-000000000001'),
  'injected_failure_leaves_no_receipt_or_move_change'
);

INSERT INTO public.test_0269_state(name, payload) VALUES ('before_apply', public.test_0269_snapshot());
INSERT INTO public.test_0269_state(name, payload)
SELECT 'applied', public.move_recalculate_date(
  '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', DATE '2026-09-20', (SELECT payload FROM public.test_0269_state WHERE name = 'review'), '60000000-0000-4000-8000-000000000001'
);

DO $applied$
DECLARE
  v_before jsonb := (SELECT payload FROM public.test_0269_state WHERE name = 'before_apply');
  v_review jsonb := (SELECT payload FROM public.test_0269_state WHERE name = 'review');
  v_result jsonb := (SELECT payload FROM public.test_0269_state WHERE name = 'applied');
  v_time timestamptz := (v_result->>'appliedAt')::timestamptz;
  v_old_move jsonb;
BEGIN
  SELECT item.value INTO v_old_move
  FROM pg_catalog.jsonb_array_elements(v_before->'moves') AS item(value)
  WHERE item.value->>'id' = '40000000-0000-4000-8000-000000000001';

  PERFORM public.test_0269_assert(
    v_time IS NOT NULL AND v_result = pg_catalog.jsonb_build_object(
      'preview', v_review, 'applied', true, 'requestId', '60000000-0000-4000-8000-000000000001'::uuid, 'appliedAt', v_time
    ), 'apply_exact_result_and_review'
  );
  PERFORM public.test_0269_assert((
    SELECT move_date = DATE '2026-09-20'
      AND (pg_catalog.to_jsonb(move) - ARRAY['move_date', 'updated_at'])
        = (v_old_move - ARRAY['move_date', 'updated_at'])
    FROM public.moves AS move WHERE move.id = '40000000-0000-4000-8000-000000000001'
  ), 'apply_only_move_date_and_automatic_timestamp');
  PERFORM public.test_0269_assert((
    SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(task) - ARRAY['due_date', 'updated_at'] ORDER BY task.id)
    FROM public.move_tasks AS task
  ) = (
    SELECT pg_catalog.jsonb_agg(item.value - ARRAY['due_date', 'updated_at'] ORDER BY item.value->>'id')
    FROM pg_catalog.jsonb_array_elements(v_before->'tasks') AS item(value)
  ), 'apply_keeps_task_titles_modes_offsets_status_owners_notes_and_metadata');
  PERFORM public.test_0269_assert((
    SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(task) ORDER BY task.id)
    FROM public.move_tasks AS task WHERE task.id NOT IN ('50000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000003')
  ) = (
    SELECT pg_catalog.jsonb_agg(item.value ORDER BY item.value->>'id')
    FROM pg_catalog.jsonb_array_elements(v_before->'tasks') AS item(value)
    WHERE item.value->>'id' NOT IN ('50000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000003')
  ), 'apply_preserves_every_ineligible_task_entirely');
  PERFORM public.test_0269_assert(
    (SELECT due_date = DATE '2026-09-13' FROM public.move_tasks WHERE id = '50000000-0000-4000-8000-000000000002')
      AND (SELECT due_date = DATE '2026-09-22' FROM public.move_tasks WHERE id = '50000000-0000-4000-8000-000000000003'),
    'apply_shifts_only_relative_unfinished_dates'
  );
  PERFORM public.test_0269_assert(
    public.test_0269_snapshot()->'boxes' = v_before->'boxes', 'apply_keeps_boxes_entirely'
  );
  PERFORM public.test_0269_assert((
    SELECT pg_catalog.to_jsonb(history) = pg_catalog.jsonb_build_object(
      'request_id', '60000000-0000-4000-8000-000000000001'::uuid, 'family_id', '10000000-0000-4000-8000-000000000001'::uuid, 'move_id', '40000000-0000-4000-8000-000000000001'::uuid,
      'actor_user_id', '20000000-0000-4000-8000-000000000001'::uuid, 'actor_member_id', '30000000-0000-4000-8000-000000000001'::uuid,
      'from_date', DATE '2026-09-06', 'to_date', DATE '2026-09-20',
      'reviewed', v_review, 'result', v_result, 'created_at', v_time
    )
    FROM public.move_date_recalculations AS history WHERE request_id = '60000000-0000-4000-8000-000000000001'
  ), 'history_exact_immutable_provenance_and_timestamp');
  PERFORM public.test_0269_assert(
    (SELECT pg_catalog.count(*) FROM public.move_date_recalculations) = 1
      AND (SELECT pg_catalog.count(*) FROM public.test_0269_writes)
        - pg_catalog.jsonb_array_length(v_before->'writes') = 4,
    'apply_exactly_one_move_two_tasks_and_one_receipt_write'
  );
END;
$applied$;

INSERT INTO public.test_0269_state(name, payload) VALUES ('before_replay', public.test_0269_snapshot());
SELECT public.test_0269_assert(
  public.move_recalculate_date('10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', DATE '2026-09-20', (SELECT payload FROM public.test_0269_state WHERE name = 'review'), '60000000-0000-4000-8000-000000000001')
    = (SELECT payload FROM public.test_0269_state WHERE name = 'applied'), 'idempotent_replay_exact_original_result_and_timestamp'
);
SELECT public.test_0269_assert(
  public.test_0269_snapshot() = (SELECT payload FROM public.test_0269_state WHERE name = 'before_replay'), 'idempotent_replay_no_writes'
);

-- Legitimate intervening move changes must not invalidate an already committed
-- receipt. This is an explicit fixture mutation, not another recalculation.
UPDATE public.moves SET status = 'done', move_date = DATE '2026-10-01' WHERE id = '40000000-0000-4000-8000-000000000001';
INSERT INTO public.test_0269_state(name, payload) VALUES ('before_closed_replay', public.test_0269_snapshot());
SELECT public.test_0269_assert(
  public.move_recalculate_date('10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', DATE '2026-09-20', (SELECT payload FROM public.test_0269_state WHERE name = 'review'), '60000000-0000-4000-8000-000000000001')
    = (SELECT payload FROM public.test_0269_state WHERE name = 'applied'), 'committed_retry_precedes_changed_date_and_closed_state'
);
SELECT public.test_0269_assert(
  public.test_0269_snapshot() = (SELECT payload FROM public.test_0269_state WHERE name = 'before_closed_replay'), 'closed_replay_no_writes'
);

SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000001''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''2026-09-21'', (SELECT payload FROM public.test_0269_state WHERE name = ''review''), ''60000000-0000-4000-8000-000000000001''::uuid)', '23505', 'request_uuid_different_date', 'idempotency_conflict', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000001''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''2026-09-20'', (SELECT payload FROM public.test_0269_state WHERE name = ''review'') || ''{"changes":99}''::jsonb, ''60000000-0000-4000-8000-000000000001''::uuid)', '23505', 'request_uuid_different_snapshot', 'idempotency_conflict', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000003''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''2026-09-20'', (SELECT payload FROM public.test_0269_state WHERE name = ''review''), ''60000000-0000-4000-8000-000000000001''::uuid)', '23505', 'request_uuid_different_move', 'idempotency_conflict', true);

SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000099''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''2026-09-20'')', 'P0002', 'fresh_missing_move', 'unavailable_move', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000002''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''2026-09-20'')', 'P0002', 'foreign_move_unavailable', 'unavailable_move', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000007''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''2026-09-20'')', 'P0002', 'mismatching_child_family_unavailable', 'unavailable_move', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000003''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''2026-09-20'')', '22023', 'fresh_done_move', 'move_closed', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000004''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''2026-09-20'')', '22023', 'fresh_cancelled_move', 'move_closed', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000009''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''2026-09-06'')', '22023', 'fresh_same_date_preview', 'same_move_date', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000009''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''2026-09-06'', (SELECT payload FROM public.test_0269_state WHERE name = ''review''), ''60000000-0000-4000-8000-000000000003''::uuid)', '22023', 'fresh_same_date_apply', 'same_move_date', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000009''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''2026-09-20'', (SELECT payload FROM public.test_0269_state WHERE name = ''review''), NULL::uuid)', '22023', 'review_without_request_id', 'expected_and_request_id_required_together', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000009''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''2026-09-20'', NULL::jsonb, ''60000000-0000-4000-8000-000000000003''::uuid)', '22023', 'request_id_without_review', 'expected_and_request_id_required_together', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000009''::uuid, ''30000000-0000-4000-8000-000000000002''::uuid, DATE ''2026-09-20'')', '42501', 'forged_member_id', 'authorization', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000002''::uuid, ''40000000-0000-4000-8000-000000000002''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''2026-09-20'')', '42501', 'client_cannot_choose_other_family', 'authorization', true);

SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000009''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, NULL::date)', '22008', 'invalid_null_date', 'invalid_date', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000009''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''0001-01-01 BC'')', '22008', 'invalid_bc_date', 'invalid_date', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000009''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''10000-01-01'')', '22008', 'invalid_year_10000', 'invalid_date', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000009''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, ''infinity''::date)', '22008', 'invalid_positive_infinity', 'invalid_date', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000009''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, ''-infinity''::date)', '22008', 'invalid_negative_infinity', 'invalid_date', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000009''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, ''2026-02-30''::date)', '22008', 'invalid_calendar_day', NULL, true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000009''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, ''0000-01-01''::date)', '22008', 'invalid_calendar_year_zero', NULL, true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000005''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''0001-01-01'')', '22008', 'relative_result_underflow', 'result_date_out_of_range', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000006''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''9999-12-31'')', '22008', 'relative_result_overflow', 'result_date_out_of_range', true);
SELECT public.test_0269_expect_error('UPDATE public.move_tasks SET offset_days = 366 WHERE id = ''50000000-0000-4000-8000-000000000020''', '23514', 'offset_upper_constraint', NULL, true);
SELECT public.test_0269_expect_error('UPDATE public.move_tasks SET offset_days = -366 WHERE id = ''50000000-0000-4000-8000-000000000020''', '23514', 'offset_lower_constraint', NULL, true);
SELECT public.test_0269_expect_error('UPDATE public.move_tasks SET date_mode = ''floating'' WHERE id = ''50000000-0000-4000-8000-000000000001''', '23514', 'date_mode_constraint', NULL, true);
SELECT public.test_0269_expect_error('UPDATE public.move_tasks SET date_mode = NULL WHERE id = ''50000000-0000-4000-8000-000000000001''', '23502', 'date_mode_not_null', NULL, true);

INSERT INTO public.test_0269_state(name, payload) VALUES ('before_boundary_previews', public.test_0269_snapshot());
SELECT public.test_0269_assert(
  public.move_recalculate_date('10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000009', '30000000-0000-4000-8000-000000000001', DATE '0001-01-01')->'preview'->>'toDate' = '0001-01-01'
    AND public.move_recalculate_date('10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000009', '30000000-0000-4000-8000-000000000001', DATE '9999-12-31')->'preview'->>'toDate' = '9999-12-31',
  'valid_calendar_endpoints_accepted'
);
SELECT public.test_0269_assert(
  public.test_0269_snapshot() = (SELECT payload FROM public.test_0269_state WHERE name = 'before_boundary_previews'), 'boundary_previews_no_writes'
);

SELECT public.test_0269_assert(
  pg_catalog.has_function_privilege('authenticated', 'public.move_recalculate_date(uuid,uuid,uuid,date,jsonb,uuid)', 'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('anon', 'public.move_recalculate_date(uuid,uuid,uuid,date,jsonb,uuid)', 'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('service_role', 'public.move_recalculate_date(uuid,uuid,uuid,date,jsonb,uuid)', 'EXECUTE')
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))) AS privilege
      WHERE procedure.oid = 'public.move_recalculate_date(uuid,uuid,uuid,date,jsonb,uuid)'::regprocedure
        AND privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
    ),
  'rpc_execute_authenticated_only_without_public_grant'
);
SELECT public.test_0269_assert(
  (SELECT pg_catalog.count(*) FROM public.move_date_recalculations) = 1,
  'parent_history_visible'
);
SELECT public.test_0269_expect_error('INSERT INTO public.move_date_recalculations SELECT * FROM public.move_date_recalculations', '42501', 'authenticated_history_insert_denied', NULL, true);
SELECT public.test_0269_expect_error('UPDATE public.move_date_recalculations SET result = result WHERE request_id = ''60000000-0000-4000-8000-000000000001''', '42501', 'authenticated_history_update_denied', NULL, true);
SELECT public.test_0269_expect_error('DELETE FROM public.move_date_recalculations WHERE request_id = ''60000000-0000-4000-8000-000000000001''', '42501', 'authenticated_history_delete_denied', NULL, true);
SELECT public.test_0269_expect_error('TRUNCATE TABLE public.move_date_recalculations', '42501', 'authenticated_history_truncate_denied', NULL, true);

SELECT pg_catalog.set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
INSERT INTO public.test_0269_state(name, payload) VALUES ('before_adult_preview', public.test_0269_snapshot());
SELECT public.test_0269_assert(
  public.move_recalculate_date('10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000009', '30000000-0000-4000-8000-000000000002', DATE '2026-09-20')->'preview'->>'memberId' = '30000000-0000-4000-8000-000000000002'
    AND (SELECT pg_catalog.count(*) FROM public.move_date_recalculations) = 1,
  'active_adult_preview_authorized_and_history_visible'
);
SELECT public.test_0269_assert(
  public.test_0269_snapshot() = (SELECT payload FROM public.test_0269_state WHERE name = 'before_adult_preview'), 'adult_preview_no_writes'
);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000001''::uuid, ''30000000-0000-4000-8000-000000000002''::uuid, DATE ''2026-09-20'', (SELECT payload FROM public.test_0269_state WHERE name = ''review''), ''60000000-0000-4000-8000-000000000001''::uuid)', '23505', 'request_uuid_different_actor', 'idempotency_conflict', true);

SELECT pg_catalog.set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000003', true);
SELECT public.test_0269_assert((SELECT pg_catalog.count(*) FROM public.move_date_recalculations) = 0, 'child_history_hidden');
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000009''::uuid, ''30000000-0000-4000-8000-000000000003''::uuid, DATE ''2026-09-20'')', '42501', 'child_authorization_denied', 'authorization', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000001''::uuid, ''30000000-0000-4000-8000-000000000003''::uuid, DATE ''2026-09-20'', (SELECT payload FROM public.test_0269_state WHERE name = ''review''), ''60000000-0000-4000-8000-000000000001''::uuid)', '42501', 'child_receipt_replay_still_denied', 'authorization', true);

SELECT pg_catalog.set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000004', true);
SELECT public.test_0269_assert((SELECT pg_catalog.count(*) FROM public.move_date_recalculations) = 0, 'inactive_history_hidden');
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000009''::uuid, ''30000000-0000-4000-8000-000000000004''::uuid, DATE ''2026-09-20'')', '42501', 'inactive_authorization_denied', 'authorization', true);

SELECT pg_catalog.set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000005', true);
SELECT public.test_0269_assert((SELECT pg_catalog.count(*) FROM public.move_date_recalculations) = 0, 'foreign_family_history_hidden');
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000009''::uuid, ''30000000-0000-4000-8000-000000000005''::uuid, DATE ''2026-09-20'')', '42501', 'foreign_actor_authorization_denied', 'authorization', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000002''::uuid, ''40000000-0000-4000-8000-000000000002''::uuid, ''30000000-0000-4000-8000-000000000005''::uuid, DATE ''2026-09-20'', (SELECT payload FROM public.test_0269_state WHERE name = ''review''), ''60000000-0000-4000-8000-000000000001''::uuid)', '23505', 'request_uuid_different_family', 'idempotency_conflict', true);

SELECT pg_catalog.set_config('request.jwt.claim.sub', '', true);
SELECT public.test_0269_assert((SELECT pg_catalog.count(*) FROM public.move_date_recalculations) = 0, 'signed_out_history_hidden');
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000009''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''2026-09-20'')', '42501', 'signed_out_authorization_denied', 'authorization', true);

-- Change the exact actor's current membership after its successful request:
-- both history reads and idempotent retries must reauthorize current membership.
RESET ROLE;
UPDATE public.family_members SET is_active = false WHERE id = '30000000-0000-4000-8000-000000000001';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000001', true);
SELECT public.test_0269_assert((SELECT pg_catalog.count(*) FROM public.move_date_recalculations) = 0, 'revoked_actor_history_hidden');
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000001''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''2026-09-20'', (SELECT payload FROM public.test_0269_state WHERE name = ''review''), ''60000000-0000-4000-8000-000000000001''::uuid)', '42501', 'revoked_actor_receipt_replay_denied', 'authorization', true);
RESET ROLE;
UPDATE public.family_members SET is_active = true WHERE id = '30000000-0000-4000-8000-000000000001';

-- Anonymous role cannot invoke the RPC even with the parent's synthetic JWT.
-- Capture/compare globally as fixture administrator because anon cannot SELECT
-- the source tables. The operation itself still executes under SET ROLE anon.
INSERT INTO public.test_0269_state(name, payload) VALUES ('before_anon', public.test_0269_snapshot());
SET ROLE anon;
SELECT pg_catalog.set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000001', true);
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000009''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''2026-09-20'')', '42501', 'anon_rpc_execute_denied', NULL, false);
SELECT public.test_0269_expect_error('SELECT * FROM public.move_date_recalculations', '42501', 'anon_history_select_denied', NULL, false);
RESET ROLE;
SELECT public.test_0269_assert(public.test_0269_snapshot() = (SELECT payload FROM public.test_0269_state WHERE name = 'before_anon'), 'anon_attempts_no_global_writes');

-- Fixture-admin calls reach the actual immutable-history triggers, proving
-- protection beyond the authenticated privilege checks above.
SELECT public.test_0269_expect_error('UPDATE public.move_date_recalculations SET result = result WHERE request_id = ''60000000-0000-4000-8000-000000000001''', '42501', 'history_update_trigger_immutable', 'immutable_move_date_recalculation', true);
SELECT public.test_0269_expect_error('DELETE FROM public.move_date_recalculations WHERE request_id = ''60000000-0000-4000-8000-000000000001''', '42501', 'history_delete_trigger_immutable', 'immutable_move_date_recalculation', true);
SELECT public.test_0269_expect_error('TRUNCATE TABLE public.move_date_recalculations', '42501', 'history_truncate_trigger_immutable', 'immutable_move_date_recalculation', true);

SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000001', true);
-- The large fixture is last so unrelated error cases need not resnapshot it.
INSERT INTO public.move_tasks(id, family_id, move_id, title, offset_days, due_date)
SELECT ('70000000-0000-4000-8000-' || pg_catalog.lpad(item::text, 12, '0'))::uuid,
  '10000000-0000-4000-8000-000000000001'::uuid, '40000000-0000-4000-8000-000000000008'::uuid, 'Synthetic fixed task ' || item, 0, DATE '2026-09-06'
FROM pg_catalog.generate_series(1, 1000) AS item;
INSERT INTO public.test_0269_state(name, payload) VALUES ('before_limit_preview', public.test_0269_snapshot());
DO $limit$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.move_recalculate_date('10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000008', '30000000-0000-4000-8000-000000000001', DATE '2026-09-20');
  PERFORM public.test_0269_assert(
    pg_catalog.jsonb_array_length(v_result->'preview'->'tasks') = 1000
      AND (v_result->'preview'->>'changes')::integer = 0
      AND v_result->'applied' = 'false'::jsonb,
    'exactly_1000_tasks_preview_accepted'
  );
END;
$limit$;
SELECT public.test_0269_assert(
  public.test_0269_snapshot() = (SELECT payload FROM public.test_0269_state WHERE name = 'before_limit_preview'), 'limit_preview_no_writes'
);
INSERT INTO public.move_tasks(id, family_id, move_id, title)
VALUES ('70000000-0000-4000-8000-000000001001', '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000008', 'Synthetic task 1001');
SELECT public.test_0269_expect_error('SELECT public.move_recalculate_date(''10000000-0000-4000-8000-000000000001''::uuid, ''40000000-0000-4000-8000-000000000008''::uuid, ''30000000-0000-4000-8000-000000000001''::uuid, DATE ''2026-09-20'')', '54000', 'over_1000_tasks_refused', 'too_many_move_tasks', true);

RESET ROLE;
SELECT '0269_OK ' || name FROM public.test_0269_proofs ORDER BY name;
SELECT '0269_PROOF_COUNT ' || pg_catalog.count(*)::text FROM public.test_0269_proofs;
SELECT '0269_UNPROVEN concurrent_relative_insert_consistency_and_multi_session_lock_races';
ROLLBACK;
