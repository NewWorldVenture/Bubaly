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

const productionSource = readFileSync(resolve(process.cwd(), '.github/workflows/supabase-production-migrations.yml'), 'utf8');
const manualProductionApply = "success() && github.event_name == 'workflow_dispatch' && inputs.apply == true";
const metadataHistoryCommand = 'node scripts/audit-production-migration-state.mjs --enforce-history';
function requireReadOnlyProductionGraph(candidate: Workflow) {
  const job = candidate.jobs['migrate-and-verify'];
  expect(job['continue-on-error']).toBeUndefined();
  expect(job.env?.SUPABASE_TELEMETRY_DISABLED).toBe('1');
  expect(job.env?.DO_NOT_TRACK).toBe('1');
  const steps = job.steps!;
  const held = steps.find(step => step.name === 'Refuse generic production apply while migrations are held')!;
  expect(held.if).toBe("github.event_name == 'workflow_dispatch' && inputs.apply == true");
  expect(held.run).toContain('exit 1');
  const cli = steps.find(step => step.uses === 'supabase/setup-cli@v1')!;
  const link = steps.find(step => step.name === 'Link production project')!;
  expect(cli.if).toBe(manualProductionApply); expect(link.if).toBe(manualProductionApply);
  expect(link.run).toBe('supabase link --project-ref "$SUPABASE_PROJECT_REF"');
  expect(steps.indexOf(held)).toBeLessThan(steps.indexOf(cli));
  expect(steps.indexOf(held)).toBeLessThan(steps.indexOf(link));
  for (const step of steps.filter(step => step.uses === 'supabase/setup-cli@v1' || /(?:^|\n)\s*supabase\s/.test(step.run ?? ''))) {
    expect(step.if).toBe(manualProductionApply);
    expect(step.env?.SUPABASE_TELEMETRY_DISABLED).toBeUndefined();
    expect(step.env?.DO_NOT_TRACK).toBeUndefined();
    expect(step['continue-on-error']).toBeUndefined();
  }
  const verify = steps.find(step => step.name === 'Verify remote migration ledger')!;
  expect(verify.run).toBe(metadataHistoryCommand); expect(verify.if).toBeUndefined();
  expect(verify['continue-on-error']).toBeUndefined();
  expect(steps.some(step => /supabase migration list/.test(step.run ?? ''))).toBe(false);
  const artifact = steps.find(step => step.name === 'Retain metadata-only migration audit')!;
  expect(artifact.if).toBe('always()'); expect(artifact.uses).toBe('actions/upload-artifact@v4');
  expect((artifact as Step & { with: Record<string, unknown> }).with.path).toBe('.next/production-schema-audit.json');
  const credentials = steps.find(step => step.name === 'Validate production credentials')!;
  expect(credentials.if).toBeUndefined(); expect(credentials.run).toContain('set -euo pipefail');
  for (const key of ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY']) {
    expect(credentials.run).toContain(`test -n "$${key}"`);
    expect(job.env?.[key]).toBe(`\${{ secrets.${key} }}`);
  }
  const required = [
    'npm run db:audit:migrations', 'npm run db:audit:queries', metadataHistoryCommand, 'npm run db:audit:schema',
    'npm run marketing:verify:remote', 'npm run marketing:verify:public:remote', 'npm run marketing:verify:assets:remote',
    'npm run marketing:verify:coverage:remote', 'npm run marketing:verify:runtime:remote',
  ];
  for (const command of required) {
    const found = steps.filter(step => step.run === command);
    expect(found).toHaveLength(1); expect(found[0].if).toBeUndefined(); expect(found[0]['continue-on-error']).toBeUndefined();
  }
  for (const step of steps.filter(step => /(?:supabase db push|--apply)/.test(step.run ?? ''))) expect(step.if).toBe(manualProductionApply);
}

describe('automatic production verification cannot initialize a remote CLI login role', () => {
  it('uses the existing read-only metadata audit directly and enforces history', () => {
    const steps = load(productionSource).jobs['migrate-and-verify'].steps!;
    expect(steps.find(step => step.name === 'Verify remote migration ledger')?.run).toBe(metadataHistoryCommand);
  });
  it('gates CLI setup and linking behind successful explicit dispatch apply', () => {
    const steps = load(productionSource).jobs['migrate-and-verify'].steps!;
    expect(steps.find(step => step.uses === 'supabase/setup-cli@v1')?.if).toBe(manualProductionApply);
    expect(steps.find(step => step.name === 'Link production project')?.if).toBe(manualProductionApply);
  });
  it('keeps the complete parsed workflow read-only automatically without weakening other gates', () => {
    requireReadOnlyProductionGraph(load(productionSource));
  });
  it.each([
    ['automatic CLI setup', (copy: Workflow) => { delete copy.jobs['migrate-and-verify'].steps!.find(step => step.uses === 'supabase/setup-cli@v1')!.if; }],
    ['automatic linking', (copy: Workflow) => { delete copy.jobs['migrate-and-verify'].steps!.find(step => step.name === 'Link production project')!.if; }],
    ['CLI history verification', (copy: Workflow) => { copy.jobs['migrate-and-verify'].steps!.find(step => step.name === 'Verify remote migration ledger')!.run = 'supabase migration list --linked'; }],
    ['missing history enforcement', (copy: Workflow) => { copy.jobs['migrate-and-verify'].steps!.find(step => step.name === 'Verify remote migration ledger')!.run = 'node scripts/audit-production-migration-state.mjs'; }],
    ['ignored history failure', (copy: Workflow) => { copy.jobs['migrate-and-verify'].steps!.find(step => step.name === 'Verify remote migration ledger')!['continue-on-error'] = true; }],
    ['lost failure artifact', (copy: Workflow) => { copy.jobs['migrate-and-verify'].steps!.find(step => step.name === 'Retain metadata-only migration audit')!.if = 'success()'; }],
    ['omitted schema check', (copy: Workflow) => { copy.jobs['migrate-and-verify'].steps = copy.jobs['migrate-and-verify'].steps!.filter(step => step.run !== 'npm run db:audit:schema'); }],
    ['missing required credential', (copy: Workflow) => { copy.jobs['migrate-and-verify'].steps!.find(step => step.name === 'Validate production credentials')!.run = 'echo skipped'; }],
    ['CLI telemetry opt-in', (copy: Workflow) => { delete copy.jobs['migrate-and-verify'].env!.SUPABASE_TELEMETRY_DISABLED; }],
  ] as const)('the parsed production graph rejects %s', (_name, mutate) => {
    const copy = structuredClone(load(productionSource)); mutate(copy);
    expect(() => requireReadOnlyProductionGraph(copy)).toThrow();
  });
});
