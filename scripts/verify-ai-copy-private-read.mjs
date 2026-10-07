import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = 'supabase/reserved/0493_ai_copy_private_read_and_quota.sql';
const FIXTURE = 'tests/fixtures/ai-copy-private-read.sql';

/** Use actual main schema/policies, rather than a hand-written permissive baseline. */
export function aiCopyBaseline(root = ROOT) {
  const block = (path, start) => {
    const source = readFileSync(join(root, path), 'utf8').replaceAll('\r\n', '\n');
    const offset = source.indexOf(start);
    if (offset < 0) throw new Error('Missing main source block ' + start);
    let quote = null;
    let dollar = null;
    for (let i = offset; i < source.length; i += 1) {
      if (dollar) {
        if (source.startsWith(dollar, i)) { i += dollar.length - 1; dollar = null; }
      } else if (quote) {
        if (source[i] === quote) {
          if (source[i + 1] === quote) i += 1;
          else quote = null;
        }
      } else if (source.slice(i, i + 2) === '--') {
        const newline = source.indexOf('\n', i);
        if (newline < 0) break;
        i = newline;
      } else if (source[i] === '$' && /^\$(?:[a-zA-Z_]\w*)?\$/.test(source.slice(i))) {
        dollar = source.slice(i).match(/^\$(?:[a-zA-Z_]\w*)?\$/)[0];
        i += dollar.length - 1;
      } else if (source[i] === "'" || source[i] === '"') {
        quote = source[i];
      } else if (source[i] === ';') {
        return source.slice(offset, i + 1);
      }
    }
    throw new Error('Unterminated main source block ' + start);
  };
  return [
    block("supabase/migrations/0093_trust_engine.sql", "CREATE TABLE IF NOT EXISTS public.approval_requests ("),
    block("supabase/migrations/0022_family_os.sql", "CREATE TABLE IF NOT EXISTS family_automation_runs ("),
    block("supabase/migrations/0250_ai_runtime_core.sql", "create table if not exists public.ai_requests ("),
    block("supabase/migrations/0250_ai_runtime_core.sql", "create table if not exists public.ai_request_context ("),
    block("supabase/migrations/0250_ai_runtime_core.sql", "create table if not exists public.ai_plans ("),
    block("supabase/migrations/0250_ai_runtime_core.sql", "create table if not exists public.ai_plan_steps ("),
    block("supabase/migrations/0250_ai_runtime_core.sql", "do $$\nbegin\n  alter table public.family_automation_runs\n    add column if not exists request_id"),
    block("supabase/migrations/0250_ai_runtime_core.sql", "create table if not exists public.ai_run_events ("),
    block("supabase/migrations/0250_ai_runtime_core.sql", "create table if not exists public.ai_tool_calls ("),
    block("supabase/migrations/0251_ai_trust_hardening.sql", "alter table public.approval_requests\n"),
    block("supabase/migrations/0250_ai_runtime_core.sql", "create policy ai_requests_select "),
    block("supabase/migrations/0250_ai_runtime_core.sql", "create policy ai_request_context_select "),
    block("supabase/migrations/0250_ai_runtime_core.sql", "create policy ai_tool_calls_select "),
    block("supabase/migrations/0264_ai_surface_role_privacy.sql", "create policy ai_plans_select "),
    block("supabase/migrations/0264_ai_surface_role_privacy.sql", "create policy ai_plan_steps_select "),
    block("supabase/migrations/0264_ai_surface_role_privacy.sql", "create policy ai_run_events_select "),
    block("supabase/migrations/0251_ai_trust_hardening.sql", "create policy family_automation_runs_select "),
    block("supabase/migrations/0251_ai_trust_hardening.sql", "create policy approval_requests_select "),
    block("supabase/migrations/0251_ai_trust_hardening.sql", "create policy approval_requests_decide "),
    block("supabase/migrations/0251_ai_trust_hardening.sql", "create policy approval_requests_cancel_own "),
    block("supabase/migrations/0251_ai_trust_hardening.sql", "create policy family_automation_runs_update "),
    block("supabase/migrations/0251_ai_trust_hardening.sql", "create policy family_automation_runs_delete "),
    block("supabase/migrations/0255_ai_runtime_lockdown.sql", "create policy ai_requests_insert "),
    block("supabase/migrations/0255_ai_runtime_lockdown.sql", "create policy approval_requests_insert "),
  ].join('\n');
}

export function verifyAiCopyPrivateRead({ postgresBin, port, expectedServerPort = port, expectedDataDir, root = ROOT }) {
  if (!postgresBin || !isAbsolute(postgresBin) || !expectedDataDir || !isAbsolute(expectedDataDir)
    || !/^\d{1,5}$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535
    || !/^\d{1,5}$/.test(String(expectedServerPort)) || Number(expectedServerPort) < 1 || Number(expectedServerPort) > 65535) {
    throw new Error('Explicit PostgreSQL bin directory, loopback port and expected data directory are required.');
  }
  const connection = ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres'];
  const exec = (name, args) => spawnSync(join(postgresBin, process.platform === 'win32' ? `${name}.exe` : name), args, {
    encoding: 'utf8', timeout: 15_000, cwd: root,
  });
  const requireSuccess = (result, label) => {
    if (result.error || result.status !== 0) throw new Error(`${label}: ${result.error?.message ?? result.stderr}`);
  };
  const identity = exec('psql', [...connection, '-X', '-d', 'postgres', '-At', '-c',
    'show data_directory; show port; show server_version;']);
  requireSuccess(identity, 'Could not identify synthetic PostgreSQL cluster');
  const [actualDir, actualPort, serverVersion] = identity.stdout.trim().split(/\r?\n/);
  const normalize = (path) => resolve(path).replaceAll('\\', '/');
  // Docker's loopback published port can differ from PostgreSQL's internal port.
  // Verify both explicitly; never infer the server port from an observed value.
  if (!actualDir || !serverVersion || normalize(actualDir) !== normalize(expectedDataDir) || actualPort !== String(expectedServerPort)) {
    throw new Error('PostgreSQL data directory or port did not match; no database was created.');
  }
  const database = `synthetic_ai_copy_${randomUUID().replaceAll('-', '')}`;
  const directory = mkdtempSync(join(tmpdir(), 'ai-copy-private-read-'));
  let created = false;
  try {
    const baseline = aiCopyBaseline(root);
    const baselineFile = join(directory, 'baseline.sql');
    writeFileSync(baselineFile, baseline);
    requireSuccess(exec('createdb', [...connection, database]), 'Could not create synthetic AI copy database');
    created = true;
    const fixture = (skipGuard, oldInactive = false) => exec('psql', [...connection, '-X', '-d', database, '-v', 'ON_ERROR_STOP=1',
      '-v', `baseline_sql=${baselineFile.replaceAll('\\', '/')}`, '-v', `skip_guard=${skipGuard}`,
      '-v', `old_inactive=${oldInactive}`, '-f', join(root, FIXTURE)]);
    const corrected = fixture(false);
    requireSuccess(corrected, 'AI copy requester/reviewer role contract failed');
    if (!corrected.stdout.includes('AI copy private read and household quota assertions PASS')
      || !corrected.stdout.trim().endsWith('ROLLBACK')) throw new Error('AI copy fixture did not confirm a complete rollback.');
    const assertionCount = Number(corrected.stdout.match(/AI copy assertion count: (\d+)/)?.[1]);
    if (!Number.isSafeInteger(assertionCount) || assertionCount < 1) throw new Error('AI copy fixture did not report its assertions.');
    const oldPolicy = fixture(true);
    if (oldPolicy.error || oldPolicy.status === 0
      || !oldPolicy.stderr.includes('FAIL: unrelated child cannot read private request')) {
      throw new Error('Historical-policy control did not fail at the reproduced draft disclosure.');
    }
    const oldOwner = fixture(true, true);
    if (oldOwner.error || oldOwner.status === 0
      || !oldOwner.stderr.includes('FAIL: inactive owner cannot read private tool receipt')) {
      throw new Error('Historical owner control did not fail at the reproduced inactive receipt disclosure.');
    }
    const hash = (content) => createHash('sha256').update(content).digest('hex');
    return {
      runtime: process.version, serverVersion, host: '127.0.0.1', port: String(port), serverPort: actualPort,
      corrected: 'PASS, migration replayed twice, ROLLBACK',
      assertionCount,
      oldPolicy: 'expected private-request and inactive-owner assertion failures',
      sourceHashes: {
        [MIGRATION]: hash(readFileSync(join(root, MIGRATION))),
        [FIXTURE]: hash(readFileSync(join(root, FIXTURE))),
        baseline: hash(baseline),
      },
    };
  } finally {
    try {
      if (created) requireSuccess(exec('dropdb', [...connection, database]), 'Could not remove owned synthetic AI copy database');
    } finally {
      // Verify computed recursive cleanup remains under this task's temp root.
      if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith('ai-copy-private-read-')) {
        throw new Error('Refusing unexpected synthetic fixture temp cleanup path.');
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = { '--postgres-bin': 'postgresBin', '--port': 'port', '--expected-server-port': 'expectedServerPort', '--expected-data-dir': 'expectedDataDir' }[process.argv[i]];
    if (!key || !process.argv[i + 1]) throw new Error('Expected --postgres-bin, --port, optional --expected-server-port and --expected-data-dir arguments.');
    options[key] = process.argv[i + 1];
  }
  console.log(JSON.stringify(verifyAiCopyPrivateRead(options), null, 2));
}
