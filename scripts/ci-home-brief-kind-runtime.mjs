import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOCKER_SOCKET = 'unix:///var/run/docker.sock';
export const EXPECTED_CASES = Object.freeze([
  'daily_evening_coexist',
  'same_kind_duplicate_rejected',
  'renamed_reordered_legacy_removed',
  'rerun_idempotent',
  'missing_replacement_atomic',
  'partial_replacement_atomic',
  'wrong_replacement_atomic',
  'unknown_standalone_unique_atomic',
]);

const DATABASE_PATTERN = /^bubaly_0261_[a-f0-9]{32}$/;
const CONTAINER_PATTERN = /^[a-f0-9]{64}$/;
const INSPECT_FORMAT = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"running":{{json .State.Running}}}';

export function assertInvocation(platform, env, argv) {
  if (platform !== 'linux' || env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true'
    || env.GITHUB_JOB !== 'e2e' || env.BUBALY_0261_RUNTIME !== '1'
    || env.GITHUB_REPOSITORY?.toLowerCase() !== 'newworldventure/bubaly') {
    throw new Error('0261 runtime proof requires the opted-in GitHub CI Linux E2E job');
  }
  if (argv.length !== 0) throw new Error('0261 runtime proof accepts no host, database, URL, or other arguments');
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DATABASE_URL', 'SUPABASE_DB_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGPASSWORD', 'PGOPTIONS']) {
    if (Object.hasOwn(env, key)) throw new Error(`0261 runtime proof rejects connection override ${key}`);
  }
}

export function makeIdentity(nonce = randomUUID().replaceAll('-', '')) {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Error('Invalid disposable database nonce');
  return { database: `bubaly_0261_${nonce}`, marker: `bubaly-0261-runtime:${nonce}` };
}

function assertIdentity(identity) {
  if (!DATABASE_PATTERN.test(identity.database)
    || identity.marker !== `bubaly-0261-runtime:${identity.database.slice('bubaly_0261_'.length)}`) {
    throw new Error('Refusing an unowned database identity');
  }
}

function literal(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function dockerInvocation(args, input, configDirectory, executablePath) {
  return {
    command: 'docker',
    args: ['--config', configDirectory, '--host', DOCKER_SOCKET, ...args],
    options: {
      input, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
      // Do not inherit Docker contexts, database credentials, or psql settings.
      env: { PATH: executablePath, LANG: 'C.UTF-8' },
    },
  };
}

export function selectContainer(docker) {
  const candidates = docker([
    'container', 'ls', '--no-trunc', '--filter', 'status=running',
    '--filter', 'name=^/supabase_db_', '--filter', 'label=com.supabase.cli.project',
    '--format', '{{.ID}}',
  ]).trim().split(/\r?\n/).filter(Boolean);
  if (candidates.length !== 1 || !CONTAINER_PATTERN.test(candidates[0])) {
    throw new Error('Expected exactly one running local Supabase database container');
  }
  // Inspect only these fields, never the container environment or credentials.
  const container = JSON.parse(docker(['container', 'inspect', '--format', INSPECT_FORMAT, candidates[0]]));
  if (container.id !== candidates[0] || container.running !== true
    || typeof container.project !== 'string' || !/^[A-Za-z0-9_-]+$/.test(container.project)
    || container.name !== `/supabase_db_${container.project}`
    || !/^(?:(?:public\.ecr\.aws|ghcr\.io|docker\.io)\/)?supabase\/postgres:[A-Za-z0-9._-]+$/.test(container.image)) {
    throw new Error('Local container does not match the Supabase CLI database identity');
  }
  // Pin every subsequent command to the immutable ID, not a reusable name.
  return container.id;
}

export function psqlArguments(containerId, database) {
  if (!CONTAINER_PATTERN.test(containerId)
    || (database !== 'template1' && !DATABASE_PATTERN.test(database))) {
    throw new Error('Refusing an application database or unvalidated container');
  }
  return [
    'exec', '--interactive', '--user', 'postgres', containerId,
    'psql', '-X', '--no-password', '--quiet', '--tuples-only', '--no-align',
    '--host', '/var/run/postgresql', '--port', '5432', '--username', 'postgres',
    '--dbname', database, '--set', 'ON_ERROR_STOP=1',
  ];
}

export function renderProof(identity, migration, fixture) {
  assertIdentity(identity);
  const body = `BEGIN EXECUTE ${literal(migration)}; END;`;
  return `SET standard_conforming_strings = on;
BEGIN;
SET LOCAL statement_timeout = '20s';
SET LOCAL lock_timeout = '5s';
DO $ownership$
BEGIN
  IF current_database() <> ${literal(identity.database)} OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_database
    WHERE datname = current_database()
      AND datdba = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
      AND pg_catalog.shobj_description(oid, 'pg_database') = ${literal(identity.marker)}
  ) THEN
    RAISE EXCEPTION '0261 fixture ownership guard failed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  ) THEN
    RAISE EXCEPTION '0261 fixture requires an empty disposable database';
  END IF;
END;
$ownership$;
CREATE TEMP TABLE proof_results (case_name text PRIMARY KEY) ON COMMIT DROP;
CREATE FUNCTION pg_temp.apply_0261() RETURNS void LANGUAGE plpgsql AS ${literal(body)};
${fixture}
ROLLBACK;
`;
}

export function renderCleanup(identity) {
  assertIdentity(identity);
  // DROP DATABASE cannot run in a transaction. psql conditionals gate it on the
  // fresh name, owner and marker in template1; a mismatch is a hard failure.
  return `SET standard_conforming_strings = on;
SELECT (count(*) = 1) AS owned FROM pg_catalog.pg_database
WHERE datname = ${literal(identity.database)}
  AND datdba = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
  AND pg_catalog.shobj_description(oid, 'pg_database') = ${literal(identity.marker)}
\\gset
\\if :owned
DROP DATABASE "${identity.database}" WITH (FORCE);
\\else
\\echo 0261 cleanup refused: disposable database ownership mismatch
\\quit 3
\\endif
`;
}

export function parseProof(output) {
  const cases = output.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const match = /^0261_OK ([a-z_]+)$/.exec(line);
    if (!match) throw new Error('Unexpected PostgreSQL acceptance output');
    return match[1];
  });
  if (JSON.stringify([...cases].sort()) !== JSON.stringify([...EXPECTED_CASES].sort())) {
    throw new Error('PostgreSQL did not prove every required 0261 acceptance case exactly once');
  }
  return cases;
}

export function executeAcceptance(docker, identity, migration, fixture) {
  assertIdentity(identity);
  const container = selectContainer(docker);
  const psql = (database, sql) => docker(psqlArguments(container, database), sql);
  let created = false;
  let failure;
  let cases;
  try {
    // No IF NOT EXISTS: an existing database must never be adopted or modified.
    // template1 is used only for database administration, never application SQL.
    psql('template1', `CREATE DATABASE "${identity.database}" WITH TEMPLATE template0 OWNER postgres;\n`);
    created = true;
    psql('template1', `COMMENT ON DATABASE "${identity.database}" IS ${literal(identity.marker)};\n`);
    cases = parseProof(psql(identity.database, renderProof(identity, migration, fixture)));
  } catch (error) {
    failure = error;
  } finally {
    if (created) {
      try {
        psql('template1', renderCleanup(identity));
      } catch (error) {
        failure = failure
          ? new AggregateError([failure, error], '0261 proof and disposable database cleanup failed')
          : error;
      }
    }
  }
  if (failure) throw failure;
  return cases;
}

function main() {
  assertInvocation(process.platform, process.env, process.argv.slice(2));
  if (!statSync('/var/run/docker.sock').isSocket()) throw new Error('Expected the local Linux Docker socket');
  const migration = readFileSync(new URL('../supabase/migrations/0261_home_briefs_kind_uniqueness.sql', import.meta.url), 'utf8');
  const fixture = readFileSync(new URL('../tests/fixtures/0261-home-brief-kind-runtime.sql', import.meta.url), 'utf8');
  // An empty, invocation-owned Docker config avoids loading saved credentials.
  const configDirectory = mkdtempSync(join(tmpdir(), 'bubaly-0261-docker-'));
  try {
    const docker = (args, input = '') => {
      const invocation = dockerInvocation(args, input, configDirectory, process.env.PATH ?? '/usr/bin:/bin');
      const result = spawnSync(invocation.command, invocation.args, invocation.options);
      if (result.error || result.status !== 0) {
        throw new Error(`0261 local Docker/psql command failed: ${result.error?.message ?? String(result.stderr).slice(-6000)}`);
      }
      return String(result.stdout);
    };
    const cases = executeAcceptance(docker, makeIdentity(), migration, fixture);
    // Publish success only after every SQL assertion AND owned-database cleanup.
    for (const name of cases) console.log(`0261 runtime PASS ${name}`);
    console.log(`0261 runtime acceptance: ${cases.length}/${EXPECTED_CASES.length}; disposable database removed`);
  } finally {
    rmSync(configDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
