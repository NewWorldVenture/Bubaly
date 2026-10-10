import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = 'supabase/reserved/0492_approval_requests_private_read.sql';
const FIXTURE = 'tests/fixtures/approval-requests-private-read.sql';

/** Use actual main schema/policies, rather than a hand-written permissive baseline. */
export function approvalBaseline(root = ROOT) {
  const block = (path, start) => {
    const source = readFileSync(join(root, path), 'utf8').replaceAll('\r\n', '\n');
    const offset = source.indexOf(start);
    if (offset < 0) throw new Error(`Missing main source block ${start}`);
    // Main's column comments contain semicolons. Stop at a SQL terminator,
    // excluding comments and quoted values/identifiers.
    let quote = null;
    for (let i = offset; i < source.length; i += 1) {
      if (quote) {
        if (source[i] === quote) {
          if (source[i + 1] === quote) i += 1;
          else quote = null;
        }
      } else if (source.slice(i, i + 2) === '--') {
        const newline = source.indexOf('\n', i);
        if (newline < 0) break;
        i = newline;
      } else if (source[i] === "'" || source[i] === '"') {
        quote = source[i];
      } else if (source[i] === ';') {
        return source.slice(offset, i + 1);
      }
    }
    throw new Error(`Unterminated main source block ${start}`);
  };
  return [
    block('supabase/migrations/0093_trust_engine.sql', 'CREATE TABLE IF NOT EXISTS public.approval_requests ('),
    block('supabase/migrations/0251_ai_trust_hardening.sql', 'alter table public.approval_requests\n'),
    block('supabase/migrations/0251_ai_trust_hardening.sql', 'create policy approval_requests_select '),
    block('supabase/migrations/0251_ai_trust_hardening.sql', 'create policy approval_requests_decide '),
    block('supabase/migrations/0251_ai_trust_hardening.sql', 'create policy approval_requests_cancel_own '),
    block('supabase/migrations/0255_ai_runtime_lockdown.sql', 'create policy approval_requests_insert '),
  ].join('\n');
}

export function verifyApprovalPrivateRead({ postgresBin, port, expectedServerPort = port, expectedDataDir, root = ROOT }) {
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
  const database = `synthetic_approval_${randomUUID().replaceAll('-', '')}`;
  const directory = mkdtempSync(join(tmpdir(), 'approval-private-read-'));
  let created = false;
  try {
    const baseline = approvalBaseline(root);
    const baselineFile = join(directory, 'baseline.sql');
    writeFileSync(baselineFile, baseline);
    requireSuccess(exec('createdb', [...connection, database]), 'Could not create synthetic approval database');
    created = true;
    const fixture = (skipGuard) => exec('psql', [...connection, '-X', '-d', database, '-v', 'ON_ERROR_STOP=1',
      '-v', `baseline_sql=${baselineFile.replaceAll('\\', '/')}`, '-v', `skip_guard=${skipGuard}`, '-f', join(root, FIXTURE)]);
    const corrected = fixture(false);
    requireSuccess(corrected, 'Approval requester/reviewer role contract failed');
    if (!corrected.stdout.includes('approval private read: actual-role ownership, review, revocation and inherited restriction assertions PASS')
      || !corrected.stdout.trim().endsWith('ROLLBACK')) throw new Error('Approval fixture did not confirm a complete rollback.');
    const oldPolicy = fixture(true);
    if (oldPolicy.error || oldPolicy.status === 0
      || !oldPolicy.stderr.includes('FAIL: unrelated child cannot read private draft')) {
      throw new Error('Historical-policy control did not fail at the reproduced draft disclosure.');
    }
    const hash = (content) => createHash('sha256').update(content).digest('hex');
    return {
      runtime: process.version, serverVersion, host: '127.0.0.1', port: String(port), serverPort: actualPort,
      corrected: 'PASS, migration replayed twice, ROLLBACK',
      oldPolicy: 'expected private-draft assertion failure',
      sourceHashes: {
        [MIGRATION]: hash(readFileSync(join(root, MIGRATION))),
        [FIXTURE]: hash(readFileSync(join(root, FIXTURE))),
        baseline: hash(baseline),
      },
    };
  } finally {
    try {
      if (created) requireSuccess(exec('dropdb', [...connection, database]), 'Could not remove owned synthetic approval database');
    } finally {
      // Verify computed recursive cleanup remains under this task's temp root.
      if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith('approval-private-read-')) {
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
  console.log(JSON.stringify(verifyApprovalPrivateRead(options), null, 2));
}
