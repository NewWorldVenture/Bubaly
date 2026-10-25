import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';

type Step = {
  name?: string; uses?: string; run?: string; if?: string;
  env?: Record<string, string>; with?: Record<string, unknown>;
  'continue-on-error'?: boolean;
};
type Job = {
  name?: string; 'runs-on'?: string; needs?: string[]; if?: string;
  'continue-on-error'?: boolean; steps: Step[];
  strategy?: { 'fail-fast'?: boolean; 'max-parallel'?: number; matrix?: Record<string, unknown> };
};
type Workflow = { jobs: Record<string, Job> };
const { load } = createRequire(import.meta.url)('js-yaml') as { load(source: string): Workflow };
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const graph = () => load(workflow);
const smokeName = 'Run E2E smoke tests';
const authName = 'Verify real Auth messaging RPC membership-removal boundaries';
const installName = 'Install held bill anchor fixture in the owned PG15 stack';
const modernName = 'Verify authenticated durable bill anchors after fresh server start';
const cleanupName = 'Stop isolated Supabase';
const aggregateName = 'Require every E2E shard and its owned cleanup to succeed';

function step(job: Job, name: string) {
  const matches = job.steps.filter((entry) => entry.name === name);
  expect(matches, `Required step: ${name}`).toHaveLength(1);
  return matches[0];
}

function requireShardGraph(candidate: Workflow) {
  const job = candidate.jobs.e2e;
  expect(job, 'The owned stack requires GITHUB_JOB=e2e').toBeDefined();
  expect(job['runs-on']).toBe('ubuntu-latest');
  expect(job.needs).toBeUndefined();
  expect(job.if).toBeUndefined();
  expect(job['continue-on-error']).toBeUndefined();
  expect(job.name).toBe('E2E shard (${{ matrix.shard }}/${{ matrix.shardTotal }})');
  expect(job.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2, 3, 4, 5, 6, 7, 8], shardTotal: [8] } });
  for (const entry of job.steps) expect(entry['continue-on-error']).toBeUndefined();

  const smoke = step(job, smokeName);
  expect(smoke.if).toBeUndefined();
  expect(smoke.run).toBe('npm run test:e2e -- --shard=${{ matrix.shard }}/${{ matrix.shardTotal }}');
  expect(smoke.env?.E2E_AUTH_EMAIL).toBe('bubaly-e2e-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.shard }}@example.test');
  expect(smoke.env?.E2E_AUTHENTICATED).toBe('1');
  expect(smoke.env?.E2E_DURABLE_SESSION).toBe('1');
  expect(smoke.env?.E2E_BILL_ANCHOR_PHASE).toBe('old');
  expect(smoke.env?.ANTHROPIC_API_KEY).toBe('');
  expect(smoke.env?.OPENAI_API_KEY).toBe('');
  expect(smoke.env?.AI_PROVIDER_STUB).toBe('1');
  expect(smoke.env?.E2E_PROVIDER_STUB).toBe('1');

  expect(step(job, 'Attest empty local stack before owned startup').env?.BUBALY_BILL_STACK_PHASE).toBe('prepare');
  expect(step(job, 'Start isolated Supabase').run).toBe('supabase start');
  expect(step(job, 'Capture immutable owned bill stack identities').env?.BUBALY_BILL_STACK_PHASE).toBe('capture');
  const sql = step(job, 'Verify home brief kind uniqueness in disposable PostgreSQL');
  expect(sql.run).toBe('node scripts/ci-home-brief-kind-runtime.mjs');
  expect(sql.env?.BUBALY_0261_RUNTIME).toBe('1');
  expect(sql.if).toBeUndefined();
  expect(step(job, 'Verify isolated Auth APIs').run).toBe('npm run db:audit:auth');
  expect(step(job, 'Verify isolated schema capabilities').run).toBe('npm run db:audit:schema');

  const names = job.steps.map((entry) => entry.name ?? entry.uses ?? '');
  expect(at(names, 'Attest empty local stack before owned startup')).toBeLessThan(at(names, 'Start isolated Supabase'));
  expect(at(names, 'Start isolated Supabase')).toBeLessThan(at(names, 'Capture immutable owned bill stack identities'));
  expect(at(names, 'Capture immutable owned bill stack identities')).toBeLessThan(at(names, 'Verify home brief kind uniqueness in disposable PostgreSQL'));
  expect(at(names, 'Verify home brief kind uniqueness in disposable PostgreSQL')).toBeLessThan(at(names, smokeName));
  expect(at(names, smokeName)).toBeLessThan(at(names, authName));
  expect(at(names, authName)).toBeLessThan(at(names, installName));
  expect(at(names, installName)).toBeLessThan(at(names, modernName));
  expect(at(names, modernName)).toBeLessThan(at(names, cleanupName));
  const auth = step(job, authName);
  expect(auth.run).toBe('node node_modules/vitest/vitest.mjs run tests/messages-authenticated-rpc-race.test.ts');
  expect(auth.env?.BUBALY_MESSAGES_AUTHENTICATED_RPC_GATE).toBe('1');
  expect(auth.env?.E2E_MESSAGES_PARALLEL_FINISHED).toBe('1');
  const install = step(job, installName);
  expect(install.run).toBe('node scripts/ci-recurring-bill-anchor-fixture.mjs');
  expect(install.env?.BUBALY_BILL_STACK_PHASE).toBe('install');
  expect(install.env?.E2E_BILL_PARALLEL_FINISHED).toBe('1');
  const modern = step(job, modernName);
  expect(modern.run).toBe('npm run test:e2e -- tests/e2e/recurring-bill-authenticated.spec.ts --project=chromium --workers=1');
  expect(modern.env?.PLAYWRIGHT_SKIP_BUILD).toBe('1');
  expect(modern.env?.E2E_BILL_ANCHOR_PHASE).toBe('modern');
  expect(modern.env?.E2E_AUTHENTICATED).toBe('1');
  expect(modern.env?.E2E_DURABLE_SESSION).toBe('1');
  for (const name of [authName, installName, modernName]) expect(step(job, name).if).toBeUndefined();
  const cleanup = step(job, cleanupName);
  expect(job.steps.at(-1)).toBe(cleanup);
  expect(cleanup.if).toBe('always()');
  expect(cleanup.run).toBe('node scripts/ci-recurring-bill-anchor-fixture.mjs');
  expect(cleanup.env?.BUBALY_BILL_STACK_PHASE).toBe('cleanup');
  const upload = step(job, 'Upload E2E failure evidence');
  expect(upload.if).toBe('failure()');
  expect(upload.with?.name).toBe('e2e-failure-evidence-${{ github.run_id }}-${{ github.run_attempt }}-shard-${{ matrix.shard }}');
  expect(upload.with?.['include-hidden-files']).toBe(false);
  expect(upload.with?.['retention-days']).toBe(3);
  expect(upload.with?.path).toContain('!test-results/**/trace.zip');
  expect(upload.with?.path).toContain('!test-results/**/storageState*');
  expect(upload.with?.path).toContain('!test-results/**/*.log');
  expect(upload.with?.path).not.toContain('blob-report');

  const aggregate = candidate.jobs['e2e-results'];
  expect(aggregate).toBeDefined();
  expect(aggregate.name).toBe('E2E (public · a11y · authenticated · mobile device matrix)');
  expect(aggregate['runs-on']).toBe('ubuntu-latest');
  expect(aggregate.needs).toEqual(['e2e']);
  expect(aggregate.if).toBe('${{ always() }}');
  expect(aggregate['continue-on-error']).toBeUndefined();
  const validator = step(aggregate, aggregateName);
  expect(validator.if).toBeUndefined();
  expect(validator['continue-on-error']).toBeUndefined();
  expect(validator.env?.CI_DEPENDENCIES).toBe('${{ toJSON(needs) }}');
}

function aggregateResults(results: unknown, candidate = graph()) {
  const source = step(candidate.jobs['e2e-results'], aggregateName).run!;
  const prefix = "node <<'NODE'\n", suffix = 'NODE\n';
  expect(source.startsWith(prefix)).toBe(true);
  expect(source.endsWith(suffix)).toBe(true);
  new Function('process', source.slice(prefix.length, -suffix.length))({ env: { CI_DEPENDENCIES: JSON.stringify(results) } });
}

describe('eight complete E2E shards preserve each owned qualification and cleanup', () => {
  it('the actual YAML preserves all eight shards, required checks and per-runner ownership phases', () => {
    requireShardGraph(graph());
  });
  it('the actual aggregate accepts only a successful E2E matrix including cleanup', () => {
    expect(() => aggregateResults({ e2e: { result: 'success' } })).not.toThrow();
  });
  it.each(['failure', 'skipped', 'cancelled', 'neutral', 'timed_out', ''])
  ('the actual aggregate refuses the matrix result %s', (result) => {
    expect(() => aggregateResults({ e2e: { result } })).toThrow('did not succeed');
  });
  it.each([
    ['missing dependency', {}], ['absent result', { e2e: {} }],
    ['unexpected dependency', { e2e: { result: 'success' }, extra: { result: 'success' } }],
    ['null result', { e2e: null }], ['wrong dependency shape', ['success']],
  ])('the actual aggregate refuses %s', (_name, results) => {
    expect(() => aggregateResults(results)).toThrow();
  });
  it.each([
    ['missing shard', (copy: Workflow) => { copy.jobs.e2e.strategy!.matrix!.shard = [1, 2, 3, 4, 5, 6, 7]; }],
    ['duplicate shard', (copy: Workflow) => { copy.jobs.e2e.strategy!.matrix!.shard = [1, 2, 3, 4, 5, 6, 7, 7]; }],
    ['invalid shard', (copy: Workflow) => { copy.jobs.e2e.strategy!.matrix!.shard = [0, 1, 2, 3, 4, 5, 6, 7]; }],
    ['wrong total', (copy: Workflow) => { copy.jobs.e2e.strategy!.matrix!.shardTotal = [4]; }],
    ['excluded shard', (copy: Workflow) => { copy.jobs.e2e.strategy!.matrix!.exclude = [{ shard: 8 }]; }],
    ['extra shard', (copy: Workflow) => { copy.jobs.e2e.strategy!.matrix!.include = [{ shard: 9 }]; }],
    ['fail-fast', (copy: Workflow) => { copy.jobs.e2e.strategy!['fail-fast'] = true; }],
    ['serialized shards', (copy: Workflow) => { copy.jobs.e2e.strategy!['max-parallel'] = 1; }],
    ['filtered projects', (copy: Workflow) => { step(copy.jobs.e2e, smokeName).run += ' --project=chromium'; }],
    ['filtered cases', (copy: Workflow) => { step(copy.jobs.e2e, smokeName).run += ' --grep=only-one'; }],
    ['optional E2E job', (copy: Workflow) => { copy.jobs.e2e['continue-on-error'] = true; }],
    ['optional smoke', (copy: Workflow) => { step(copy.jobs.e2e, smokeName)['continue-on-error'] = true; }],
    ['skipped smoke', (copy: Workflow) => { step(copy.jobs.e2e, smokeName).if = '${{ false }}'; }],
    ['lost Auth gate', (copy: Workflow) => { copy.jobs.e2e.steps = copy.jobs.e2e.steps.filter((entry) => entry.name !== authName); }],
    ['lost SQL gate', (copy: Workflow) => { copy.jobs.e2e.steps = copy.jobs.e2e.steps.filter((entry) => entry.name !== 'Verify home brief kind uniqueness in disposable PostgreSQL'); }],
    ['lost modern bill', (copy: Workflow) => { copy.jobs.e2e.steps = copy.jobs.e2e.steps.filter((entry) => entry.name !== modernName); }],
    ['modern bill accidentally sharded', (copy: Workflow) => { step(copy.jobs.e2e, modernName).run += ' --shard=1/8'; }],
    ['cleanup only on success', (copy: Workflow) => { step(copy.jobs.e2e, cleanupName).if = 'success()'; }],
    ['cleanup failure ignored', (copy: Workflow) => { step(copy.jobs.e2e, cleanupName)['continue-on-error'] = true; }],
    ['stack job identity changed', (copy: Workflow) => { copy.jobs.other = copy.jobs.e2e; delete copy.jobs.e2e; }],
    ['Auth ran before smoke', (copy: Workflow) => { const entries = copy.jobs.e2e.steps; const auth = step(copy.jobs.e2e, authName); entries.splice(entries.indexOf(auth), 1); entries.unshift(auth); }],
    ['lost always aggregation', (copy: Workflow) => { copy.jobs['e2e-results'].if = '${{ success() }}'; }],
    ['wrong aggregate dependency', (copy: Workflow) => { copy.jobs['e2e-results'].needs = ['unit']; }],
    ['optional aggregate', (copy: Workflow) => { copy.jobs['e2e-results']['continue-on-error'] = true; }],
    ['changed required status', (copy: Workflow) => { copy.jobs['e2e-results'].name = 'Optional sharded E2E'; }],
    ['artifact name collision', (copy: Workflow) => { step(copy.jobs.e2e, 'Upload E2E failure evidence').with!.name = 'e2e-failure-evidence'; }],
    ['credential-bearing blob upload', (copy: Workflow) => { step(copy.jobs.e2e, 'Upload E2E failure evidence').with!.path += '\nblob-report/**'; }],
    ['enabled external model key', (copy: Workflow) => { step(copy.jobs.e2e, smokeName).env!.OPENAI_API_KEY = 'configured'; }],
  ] as const)('the actual YAML graph rejects %s', (_name, mutate) => {
    const copy = structuredClone(graph());
    mutate(copy);
    expect(() => requireShardGraph(copy)).toThrow();
  });
  it('the actual npm wrapper forwards only the supplied shard argument to Playwright', () => {
    const wrapper = readFileSync('scripts/run-e2e.mjs', 'utf8');
    const forwarding = "testStatus = run('node_modules/@playwright/test/cli.js', ['test', ...process.argv.slice(2)]);";
    expect(wrapper.split(forwarding)).toHaveLength(2);
    const calls: { module: string; args: string[] }[] = [];
    const invoke = new Function('process', 'run', `let testStatus; ${forwarding} return testStatus;`);
    expect(invoke({ argv: ['node', 'scripts/run-e2e.mjs', '--shard=3/8'] }, (module: string, args: string[]) => {
      calls.push({ module, args }); return 0;
    })).toBe(0);
    expect(calls).toEqual([{ module: 'node_modules/@playwright/test/cli.js', args: ['test', '--shard=3/8'] }]);
    for (const file of ['scripts/ci-recurring-bill-anchor-fixture.mjs', 'scripts/ci-home-brief-kind-runtime.mjs', 'tests/messages-authenticated-rpc-race.test.ts']) {
      expect(readFileSync(file, 'utf8')).toContain("GITHUB_JOB");
      expect(readFileSync(file, 'utf8')).toContain("'e2e'");
    }
    const config = readFileSync('playwright.config.ts', 'utf8');
    expect(config).toContain("testMatch: '**/*.spec.ts'");
    expect(config).toContain('fullyParallel: true');
    expect(config).toContain('workers: 2');
    expect(config).not.toContain('shard:');
  });
});
