import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

describe('production readiness CI gates', () => {
  it('runs the dependency audit in the quality job', () => {
    expect(workflow).toContain('npm audit --omit=dev --audit-level=moderate');
  });

  it('checks both Auth and schema capabilities against isolated Supabase', () => {
    expect(workflow).toContain('run: npm run db:audit:auth');
    expect(workflow).toContain('run: npm run db:audit:schema');
  });
});

// Parse the real YAML graph, so a commented-out job or unrelated npm test
// cannot satisfy the gate. js-yaml is already pinned by the installed lockfile.
type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; if?: string; 'continue-on-error'?: boolean };
type Job = {
  name?: string; 'runs-on'?: string; needs?: string | string[]; if?: string;
  'continue-on-error'?: boolean; env?: Record<string, string>; steps?: Step[];
  strategy?: { 'fail-fast'?: boolean; 'max-parallel'?: number; matrix?: { timezone?: string[]; include?: unknown; exclude?: unknown } };
};
type Workflow = { jobs: Record<string, Job> };
const { load } = createRequire(import.meta.url)('js-yaml') as { load(source: string): Workflow };
const jobs = load(workflow).jobs;
const expectedQualityNeeds = ['checks', 'unit', 'build'];

function requireQualityGraph(candidate: Workflow) {
  const quality = candidate.jobs.quality;
  expect(quality.name).toBe('Typecheck · Lint · Test · Build');
  expect(quality.if).toBe('${{ always() }}');
  expect(quality.needs).toEqual(expectedQualityNeeds);
  expect(quality['continue-on-error']).toBeUndefined();
  const aggregate = quality.steps?.find((step) => step.name === 'Require every quality dependency to succeed');
  expect(aggregate).toBeDefined();
  expect(aggregate?.env?.CI_DEPENDENCIES).toBe('${{ toJSON(needs) }}');
  expect(aggregate?.if).toBeUndefined();
  expect(aggregate?.['continue-on-error']).toBeUndefined();

  for (const name of expectedQualityNeeds) {
    const job = candidate.jobs[name];
    expect(job, `Missing quality dependency: ${name}`).toBeDefined();
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job.needs).toBeUndefined();
    expect(job.if).toBeUndefined();
    expect(job['continue-on-error']).toBeUndefined();
    expect(job.steps?.filter((step) => step.run === 'npm ci')).toHaveLength(1);
    for (const step of job.steps ?? []) {
      expect(step.if).toBeUndefined();
      expect(step['continue-on-error']).toBeUndefined();
    }
  }
  const unit = candidate.jobs.unit;
  expect(unit.strategy?.['fail-fast']).toBe(false);
  expect(unit.strategy?.matrix?.timezone).toEqual(['UTC', 'America/Los_Angeles', 'Asia/Tokyo']);
  expect(unit.strategy?.matrix?.include).toBeUndefined();
  expect(unit.strategy?.matrix?.exclude).toBeUndefined();
  expect(unit.strategy?.['max-parallel']).toBeUndefined();
  expect(unit.env?.TZ).toBe('${{ matrix.timezone }}');
  expect(unit.steps?.filter((step) => step.run !== undefined).map((step) => step.run)).toEqual(['npm ci', 'npm test']);
  expect(unit.steps?.find((step) => step.run === 'npm test')?.env?.TZ).toBeUndefined();

  expect(candidate.jobs.checks.steps?.filter((step) => step.run !== undefined).map((step) => step.run)).toEqual([
    'npm ci', 'npm audit --omit=dev --audit-level=moderate', 'npm run db:audit:migrations',
    'npm run db:audit:queries', 'npm run marketing:audit:assets', 'npm run lint', 'npm run i18n:gate',
  ]);
  // Build generates .next/types; the same checkout must typecheck it afterwards.
  expect(candidate.jobs.build.steps?.filter((step) => step.run !== undefined).map((step) => step.run)).toEqual([
    'npm ci', 'npm run build', 'npm run typecheck',
  ]);
  expect(candidate.jobs.build.steps?.find((step) => step.run === 'npm run build')?.env?.NODE_OPTIONS).toBe('--max-old-space-size=4096');
  expect(candidate.jobs.build.steps?.find((step) => step.run === 'npm run typecheck')?.env?.NODE_OPTIONS).toBe('--max-old-space-size=6144');
}

function aggregateResults(results: Record<string, { result?: unknown }>, candidate = jobs) {
  const step = candidate.quality.steps?.find((entry) => entry.name === 'Require every quality dependency to succeed');
  const run = step?.run;
  expect(run).toBeDefined();
  const prefix = "node <<'NODE'\n";
  expect(run?.startsWith(prefix)).toBe(true);
  expect(run?.endsWith('NODE\n')).toBe(true);
  // Execute exactly the workflow's pure result validator with synthetic needs.
  const script = run!.slice(prefix.length, -'NODE\n'.length);
  new Function('process', script)({ env: { CI_DEPENDENCIES: JSON.stringify(results) } });
}

describe('all complete timezone suites remain required while CI runs concurrently', () => {
  it('the real YAML graph retains every quality gate, all three zones and build-before-generated-types', () => {
    requireQualityGraph(load(workflow));
  });

  it('the actual aggregate accepts only three successful dependencies', () => {
    expect(() => aggregateResults({ checks: { result: 'success' }, unit: { result: 'success' }, build: { result: 'success' } })).not.toThrow();
  });

  it.each(expectedQualityNeeds)('the actual aggregate refuses a missing %s dependency', (missing) => {
    const results: Record<string, { result: string }> = { checks: { result: 'success' }, unit: { result: 'success' }, build: { result: 'success' } };
    delete results[missing];
    expect(() => aggregateResults(results)).toThrow('Missing or unexpected');
  });

  it.each(expectedQualityNeeds.flatMap((name) => ['failure', 'skipped', 'cancelled', '', 'neutral', 'timed_out'].map((result) => [name, result])))
  ('the actual aggregate refuses %s result %s', (name, result) => {
    const results = { checks: { result: 'success' }, unit: { result: 'success' }, build: { result: 'success' }, [name]: { result } };
    expect(() => aggregateResults(results)).toThrow('did not succeed');
  });

  it('the actual aggregate refuses an absent result and an unexpected dependency', () => {
    expect(() => aggregateResults({ checks: { result: 'success' }, unit: {}, build: { result: 'success' } })).toThrow('did not succeed');
    expect(() => aggregateResults({ checks: { result: 'success' }, unit: { result: 'success' }, build: { result: 'success' }, extra: { result: 'success' } })).toThrow('Missing or unexpected');
  });

  it.each([
    ['lost always aggregation', (copy: Workflow) => { copy.jobs.quality.if = '${{ success() }}'; }],
    ['omitted unit dependency', (copy: Workflow) => { copy.jobs.quality.needs = ['checks', 'build']; }],
    ['matrix fail-fast', (copy: Workflow) => { copy.jobs.unit.strategy!['fail-fast'] = true; }],
    ['missing eastern suite', (copy: Workflow) => { copy.jobs.unit.strategy!.matrix!.timezone = ['UTC', 'America/Los_Angeles']; }],
    ['excluded eastern suite', (copy: Workflow) => { copy.jobs.unit.strategy!.matrix!.exclude = [{ timezone: 'Asia/Tokyo' }]; }],
    ['filtered suite', (copy: Workflow) => { copy.jobs.unit.steps!.find((step) => step.run === 'npm test')!.run = 'npm test -- tests/only-one.test.ts'; }],
    ['overridden host zone', (copy: Workflow) => { copy.jobs.unit.steps!.find((step) => step.run === 'npm test')!.env = { TZ: 'UTC' }; }],
    ['unit continues on error', (copy: Workflow) => { copy.jobs.unit['continue-on-error'] = true; }],
    ['unit step is optional', (copy: Workflow) => { copy.jobs.unit.steps!.find((step) => step.run === 'npm test')!['continue-on-error'] = true; }],
    ['unit step is skipped', (copy: Workflow) => { copy.jobs.unit.steps!.find((step) => step.run === 'npm test')!.if = '${{ false }}'; }],
    ['omitted lint', (copy: Workflow) => { copy.jobs.checks.steps = copy.jobs.checks.steps!.filter((step) => step.run !== 'npm run lint'); }],
    ['typecheck before build', (copy: Workflow) => { const steps = copy.jobs.build.steps!; const build = steps.find((step) => step.run === 'npm run build')!; const typecheck = steps.find((step) => step.run === 'npm run typecheck')!; copy.jobs.build.steps = [...steps.filter((step) => step !== build && step !== typecheck), typecheck, build]; }],
  ] as const)('the YAML graph rejects %s', (_name, mutate) => {
    const copy = structuredClone(load(workflow));
    mutate(copy);
    expect(() => requireQualityGraph(copy)).toThrow();
  });
});
