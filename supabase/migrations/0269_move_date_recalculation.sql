-- 0269: reviewed, atomic move-date recalculation.
-- Legacy tasks are deliberately fixed; neither intent nor new tasks are inferred.
-- UNPUBLISHED: schema rollout and parent integration remain separate work.

ALTER TABLE public.move_tasks
  ADD COLUMN date_mode text NOT NULL DEFAULT 'fixed'
    CONSTRAINT move_tasks_date_mode_check CHECK (date_mode IN ('fixed', 'relative'));

CREATE TABLE public.move_date_recalculations (
  request_id         uuid PRIMARY KEY,
  family_id          uuid NOT NULL,
  move_id            uuid NOT NULL,
  actor_user_id      uuid NOT NULL,
  actor_member_id    uuid NOT NULL,
  from_date          date NOT NULL
    CHECK (from_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  to_date            date NOT NULL
    CHECK (to_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  reviewed  jsonb NOT NULL
    CHECK (pg_catalog.jsonb_typeof(reviewed) = 'object'),
  result             jsonb NOT NULL
    CHECK (pg_catalog.jsonb_typeof(result) = 'object'),
  created_at         timestamptz NOT NULL
);

-- Provenance IDs intentionally have no cascading/SET NULL foreign keys:
-- deleting a source move, membership, or account must not rewrite the record
-- or erase a successful request's idempotency identity.
CREATE INDEX idx_move_date_recalculations_family_move_created
  ON public.move_date_recalculations (family_id, move_id, created_at DESC);

ALTER TABLE public.move_date_recalculations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.move_date_recalculations
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.move_date_recalculations TO authenticated;

CREATE POLICY move_date_recalculations_parent_read
  ON public.move_date_recalculations
  FOR SELECT TO authenticated
  USING (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.family_members AS member
      WHERE member.family_id = public.move_date_recalculations.family_id
        AND member.user_id = auth.uid()
        AND member.is_active IS TRUE
        AND member.role IN ('parent', 'adult')
    )
  );

-- No family-wide write policy, mutable audit columns, or privileged rewrite
-- path. These triggers also prevent accidental maintenance DML/TRUNCATE.
CREATE FUNCTION public.move_date_recalculations_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '42501',
    MESSAGE = 'immutable_move_date_recalculation';
END;
$function$;

REVOKE ALL ON FUNCTION public.move_date_recalculations_reject_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER move_date_recalculations_immutable_rows
  BEFORE UPDATE OR DELETE ON public.move_date_recalculations
  FOR EACH ROW
  EXECUTE FUNCTION public.move_date_recalculations_reject_mutation();

CREATE TRIGGER move_date_recalculations_immutable_truncate
  BEFORE TRUNCATE ON public.move_date_recalculations
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.move_date_recalculations_reject_mutation();

CREATE FUNCTION public.move_recalculate_date(
  p_family_id uuid,
  p_move_id uuid,
  p_member_id uuid,
  p_new_date date,
  p_expected jsonb DEFAULT NULL,
  p_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET timezone = 'UTC'
SET datestyle = 'ISO, YMD'
AS $function$
DECLARE
  v_user_id uuid;
  v_member_id uuid;
  v_move public.moves%ROWTYPE;
  v_task public.move_tasks%ROWTYPE;
  v_history public.move_date_recalculations%ROWTYPE;
  v_task_ids uuid[];
  v_shift_ids uuid[] := ARRAY[]::uuid[];
  v_tasks jsonb := '[]'::jsonb;
  v_preview jsonb;
  v_result jsonb;
  v_next_due_date date;
  v_action text;
  v_reason text;
  v_applied_at timestamptz;
  v_inserted_request_id uuid;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authorization';
  END IF;

  -- SHARE, not KEY SHARE: role/is_active/user_id changes usually acquire
  -- NO KEY UPDATE. Hold this lock through the caller's entire transaction.
  SELECT member.id
  INTO v_member_id
  FROM public.family_members AS member
  WHERE member.id = p_member_id
    AND member.family_id = p_family_id
    AND member.user_id = v_user_id
    AND member.is_active IS TRUE
    AND member.role IN ('parent', 'adult')
  FOR SHARE OF member;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authorization';
  END IF;

  -- Reauthorize even a retry. Check immutable provenance before consulting
  -- current move existence/date/status, so a lost response remains retryable.
  IF p_request_id IS NOT NULL THEN
    SELECT history.*
    INTO v_history
    FROM public.move_date_recalculations AS history
    WHERE history.request_id = p_request_id;

    IF FOUND THEN
      IF v_history.family_id IS NOT DISTINCT FROM p_family_id
        AND v_history.move_id IS NOT DISTINCT FROM p_move_id
        AND v_history.actor_user_id IS NOT DISTINCT FROM v_user_id
        AND v_history.actor_member_id IS NOT DISTINCT FROM v_member_id
        AND v_history.to_date IS NOT DISTINCT FROM p_new_date
        AND v_history.reviewed IS NOT DISTINCT FROM p_expected
      THEN
        RETURN v_history.result;
      END IF;
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'idempotency_conflict';
    END IF;
  END IF;

  IF (p_expected IS NULL) <> (p_request_id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'expected_and_request_id_required_together';
  END IF;
  IF p_new_date IS NULL
    OR p_new_date NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
  THEN
    RAISE EXCEPTION USING ERRCODE = '22008', MESSAGE = 'invalid_date';
  END IF;

  -- A fresh command snapshot AFTER taking the parent lock is essential:
  -- REPEATABLE READ could miss a child committed while that lock was waiting.
  -- PostgreSQL READ UNCOMMITTED has the same snapshots as READ COMMITTED.
  IF pg_catalog.current_setting('transaction_isolation')
    NOT IN ('read committed', 'read uncommitted')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'stale_review',
      DETAIL = 'Recalculate in a fresh READ COMMITTED transaction.';
  END IF;

  SELECT move.*
  INTO v_move
  FROM public.moves AS move
  WHERE move.id = p_move_id
    AND move.family_id = p_family_id
  FOR UPDATE OF move;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'unavailable_move';
  END IF;

  -- A same-move request may have committed while we waited for its row lock.
  -- This second lookup must also precede closed-state/date/snapshot checks.
  IF p_request_id IS NOT NULL THEN
    SELECT history.*
    INTO v_history
    FROM public.move_date_recalculations AS history
    WHERE history.request_id = p_request_id;

    IF FOUND THEN
      IF v_history.family_id IS NOT DISTINCT FROM p_family_id
        AND v_history.move_id IS NOT DISTINCT FROM p_move_id
        AND v_history.actor_user_id IS NOT DISTINCT FROM v_user_id
        AND v_history.actor_member_id IS NOT DISTINCT FROM v_member_id
        AND v_history.to_date IS NOT DISTINCT FROM p_new_date
        AND v_history.reviewed IS NOT DISTINCT FROM p_expected
      THEN
        RETURN v_history.result;
      END IF;
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'idempotency_conflict';
    END IF;
  END IF;

  IF p_new_date = v_move.move_date THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'same_move_date';
  END IF;
  IF v_move.status IN ('done', 'cancelled') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'move_closed';
  END IF;
  IF v_move.move_date NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' THEN
    RAISE EXCEPTION USING ERRCODE = '22008', MESSAGE = 'invalid_date';
  END IF;

  -- Lock ALL children before building any snapshot, including children whose
  -- family_id is corrupt. The 1001st row is only a refusal sentinel.
  -- The existing immediate move_id FK takes KEY SHARE on the move for inserts
  -- and moves of children between parents. It conflicts with our FOR UPDATE:
  -- earlier inserters finish before this fresh snapshot; later ones wait.
  SELECT COALESCE(pg_catalog.array_agg(locked.id ORDER BY locked.id), ARRAY[]::uuid[])
  INTO v_task_ids
  FROM (
    SELECT task.id
    FROM public.move_tasks AS task
    WHERE task.move_id = p_move_id
    ORDER BY task.id
    LIMIT 1001
    FOR UPDATE OF task
  ) AS locked;

  IF pg_catalog.cardinality(v_task_ids) > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = '54000', MESSAGE = 'too_many_move_tasks';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.move_tasks AS task
    WHERE task.id = ANY(v_task_ids)
      AND task.family_id IS DISTINCT FROM p_family_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'unavailable_move';
  END IF;

  FOR v_task IN
    SELECT task.*
    FROM public.move_tasks AS task
    WHERE task.id = ANY(v_task_ids)
    ORDER BY task.id
  LOOP
    IF v_task.offset_days NOT BETWEEN -365 AND 365 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_offset_days';
    END IF;
    IF v_task.due_date IS NOT NULL
      AND v_task.due_date NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
    THEN
      RAISE EXCEPTION USING ERRCODE = '22008', MESSAGE = 'invalid_date';
    END IF;

    v_next_due_date := v_task.due_date;
    v_action := 'preserve';

    IF v_task.completed_at IS NOT NULL OR v_task.status = 'done' THEN
      v_reason := 'completed';
    ELSIF v_task.status = 'skipped' THEN
      v_reason := 'skipped';
    ELSIF v_task.date_mode = 'fixed' THEN
      v_reason := 'fixed';
    ELSIF v_task.due_date IS NULL THEN
      v_reason := 'no_date';
    ELSIF v_task.status NOT IN ('todo', 'doing')
      OR v_task.due_date <> v_move.move_date + v_task.offset_days
    THEN
      v_reason := 'out_of_sync';
    ELSE
      v_reason := 'relative';
      v_next_due_date := p_new_date + v_task.offset_days;
      IF v_next_due_date NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' THEN
        RAISE EXCEPTION USING ERRCODE = '22008', MESSAGE = 'result_date_out_of_range';
      END IF;
      v_action := 'shift';
      v_shift_ids := pg_catalog.array_append(v_shift_ids, v_task.id);
    END IF;

    v_tasks := v_tasks || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'id', v_task.id,
        'title', v_task.title,
        'status', v_task.status,
        'mode', v_task.date_mode,
        'offsetDays', v_task.offset_days,
        'dueDate', v_task.due_date,
        'nextDueDate', v_next_due_date,
        'updatedAt', v_task.updated_at,
        'action', v_action,
        'reason', v_reason
      )
    );
  END LOOP;

  v_preview := pg_catalog.jsonb_build_object(
    'version', 1,
    'familyId', p_family_id,
    'moveId', p_move_id,
    'memberId', v_member_id,
    'fromDate', v_move.move_date,
    'toDate', p_new_date,
    'moveUpdatedAt', v_move.updated_at,
    'tasks', v_tasks,
    'changes', pg_catalog.cardinality(v_shift_ids)
  );

  IF p_expected IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'preview', v_preview,
      'applied', false,
      'requestId', NULL,
      'appliedAt', NULL
    );
  END IF;

  -- Compare the entire JSONB object, including ordering, timestamps, titles,
  -- reasons, preserved rows, and scope. No writes precede this comparison.
  IF v_preview IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'stale_review';
  END IF;

  v_applied_at := pg_catalog.clock_timestamp();
  v_result := pg_catalog.jsonb_build_object(
    'preview', v_preview,
    'applied', true,
    'requestId', p_request_id,
    'appliedAt', v_applied_at
  );

  -- Claim the global unique request before changing application rows.
  -- Different moves can race on a request UUID despite their own row locks.
  -- DO NOTHING never rewrites provenance; the next command sees the winner.
  INSERT INTO public.move_date_recalculations (
    request_id, family_id, move_id, actor_user_id, actor_member_id,
    from_date, to_date, reviewed, result, created_at
  )
  VALUES (
    p_request_id, p_family_id, p_move_id, v_user_id, v_member_id,
    v_move.move_date, p_new_date, p_expected, v_result, v_applied_at
  )
  ON CONFLICT (request_id) DO NOTHING
  RETURNING request_id INTO v_inserted_request_id;

  IF NOT FOUND THEN
    SELECT history.*
    INTO v_history
    FROM public.move_date_recalculations AS history
    WHERE history.request_id = p_request_id;

    IF FOUND
      AND v_history.family_id IS NOT DISTINCT FROM p_family_id
      AND v_history.move_id IS NOT DISTINCT FROM p_move_id
      AND v_history.actor_user_id IS NOT DISTINCT FROM v_user_id
      AND v_history.actor_member_id IS NOT DISTINCT FROM v_member_id
      AND v_history.to_date IS NOT DISTINCT FROM p_new_date
      AND v_history.reviewed IS NOT DISTINCT FROM p_expected
    THEN
      RETURN v_history.result;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'idempotency_conflict';
  END IF;

  UPDATE public.moves AS move
  SET move_date = p_new_date
  WHERE move.id = p_move_id
    AND move.family_id = p_family_id
    AND move.move_date IS DISTINCT FROM p_new_date;

  UPDATE public.move_tasks AS task
  SET due_date = p_new_date + task.offset_days
  WHERE task.id = ANY(v_shift_ids)
    AND task.move_id = p_move_id
    AND task.family_id = p_family_id;

  -- Existing updated_at triggers run naturally. No other move/task fields,
  -- boxes, or related application rows are written by this function.
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.move_recalculate_date(uuid, uuid, uuid, date, jsonb, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.move_recalculate_date(uuid, uuid, uuid, date, jsonb, uuid)
  TO authenticated;
