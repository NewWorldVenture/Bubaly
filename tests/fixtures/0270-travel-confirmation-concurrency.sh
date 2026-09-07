#!/usr/bin/env bash
# This file is invoked only by the dedicated, unpublished-to-host PG17 service.
set -euo pipefail
[[ "${CI-}" == true && "${GITHUB_ACTIONS-}" == true ]]
[[ "${GITHUB_REPOSITORY-}" == NewWorldVenture/Bubaly ]]
[[ "${GITHUB_EVENT_NAME-}" == pull_request ]]
[[ "${TRAVEL_PR_HEAD_REPOSITORY-}" == "$GITHUB_REPOSITORY" ]]
[[ "${TRAVEL_PR_HEAD_SHA-}" =~ ^[0-9a-f]{40}$ ]]
[[ "${TRAVEL_IMPORT_CONTAINER-}" =~ ^[0-9a-f]{64}$ ]]
[[ "$(docker inspect --type container --format '{{.Id}}' "$TRAVEL_IMPORT_CONTAINER")" == "$TRAVEL_IMPORT_CONTAINER" ]]
[[ "$(docker inspect --type container --format '{{.Config.Image}}' "$TRAVEL_IMPORT_CONTAINER")" == postgres:17 ]]
[[ "$(docker inspect --type container --format '{{.State.Running}}' "$TRAVEL_IMPORT_CONTAINER")" == true ]]
[[ "$(docker inspect --type container --format '{{.HostConfig.LogConfig.Type}}' "$TRAVEL_IMPORT_CONTAINER")" == none ]]
[[ -z "$(docker port "$TRAVEL_IMPORT_CONTAINER")" ]]
[[ "${RUNNER_TEMP-}" == /* && -d "$RUNNER_TEMP" ]]

pg() {
  docker exec -i "$TRAVEL_IMPORT_CONTAINER" \
    psql -X --quiet --no-password --host=/var/run/postgresql \
    --username=postgres --dbname=bubaly_travel_import_ci \
    --set=ON_ERROR_STOP=1 --set=VERBOSITY=sqlstate "$@"
}
[[ "$(pg --tuples-only --no-align --command="
  SELECT current_database() = 'bubaly_travel_import_ci'
    AND current_user = 'postgres' AND inet_server_addr() IS NULL
    AND current_setting('server_version_num')::integer BETWEEN 170000 AND 179999
    AND to_regclass('travel_import_ci.cases') IS NOT NULL")" == t ]]

scratch="$(mktemp -d "$RUNNER_TEMP/travel-import-0270.XXXXXX")"
blocker_open=false
blocker_pid=''
race_a=''
race_b=''
cleanup() {
  if [[ "$blocker_open" == true ]]; then
    printf '%s\n' 'ROLLBACK;' '\q' >&3 || true
    exec 3>&-
  fi
  for child in "$blocker_pid" "$race_a" "$race_b"; do
    if [[ -n "$child" ]]; then wait "$child" 2>/dev/null || true; fi
  done
  rm -f -- "$scratch/failed-commit.state" "$scratch/blocker.sql" \
    "$scratch/blocker.state" "$scratch/race-a.state" "$scratch/race-b.state"
  rmdir -- "$scratch"
}
trap cleanup EXIT

# The deferred trigger fires at COMMIT, after an otherwise valid complete save.
# Capture SQLSTATE only in a private runner file; never print receipt/source data.
failed_status=0
pg --output=/dev/null >"$scratch/failed-commit.state" 2>&1 <<'SQL' || failed_status=$?
SET statement_timeout = '20s';
SET timezone = 'UTC';
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
INSERT INTO travel_import_ci.receipts VALUES ('failed-commit', travel_import_ci.invoke('rollback', true), txid_current());
SELECT travel_import_ci.assert_receipt('rollback', payload)
FROM travel_import_ci.receipts WHERE key = 'failed-commit';
COMMIT;
SQL
[[ "$failed_status" == 3 ]]
failure_state="$(< "$scratch/failed-commit.state")"
[[ "$failure_state" == *"ERROR:  P7701"* ]]
pg --output=/dev/null <<'SQL'
SELECT travel_import_ci.observe('rollback-after');
SELECT travel_import_ci.assert_same('rollback-before', 'rollback-after');
SELECT travel_import_ci.assert(a.attempts <> b.attempts, 'failed transaction reached application DML')
FROM travel_import_ci.observations a JOIN travel_import_ci.observations b ON b.label = 'rollback-after'
WHERE a.label = 'rollback-before';
SELECT travel_import_ci.assert(
  NOT EXISTS (SELECT 1 FROM travel_import_ci.receipts WHERE key = 'failed-commit'),
  'entire transaction, including fixture receipt, rolled back');
SELECT travel_import_ci.observe('concurrent-before');
SQL

# Hold the trip lock with a live, idle transaction. A FIFO releases it only after
# PostgreSQL reports both independent importer sessions waiting on locks.
mkfifo "$scratch/blocker.sql"
pg --output=/dev/null <"$scratch/blocker.sql" >"$scratch/blocker.state" 2>&1 &
blocker_pid=$!
exec 3>"$scratch/blocker.sql"
blocker_open=true
printf '%s\n' \
  "SET application_name = 'travel-import-ci-blocker';" \
  "SET idle_in_transaction_session_timeout = '45s';" \
  'BEGIN;' \
  "SELECT id FROM public.vacations WHERE id = '40000000-0000-4000-8000-000000000003' FOR UPDATE;" >&3

wait_for_count() {
  local sql="$1"
  local wanted="$2"
  local observed=''
  for ((attempt = 0; attempt < 60; attempt++)); do
    observed="$(pg --tuples-only --no-align --command="$sql")"
    if [[ "$observed" == "$wanted" ]]; then return 0; fi
    sleep 0.1
  done
  printf '%s\n' 'Required PostgreSQL concurrency barrier was not reached.' >&2
  return 1
}
wait_for_count "
  SELECT count(*) FROM pg_stat_activity
  WHERE datname = 'bubaly_travel_import_ci'
    AND application_name = 'travel-import-ci-blocker'
    AND state = 'idle in transaction'" 1

pg --output=/dev/null >"$scratch/race-a.state" 2>&1 <<'SQL' &
SET application_name = 'travel-import-ci-race-a';
SET statement_timeout = '30s';
SET lock_timeout = '25s';
SET timezone = 'UTC';
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
INSERT INTO travel_import_ci.receipts VALUES ('race-a', travel_import_ci.invoke('concurrent', true), txid_current());
COMMIT;
SQL
race_a=$!
pg --output=/dev/null >"$scratch/race-b.state" 2>&1 <<'SQL' &
SET application_name = 'travel-import-ci-race-b';
SET statement_timeout = '30s';
SET lock_timeout = '25s';
SET timezone = 'UTC';
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
INSERT INTO travel_import_ci.receipts VALUES ('race-b', travel_import_ci.invoke('concurrent', true), txid_current());
COMMIT;
SQL
race_b=$!
wait_for_count "
  SELECT count(*) FROM pg_stat_activity
  WHERE datname = 'bubaly_travel_import_ci'
    AND application_name IN ('travel-import-ci-race-a', 'travel-import-ci-race-b')
    AND state = 'active' AND wait_event_type = 'Lock'
    AND cardinality(pg_blocking_pids(pid)) > 0" 2

printf '%s\n' 'COMMIT;' '\q' >&3
exec 3>&-
blocker_open=false
wait "$blocker_pid"
blocker_pid=''
wait "$race_a"
race_a=''
wait "$race_b"
race_b=''

pg --output=/dev/null <<'SQL'
SELECT travel_import_ci.observe('concurrent-after');
SELECT travel_import_ci.assert_delta('concurrent-before', 'concurrent-after',
  '{"vacation_confirmation_imports":1,"vacation_reservations":1,"vacation_itinerary_days":1,"vacation_itinerary_items":1}');
SELECT travel_import_ci.assert(
  (SELECT count(*) FROM travel_import_ci.receipts WHERE key IN ('race-a', 'race-b')) = 2,
  'both simultaneous sessions committed');
SELECT travel_import_ci.assert(a.payload = b.payload AND a.transaction_id <> b.transaction_id,
  'overlapping requests returned identical receipts from separate transactions')
FROM travel_import_ci.receipts a JOIN travel_import_ci.receipts b ON b.key = 'race-b'
WHERE a.key = 'race-a';
SELECT travel_import_ci.assert(
  (SELECT count(*) FROM public.vacation_confirmation_imports
    WHERE id = '80000000-0000-4000-8000-000000000003') = 1,
  'exactly one concurrent request/source claim');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
SELECT travel_import_ci.assert_receipt('concurrent', payload) FROM travel_import_ci.receipts WHERE key = 'race-a';
RESET ROLE;
SELECT travel_import_ci.observe('concurrent-replay-before');
SQL

# A third connection proves replay after both racing transactions have committed.
pg --output=/dev/null <<'SQL'
SET timezone = 'UTC';
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
INSERT INTO travel_import_ci.receipts VALUES ('race-replay', travel_import_ci.invoke('concurrent', true), txid_current());
COMMIT;
SQL
pg --output=/dev/null <<'SQL'
SELECT travel_import_ci.observe('concurrent-replay-after');
SELECT travel_import_ci.assert_same('concurrent-replay-before', 'concurrent-replay-after', true);
SELECT travel_import_ci.assert(a.payload = b.payload AND a.transaction_id <> b.transaction_id,
  'new connection replays original committed concurrent receipt')
FROM travel_import_ci.receipts a JOIN travel_import_ci.receipts b ON b.key = 'race-replay'
WHERE a.key = 'race-a';
SQL
printf '%s\n' 'Travel confirmation runtime assertions passed.'
