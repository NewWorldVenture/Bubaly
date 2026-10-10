import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'vitest';

const requireInstalled = createRequire(import.meta.url);
const { utils: playwrightNaming } = requireInstalled('playwright-core/lib/coreBundle') as {
  utils: { sanitizeForFilePath(value: string): string; trimLongString(value: string, length: number): string };
};
const globMatches = requireInstalled('minimatch') as (file: string, pattern: string, options: { dot: boolean }) => boolean;

const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
const cleanupScript = readFileSync(resolve('scripts/ci-recurring-bill-anchor-fixture.mjs'), 'utf8').replace(/\r\n/g, '\n');
const uploadStepName = 'Upload E2E failure evidence';

// Inspect only the named job/step without introducing a YAML dependency.
function e2eJob(source = workflow): string {
  const lines = source.split('\n');
  const start = lines.indexOf('  e2e:');
  assert.notEqual(start, -1, 'The isolated E2E job must remain present');
  const end = lines.findIndex((line, index) => index > start && /^  [\w-]+:\s*$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

function e2eStep(name: string, source = workflow): string {
  const job = e2eJob(source);
  const start = job.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `Missing E2E step: ${name}`);
  const end = job.indexOf('\n      - ', start + 1);
  return job.slice(start, end === -1 ? undefined : end);
}

test('CI uploads E2E evidence only on failure, with no other artifact upload steps', () => {
  const step = e2eStep(uploadStepName);
  assert.match(step, /^        if: failure\(\)$/m);
  assert.match(step, /^        uses: actions\/upload-artifact@v4$/m);
  const uploads = workflow.match(/^\s+(?:- )?uses:\s*actions\/upload-artifact(?:\/[^\s@]+)?@\S+/gm) ?? [];
  assert.equal(uploads.length, 1, 'Any additional artifact upload needs an explicit privacy review');
});

function assertPrivatePaths(source = workflow) {
  const step = e2eStep(uploadStepName, source);
  const pathBlock = step.match(/^          path: \|\n((?: {12}[^\n]+\n?)+)/m);
  assert.ok(pathBlock, 'Artifact paths must remain an explicit multiline allowlist');
  const paths = pathBlock[1].trim().split('\n').map((path) => path.trim());

  assert.deepEqual(paths.filter((path) => !path.startsWith('!')), [
    'test-results/**/error-context.md',
    'test-results/**/*.png',
  ], 'Do not upload whole directories, traces, state, logs, or reports');
  assert.deepEqual(paths.filter((path) => path.startsWith('!')), [
    '!test-results/**/trace.zip',
    '!test-results/*durable-session*/**',
    '!test-results/*family-messaging-auth*/**',
    '!test-results/*a-feedback-image-is-not*/**',
    '!test-results/*recurring-bill-auth*/**',
    '!test-results/*dashboard-calendar-auth*/**',
    '!test-results/*a-stored-link-is-inert*/**',
    '!test-results/**/storageState*',
    '!test-results/**/storage-state*',
    '!test-results/**/auth.json',
    '!test-results/**/auth/**',
    '!test-results/**/.auth/**',
    '!test-results/**/.env*',
    '!test-results/**/*.log',
    '!test-results/**/logs/**',
    '!test-results/**/*.html',
    '!test-results/**/playwright-report/**',
  ]);
  assert.match(step, /^          include-hidden-files: false$/m);
}

test('CI failure evidence has only the DOM/screenshot allowlist and explicit privacy exclusions', () => {
  assertPrivatePaths();
});

test('CI evidence expires after three days, uses a unique attempt name, and ignores missing files', () => {
  const step = e2eStep(uploadStepName);
  assert.match(step, /^          retention-days: 3$/m);
  assert.match(step, /^          if-no-files-found: ignore$/m);
  assert.match(step, /^          name: e2e-failure-evidence-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}$/m);
});

function assertAlwaysCleanup(source = workflow) {
  const cleanup = e2eStep('Stop isolated Supabase', source);
  assert.match(cleanup, /^        if: always\(\)$/m);
  assert.match(cleanup, /^        run: node scripts\/ci-recurring-bill-anchor-fixture\.mjs$/m);
  assert.match(cleanup, /^          BUBALY_BILL_STACK_PHASE: cleanup$/m);
  const job = e2eJob(source);
  assert.ok(job.indexOf(`      - name: ${uploadStepName}\n`) > job.indexOf('      - name: Run E2E smoke tests\n'));
  assert.ok(job.indexOf('      - name: Stop isolated Supabase\n') > job.indexOf(`      - name: ${uploadStepName}\n`));
}

test('isolated Supabase cleanup still always runs after the failure-evidence step', async () => {
  assertAlwaysCleanup();
  await proveCleanupOwnership(cleanupScript);
});

// Run the real private cleanup branch with synthetic process/command/file seams.
// This never imports its CLI entry point or invokes Docker/Supabase. Checking the
// branch as well as the workflow prevents replacing an owned stop with an
// unconditional stop while leaving the script path in the YAML unchanged.
async function cleanupProbe(source: string, scenario: string) {
  const validator = source.match(/export function validateInvocation\([\s\S]*?\n}\n/);
  const start = source.indexOf('async function main() {');
  const end = source.indexOf('\nif (process.argv[1]', start);
  assert.ok(validator && start >= 0 && end > start, 'Expected owned cleanup entry point');
  const id = 'a'.repeat(64), other = 'b'.repeat(64), nonce = '11111111-1111-4111-8111-111111111111';
  const env: Record<string, string> = { CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_JOB: 'e2e',
    GITHUB_REPOSITORY: 'NewWorldVenture/Bubaly', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
    BUBALY_BILL_STACK_PHASE: 'cleanup', RUNNER_TEMP: '/owned', GITHUB_ENV: '/owned/env' };
  if (scenario === 'remote override') env.DOCKER_HOST = 'tcp://synthetic.invalid:1234';
  const receipt = { run: scenario === 'foreign run' ? '456-1' : '123-1', nonce, startedAt: 1000,
    ids: scenario === 'uncaptured actors' ? null : [scenario === 'changed immutable IDs' ? other : id] };
  let ids = [id], stops = 0, commands = 0;
  const execute = (program: string, args: string[]) => {
    commands++;
    if (program === 'supabase') {
      assert.deepEqual(args, ['stop', '--no-backup']); stops++; ids = []; return '';
    }
    assert.equal(program, 'docker');
    if (args[0] === 'context') return args[1] === 'show' ? 'default' : 'unix:///var/run/docker.sock';
    if (args.includes('ps')) return ids.join('\n');
    if (args.includes('inspect')) return JSON.stringify({ id, project: 'bubaly',
      created: scenario === 'predating actor' ? '1970-01-01T00:00:00Z' : '2026-10-08T00:00:00Z' });
    throw new Error('Unexpected cleanup command');
  };
  const run = new Function('process', 'assert', 'join', 'execute', 'readFileSync', 'existsSync', 'socket', 'console',
    `${validator[0].replace('export ', '')}\n${source.slice(start, end)}\nreturn main();`);
  let refused = false;
  try {
    await run({ env, platform: 'linux', argv: ['node', 'owned-script'] }, assert, (...parts: string[]) => parts.join('/'), execute,
      (path: string) => path.endsWith('.toml') ? 'project_id = "bubaly"' : JSON.stringify(receipt),
      () => scenario !== 'missing receipt', 'unix:///var/run/docker.sock', { log: () => {} });
  } catch { refused = true; }
  return { refused, stops, commands };
}

async function proveCleanupOwnership(source: string) {
  const owned = await cleanupProbe(source, 'owned');
  assert.equal(owned.refused, false); assert.equal(owned.stops, 1);
  const missing = await cleanupProbe(source, 'missing receipt');
  assert.equal(missing.refused, false); assert.equal(missing.stops, 0);
  for (const scenario of ['foreign run', 'changed immutable IDs', 'uncaptured actors', 'predating actor', 'remote override']) {
    const result = await cleanupProbe(source, scenario);
    assert.equal(result.refused, true, `Cleanup must refuse ${scenario}`);
    assert.equal(result.stops, 0, `Cleanup must not stop ${scenario}`);
    if (scenario === 'remote override') assert.equal(result.commands, 0, 'Invocation validation precedes every command');
  }
}

test.each([
  '!test-results/**/trace.zip', '!test-results/*durable-session*/**',
  '!test-results/*family-messaging-auth*/**', '!test-results/*a-feedback-image-is-not*/**',
  '!test-results/*recurring-bill-auth*/**',
  '!test-results/*dashboard-calendar-auth*/**', '!test-results/*a-stored-link-is-inert*/**',
  '!test-results/**/storageState*',
  '!test-results/**/storage-state*', '!test-results/**/auth.json', '!test-results/**/auth/**',
  '!test-results/**/.auth/**', '!test-results/**/.env*', '!test-results/**/*.log',
  '!test-results/**/logs/**', '!test-results/**/*.html', '!test-results/**/playwright-report/**',
])('artifact contract rejects removal of %s', exclusion => {
  assert.ok(workflow.includes(`            ${exclusion}\n`));
  assert.throws(() => assertPrivatePaths(workflow.replace(`            ${exclusion}\n`, '')));
});

test('artifact contract refuses a whole-directory upload or hidden files', () => {
  assert.throws(() => assertPrivatePaths(workflow.replace('test-results/**/error-context.md', 'test-results/**')));
  assert.throws(() => assertPrivatePaths(workflow.replace('include-hidden-files: false', 'include-hidden-files: true')));
});

const privateSpecs = ['family-messaging-authenticated', 'recurring-bill-authenticated',
  'dashboard-calendar-authenticated', 'durable-session', 'a-feedback-image-is-not-a-beacon',
  'a-stored-link-is-inert-in-the-page'] as const;

// A suite's exclusion is a prefix of its file name short enough to survive the
// worker's truncation: `-authenticated` shortened to `-auth`, or named here.
const shortPrefix: Partial<Record<typeof privateSpecs[number], string>> = {
  'a-feedback-image-is-not-a-beacon': 'a-feedback-image-is-not',
  'a-stored-link-is-inert-in-the-page': 'a-stored-link-is-inert',
};
const exclusionFor = (spec: typeof privateSpecs[number]) =>
  `!test-results/*${shortPrefix[spec] ?? spec.replace('-authenticated', '-auth')}*/**`;

function artifactPatterns(source: string): string[] {
  const block = e2eStep(uploadStepName, source).match(/^          path: \|\n((?: {12}[^\n]+\n?)+)/m);
  assert.ok(block);
  return block[1].trim().split('\n').map(line => line.trim());
}

function uploaded(file: string, patterns: string[]): boolean {
  return patterns.some(pattern => !pattern.startsWith('!') && globMatches(file, pattern, { dot: true }))
    && !patterns.some(pattern => pattern.startsWith('!') && globMatches(file, pattern.slice(1), { dot: true }));
}

function actualPrivateDirectories(spec: typeof privateSpecs[number]): string[] {
  const source = readFileSync(resolve(`tests/e2e/${spec}.spec.ts`), 'utf8');
  const suite = source.match(/test\.describe\('([^']+)'/);
  assert.ok(suite, `Actual private suite title exists: ${spec}`);
  const titles = [...source.matchAll(/\btest\((['"`])([^\r\n]*?)\1\s*,/g)].flatMap(match =>
    match[2].includes('${zone}') ? ['America/New_York', 'Asia/Tokyo'].map(zone => match[2].replace('${zone}', zone)) : [match[2]]);
  assert.ok(titles.length > 0, `Actual private cases exist: ${spec}`);
  // This is the installed worker's naming bound, including its hash truncation.
  const worker = readFileSync(resolve('node_modules/playwright/lib/worker/workerProcessEntry.js'), 'utf8');
  const bound = worker.match(/windowsFilesystemFriendlyLength = (\d+);/);
  assert.ok(bound);
  assert.match(worker, /trimLongString\(sanitizedRelativePath \+ "-" \+ sanitizeForFilePath2\(fullTitleWithoutSpec\), windowsFilesystemFriendlyLength\)/);
  return titles.flatMap(title => {
    const full = `${spec}-${playwrightNaming.sanitizeForFilePath(`${suite[1]} ${title}`)}`;
    const shortened = playwrightNaming.trimLongString(full, Number(bound[1]));
    assert.ok(shortened.startsWith(spec.slice(0, 26)), 'Actual naming retains its stable filename prefix');
    return [full, shortened].flatMap(base => ['chromium', 'iphone'].flatMap(project =>
      ['', '-retry1', '-retry2-repeat1'].map(suffix => `${base}-${project}${suffix}`)));
  });
}

function assertPrivateOutputs(source: string, spec: typeof privateSpecs[number]) {
  const patterns = artifactPatterns(source);
  for (const directory of actualPrivateDirectories(spec)) {
    for (const name of ['error-context.md', 'failure.png', 'nested/failure.png']) {
      const file = `test-results/${directory}/${name}`;
      assert.equal(uploaded(file, patterns.filter(pattern => !pattern.startsWith('!'))), true,
        'The real positive allowlist would admit this synthetic private output without exclusions');
      assert.equal(uploaded(file, patterns), false, `Private output must be excluded: ${file}`);
    }
  }
}

test.each(privateSpecs)('real globs exclude full, installed-truncated and retried %s outputs', spec => {
  assertPrivateOutputs(workflow, spec);
});

test('real artifact globs retain benign DOM and screenshot evidence only', () => {
  const patterns = artifactPatterns(workflow);
  for (const name of ['error-context.md', 'failure.png', 'nested/failure.png']) {
    assert.equal(uploaded(`test-results/public-fixture-chromium/${name}`, patterns), true);
  }
  for (const name of ['trace.zip', 'session.json', 'storageState.json', 'auth.json', '.env', 'worker.log', 'report.html']) {
    assert.equal(uploaded(`test-results/public-fixture-chromium/${name}`, patterns), false);
  }
});

test.each(privateSpecs.filter(spec => spec !== 'durable-session'))(
  'actual-path oracle rejects reverting %s to its unsafe full-filename glob', spec => {
    const safe = exclusionFor(spec);
    assert.ok(workflow.includes(safe));
    assert.throws(() => assertPrivateOutputs(workflow.replace(safe, `!test-results/*${spec}*/**`), spec));
  });

test.each(privateSpecs.filter(spec => spec !== 'durable-session'))(
  'actual-path oracle rejects removing the %s exclusion', spec => {
    const safe = exclusionFor(spec);
    assert.ok(workflow.includes(safe));
    assert.throws(() => assertPrivateOutputs(workflow.replace(`            ${safe}\n`, ''), spec));
  });

test.each([
  ['if: always()', 'if: success()'], ['BUBALY_BILL_STACK_PHASE: cleanup', 'BUBALY_BILL_STACK_PHASE: install'],
  ['run: node scripts/ci-recurring-bill-anchor-fixture.mjs', 'run: supabase stop --no-backup'],
])('cleanup contract refuses changed %s', (before, after) => {
  const step = e2eStep('Stop isolated Supabase');
  assert.throws(() => assertAlwaysCleanup(workflow.replace(step, step.replace(before, after))));
});

test.each([
  'validateInvocation(process.env, process.platform, process.argv.slice(2));',
  "assert.deepEqual(ids, receipt.ids, 'Owned stack immutable IDs changed');",
  "assert.ok(receipt.ids !== null || ids.length === 0, 'No cleanup of uncaptured stack actors');",
  "assert.ok(Date.parse(row.created) >= receipt.startedAt, 'Refuse a container predating owned startup');",
])('executed cleanup ownership controls reject disabling %s', async guard => {
  assert.ok(cleanupScript.includes(guard));
  await assert.rejects(() => proveCleanupOwnership(cleanupScript.replace(guard, 'void 0;')));
});
