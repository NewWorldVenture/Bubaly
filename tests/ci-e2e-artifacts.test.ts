import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';

const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
const uploadStepName = 'Upload E2E failure evidence';

// Inspect only the named job/step without introducing a YAML dependency.
function e2eJob(): string {
  const lines = workflow.split('\n');
  const start = lines.indexOf('  e2e:');
  assert.notEqual(start, -1, 'The isolated E2E job must remain present');
  const end = lines.findIndex((line, index) => index > start && /^  [\w-]+:\s*$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

function e2eStep(name: string): string {
  const job = e2eJob();
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

test('CI failure evidence has only the DOM/screenshot allowlist and explicit privacy exclusions', () => {
  const step = e2eStep(uploadStepName);
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
});

test('CI evidence expires after three days, uses a unique attempt name, and ignores missing files', () => {
  const step = e2eStep(uploadStepName);
  assert.match(step, /^          retention-days: 3$/m);
  assert.match(step, /^          if-no-files-found: ignore$/m);
  assert.match(step, /^          name: e2e-failure-evidence-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}$/m);
});

test('isolated Supabase cleanup still always runs after the failure-evidence step', () => {
  const cleanup = e2eStep('Stop isolated Supabase');
  assert.match(cleanup, /^        if: always\(\)$/m);
  assert.match(cleanup, /^        run: supabase stop --no-backup$/m);
  const job = e2eJob();
  assert.ok(job.indexOf(`      - name: ${uploadStepName}\n`) > job.indexOf('      - name: Run E2E smoke tests\n'));
  assert.ok(job.indexOf('      - name: Stop isolated Supabase\n') > job.indexOf(`      - name: ${uploadStepName}\n`));
});
