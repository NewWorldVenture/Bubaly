import { at } from './helpers/source-order';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import {
  assertInvocation, DOCKER_SOCKET, dockerInvocation, executeAcceptance,
  EXPECTED_CASES, makeIdentity, parseProof, psqlArguments, renderCleanup,
  renderProof, selectContainer,
} from '../scripts/ci-home-brief-kind-runtime.mjs';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const fixture = readFileSync(new URL('./fixtures/0261-home-brief-kind-runtime.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/0261_home_briefs_kind_uniqueness.sql', import.meta.url), 'utf8');
const ownedCleanup = readFileSync(new URL('../scripts/ci-recurring-bill-anchor-fixture.mjs', import.meta.url), 'utf8');
const identity = makeIdentity('a'.repeat(32));
const containerId = 'b'.repeat(64);
const ciEnvironment = {
  CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_JOB: 'e2e',
  GITHUB_REPOSITORY: 'NewWorldVenture/Bubaly', BUBALY_0261_RUNTIME: '1',
};
const container = {
  id: containerId, name: '/supabase_db_fixture', project: 'fixture',
  image: 'public.ecr.aws/supabase/postgres:17.6.1.063', running: true,
};
const completeOutput = EXPECTED_CASES.map((name) => `0261_OK ${name}`).join('\n') + '\n';

type Call = { args: string[]; input: string };
function transportDouble(failAt = '', output = completeOutput) {
  const calls: Call[] = [];
  const docker = (args: string[], input = '') => {
    calls.push({ args, input });
    if (args[0] === 'container' && args[1] === 'ls') return containerId + '\n';
    if (args[0] === 'container' && args[1] === 'inspect') return JSON.stringify(container);
    if (input.startsWith('CREATE DATABASE') && failAt === 'create') throw new Error('create rejected');
    if (input.startsWith('COMMENT ON DATABASE') && failAt === 'mark') throw new Error('marker rejected');
    if (input.includes('CREATE TEMP TABLE proof_results')) {
      if (failAt === 'fixture' || failAt === 'both') throw new Error('synthetic SQL assertion failed');
      return output;
    }
    if (input.includes('DROP DATABASE') && (failAt === 'cleanup' || failAt === 'both')) {
      throw new Error('cleanup ownership mismatch');
    }
    return '';
  };
  return { docker, calls };
}

describe('0261 runtime runner guards (no local PostgreSQL claims)', () => {
  test('requires Linux, the opted-in repository E2E job, and no caller options', () => {
    expect(() => assertInvocation('linux', ciEnvironment, [])).not.toThrow();
    for (const platform of ['win32', 'darwin']) expect(() => assertInvocation(platform, ciEnvironment, [])).toThrow();
    for (const key of Object.keys(ciEnvironment)) {
      expect(() => assertInvocation('linux', { ...ciEnvironment, [key]: 'wrong' }, [])).toThrow();
    }
    expect(() => assertInvocation('linux', ciEnvironment, ['--database', 'postgres'])).toThrow();
    expect(() => assertInvocation('linux', ciEnvironment, ['--host', 'remote.invalid'])).toThrow();
  });

  test('rejects inherited connection overrides without inspecting their values', () => {
    for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DATABASE_URL', 'SUPABASE_DB_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGPASSWORD', 'PGOPTIONS']) {
      expect(() => assertInvocation('linux', { ...ciEnvironment, [key]: 'synthetic' }, [])).toThrow(key);
    }
  });

  test('pins Docker to the local socket and does not inherit a credential-bearing environment', () => {
    const invocation = dockerInvocation(['container', 'ls'], '', '/tmp/owned-empty-config', '/usr/bin:/bin');
    expect(invocation.command).toBe('docker');
    expect(invocation.args).toEqual(['--config', '/tmp/owned-empty-config', '--host', DOCKER_SOCKET, 'container', 'ls']);
    expect(invocation.options.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' });
    expect(invocation.options.timeout).toBe(60_000);
  });

  test('requires one matching CLI database container and pins its immutable ID', () => {
    const good = transportDouble();
    expect(selectContainer(good.docker)).toBe(containerId);
    expect(good.calls[1].args.join(' ')).not.toContain('.Config.Env');
    for (const listing of ['', `${containerId}\n${'c'.repeat(64)}\n`, 'short-id']) {
      expect(() => selectContainer(() => listing)).toThrow();
    }
    for (const changed of [
      { ...container, name: '/production-db' }, { ...container, project: 'other-project' },
      { ...container, image: 'untrusted/postgres:17' }, { ...container, running: false },
      { ...container, id: 'c'.repeat(64) },
    ]) {
      expect(() => selectContainer((args: string[]) => args[1] === 'ls' ? containerId : JSON.stringify(changed))).toThrow();
    }
  });

  test('accepts only newly generated database identities and container-local psql', () => {
    expect(makeIdentity().database).toMatch(/^bubaly_0261_[a-f0-9]{32}$/);
    expect(() => makeIdentity('postgres')).toThrow();
    const args = psqlArguments(containerId, identity.database);
    expect(args).toContain('-X');
    expect(args).toContain('--no-password');
    expect(args[args.indexOf('--host') + 1]).toBe('/var/run/postgresql');
    expect(args[args.indexOf('--dbname') + 1]).toBe(identity.database);
    expect(() => psqlArguments(containerId, 'postgres')).toThrow();
    expect(() => renderCleanup({ ...identity, marker: 'another-owner' })).toThrow();
  });

  test('ownership and empty-database checks precede fixture DDL; cleanup is ownership gated', () => {
    const sql = renderProof(identity, migration, fixture);
    expect(at(sql, 'fixture ownership guard failed')).toBeLessThan(at(sql, 'CREATE TEMP TABLE'));
    expect(at(sql, 'requires an empty disposable database')).toBeLessThan(at(sql, 'CREATE TEMP TABLE'));
    expect(sql).toContain('pg_catalog.shobj_description');
    expect(sql).toContain("SET LOCAL lock_timeout = '5s'");
    expect(sql).toMatch(/ROLLBACK;\n$/);
    const cleanup = renderCleanup(identity);
    expect(cleanup).toContain('\\gset\n\\if :owned\nDROP DATABASE');
    expect(cleanup).toContain('\\quit 3');
    expect(cleanup).toContain(identity.marker);
    expect(at(cleanup, 'pg_catalog.shobj_description')).toBeLessThan(at(cleanup, 'DROP DATABASE'));
  });
});

describe('0261 runner orchestration with an explicit transport double', () => {
  test('creates from template0 and sends fixture SQL only to its marked disposable database', () => {
    const fake = transportDouble();
    expect(executeAcceptance(fake.docker, identity, migration, fixture)).toEqual(EXPECTED_CASES);
    const commands = fake.calls.filter((call) => call.args[0] === 'exec');
    expect(commands[0].input).toContain('WITH TEMPLATE template0 OWNER postgres');
    expect(commands[0].input).not.toContain('IF NOT EXISTS');
    expect(commands[1].input).toContain(identity.marker);
    const proof = commands.find((call) => call.input.includes('CREATE TEMP TABLE proof_results'))!;
    expect(proof.args[proof.args.indexOf('--dbname') + 1]).toBe(identity.database);
    for (const command of commands.filter((call) => call !== proof)) {
      expect(command.args[command.args.indexOf('--dbname') + 1]).toBe('template1');
      expect(command.input).not.toContain('public.home_briefs');
    }
    expect(commands.at(-1)!.input).toContain('DROP DATABASE');
  });

  test('does not adopt or drop a database when creation fails', () => {
    const fake = transportDouble('create');
    expect(() => executeAcceptance(fake.docker, identity, migration, fixture)).toThrow('create rejected');
    expect(fake.calls.some((call) => /COMMENT ON DATABASE|DROP DATABASE|CREATE TEMP TABLE/.test(call.input))).toBe(false);
  });

  test.each(['mark', 'fixture', 'cleanup', 'both'])('preserves failure and attempts guarded cleanup after %s failure', (failAt) => {
    const fake = transportDouble(failAt);
    expect(() => executeAcceptance(fake.docker, identity, migration, fixture)).toThrow();
    expect(fake.calls.at(-1)!.input).toBe(renderCleanup(identity));
    if (failAt === 'mark') expect(fake.calls.some((call) => call.input.includes('CREATE TEMP TABLE'))).toBe(false);
  });

  test('requires exactly all eight PostgreSQL markers and cleans up on incomplete evidence', () => {
    expect(parseProof(completeOutput)).toEqual(EXPECTED_CASES);
    for (const output of ['', completeOutput.replace('0261_OK daily_evening_coexist\n', ''), completeOutput + '0261_OK daily_evening_coexist\n', 'PASS\n']) {
      const fake = transportDouble('', output);
      expect(() => executeAcceptance(fake.docker, identity, migration, fixture)).toThrow();
      expect(fake.calls.at(-1)!.input).toBe(renderCleanup(identity));
    }
  });
});

test('SQL acceptance uses the real migration and explicit error/catalog assertions', () => {
  for (const name of EXPECTED_CASES) expect(fixture).toContain(`'${name}'`);
  expect(fixture).toContain('PERFORM pg_temp.apply_0261()');
  expect(fixture).toContain("duplicate_state = '23505'");
  expect(fixture).toContain("observed_state = 'P0001'");
  expect(fixture).toContain('observed_message = expected_message');
  expect(fixture).toContain('pg_temp.brief_snapshot() = before_state');
  expect(fixture).toContain('pg_temp.brief_snapshot() = before_rerun');
  expect(fixture).not.toContain('drop constraint %I');
  expect(renderProof(identity, migration, fixture)).toContain(migration.replaceAll("'", "''''"));
});

test('CI runs the real SQL gate after isolated startup, before app credentials, and retains always cleanup', () => {
  const job = workflow.slice(at(workflow, '  e2e:\n'));
  const gate = at(job, '      - name: Verify home brief kind uniqueness in disposable PostgreSQL\n');
  expect(gate).toBeGreaterThan(at(job, '      - name: Start isolated Supabase\n'));
  expect(gate).toBeLessThan(at(job, '      - name: Export local Supabase credentials\n'));
  const step = job.slice(gate, job.indexOf('\n      - name:', gate + 1));
  expect(step).toContain('run: node scripts/ci-home-brief-kind-runtime.mjs');
  expect(step).toContain("BUBALY_0261_RUNTIME: '1'");
  expect(step).not.toMatch(/continue-on-error:|if:/);
  const cleanup = job.slice(at(job, '      - name: Stop isolated Supabase\n'));
  expect(cleanup).toContain('if: always()');
  expect(cleanup).toContain('run: node scripts/ci-recurring-bill-anchor-fixture.mjs');
  expect(cleanup).toContain("BUBALY_BILL_STACK_PHASE: cleanup");
  expect(cleanup).not.toContain('run: supabase stop');
  expect(at(job, '      - name: Stop isolated Supabase\n')).toBeGreaterThan(gate);
  expect(at(job, '      - name: Attest empty local stack before owned startup\n'))
    .toBeLessThan(at(job, '      - name: Start isolated Supabase\n'));
  expect(at(job, '      - name: Capture immutable owned bill stack identities\n')).toBeLessThan(gate);
});

type CleanupOptions = { stale?: boolean; replaced?: boolean; uncaptured?: boolean; missing?: boolean; remains?: boolean; ci?: string };

// Execute the actual installer's cleanup branch with explicit filesystem and
// command doubles. No Docker, SQL, network or production acceptance is claimed.
function exerciseOwnedCleanup(options: CleanupOptions = {}) {
  const calls: { program: string; args: string[] }[] = [];
  let stopped = false;
  const liveId = (options.replaced ? 'c' : 'b').repeat(64);
  const env = {
    CI: options.ci ?? 'true', GITHUB_ACTIONS: 'true', GITHUB_JOB: 'e2e', GITHUB_REPOSITORY: 'NewWorldVenture/Bubaly',
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', BUBALY_BILL_STACK_PHASE: 'cleanup',
    RUNNER_TEMP: '/owned-temp', GITHUB_ENV: '/owned-env', PATH: '/usr/bin',
  };
  const receipt = { run: '123-1', nonce: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', startedAt: 1000,
    ids: options.uncaptured ? null : ['b'.repeat(64)] };
  const executable = ownedCleanup.slice(0, at(ownedCleanup, 'if (process.argv[1]'))
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\nmain';
  const main = runInNewContext(executable, {
    assert, createHash, randomUUID, join,
    process: { env, platform: 'linux', argv: ['node'] }, console: { log() {} },
    existsSync: () => !options.missing,
    readFileSync: (path: string) => path === 'supabase/config.toml' ? 'project_id = "bubaly"\n' : JSON.stringify(receipt),
    writeFileSync: () => { throw new Error('Cleanup must not write ownership receipts'); },
    appendFileSync: () => { throw new Error('Cleanup must not export fixture credentials'); },
    createConnection: () => { throw new Error('Cleanup must not connect to a TCP service'); },
    spawnSync: (program: string, args: string[]) => {
      calls.push({ program, args });
      let stdout: string;
      if (program === 'supabase') {
        assert.deepEqual(Array.from(args), ['stop', '--no-backup']); stopped = true; stdout = '';
      } else if (program === 'docker' && args[0] === 'context') {
        stdout = args[1] === 'show' ? 'default' : DOCKER_SOCKET;
      } else if (program === 'docker' && args.includes('ps')) {
        stdout = stopped && !options.remains ? '' : liveId;
      } else if (program === 'docker' && args.includes('inspect')) {
        stdout = JSON.stringify({ id: liveId, project: 'bubaly', created: new Date(options.stale ? 0 : 2000).toISOString() });
      } else throw new Error('Unexpected cleanup command');
      return { status: 0, stdout };
    },
  }) as () => Promise<void>;
  return { run: main, calls };
}

describe('0261 workflow delegates stack cleanup to actual ownership guards', () => {
  test('a captured unchanged stack reaches real supabase stop and verifies its removal', async () => {
    const subject = exerciseOwnedCleanup();
    await subject.run();
    const stop = subject.calls.findIndex(call => call.program === 'supabase');
    expect(stop).toBeGreaterThan(-1);
    expect(subject.calls.slice(0, stop).some(call => call.args.includes('inspect') && call.args.includes('b'.repeat(64)))).toBe(true);
    expect(subject.calls.slice(stop + 1).some(call => call.args.includes('ps'))).toBe(true);
    expect(subject.calls.filter(call => call.program === 'supabase')).toHaveLength(1);
  });

  test.each([
    { stale: true }, { replaced: true }, { uncaptured: true }, { ci: 'false' },
  ])('refuses unowned or invalid invocation before stopping anything: %j', async options => {
    const subject = exerciseOwnedCleanup(options);
    await expect(subject.run()).rejects.toThrow();
    expect(subject.calls.some(call => call.program === 'supabase')).toBe(false);
  });

  test('missing startup attestation performs no stack mutation', async () => {
    const subject = exerciseOwnedCleanup({ missing: true });
    await subject.run();
    expect(subject.calls.some(call => call.program === 'supabase')).toBe(false);
  });

  test('does not report success when actors remain after the stop command', async () => {
    const subject = exerciseOwnedCleanup({ remains: true });
    await expect(subject.run()).rejects.toThrow();
    expect(subject.calls.filter(call => call.program === 'supabase')).toHaveLength(1);
  });
});
