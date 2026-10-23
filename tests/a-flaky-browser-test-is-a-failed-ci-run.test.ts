import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

// Exercise the installed runner and the actual canonical config. No browser,
// application server, provider credentials or network fixture is required.
const projectRoot = process.cwd();
const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
const cli = projectRequire.resolve('@playwright/test/cli');
const playwright = projectRequire.resolve('@playwright/test');
type Attempt = { retry: number; status: string };
type Suite = { suites?: Suite[]; specs?: { tests: { status: string; results: Attempt[] }[] }[] };
type Report = {
  config: { failOnFlakyTests: boolean; forbidOnly: boolean; webServer: unknown; projects: { name: string; retries: number }[] };
  stats: { expected: number; unexpected: number; skipped: number; flaky: number };
  errors: unknown[];
  suites: Suite[];
};
function runControl(kind: 'flaky' | 'healthy') {
  const tempRoot = realpathSync(tmpdir());
  const sandbox = mkdtempSync(path.join(tempRoot, 'bubaly-ci-flake-'));
  const childTemp = path.join(sandbox, 'temp');
  const home = path.join(sandbox, 'home');
  mkdirSync(childTemp); mkdirSync(home);
  const spec = path.join(sandbox, 'control.spec.ts');
  const config = path.join(sandbox, 'playwright.config.ts');
  writeFileSync(spec, `import { test, expect } from ${JSON.stringify(playwright)};\ntest('offline ${kind} control', async ({}, info) => { expect(info.retry).toBe(${kind === 'flaky' ? 1 : 0}); });\n`);
  writeFileSync(config, `import canonical from ${JSON.stringify(path.join(projectRoot, 'playwright.config.ts'))};\nexport default { ...canonical, testDir: ${JSON.stringify(sandbox)}, testMatch: '*.spec.ts', outputDir: ${JSON.stringify(path.join(sandbox, 'artifacts'))}, reporter: 'json' };\n`);
  // Deliberately do not spread process.env: even when run from a developer's
  // authenticated shell, this child receives only runtime paths and local homes.
  const env: NodeJS.ProcessEnv = {
    CI: '1', PLAYWRIGHT_EXTERNAL_SERVER: '1', TZ: 'UTC',
    TEMP: childTemp, TMP: childTemp, TMPDIR: childTemp,
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CACHE_HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home,
    PATH: path.dirname(process.execPath),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
  };
  const result = spawnSync(process.execPath, [cli, 'test', 'control.spec.ts', '--config=' + config, '--project=chromium', '--workers=1'], {
    cwd: projectRoot, env, encoding: 'utf8', windowsHide: true, timeout: 45_000, maxBuffer: 8 * 1024 * 1024,
  });
  writeFileSync(path.join(sandbox, 'stdout.json'), result.stdout ?? '');
  writeFileSync(path.join(sandbox, 'stderr.txt'), result.stderr ?? '');
  expect(result.error, `Runner setup failed; artifacts: ${sandbox}`).toBeUndefined();
  const report = JSON.parse(result.stdout) as Report;
  const tests: { status: string; results: Attempt[] }[] = [];
  function collect(suite: Suite) { for (const spec of suite.specs ?? []) tests.push(...spec.tests); for (const child of suite.suites ?? []) collect(child); }
  report.suites.forEach(collect);
  expect(report.errors, `Runner errors; artifacts: ${sandbox}`).toEqual([]);
  expect(tests).toHaveLength(1);
  expect(report.config.failOnFlakyTests).toBe(true);
  expect(report.config.forbidOnly).toBe(true);
  expect(report.config.webServer).toBeNull();
  expect(report.config.projects.find(project => project.name === 'chromium')?.retries).toBe(1);
  return { report, test: tests[0], code: result.status, cleanup: () => {
    // Check the resolved absolute target remains our own immediate temp child.
    if (path.dirname(realpathSync(sandbox)) !== tempRoot) throw new Error('Unsafe selftest cleanup target');
    rmSync(sandbox, { recursive: true, force: true });
  } };
}

it('a first failure followed by a passing retry remains flaky and fails CI', () => {
  const control = runControl('flaky');
  expect(control.code).toBe(1);
  expect(control.report.stats).toMatchObject({ expected: 0, unexpected: 0, skipped: 0, flaky: 1 });
  expect(control.test.status).toBe('flaky');
  expect(control.test.results.map(({ retry, status }) => ({ retry, status }))).toEqual([
    { retry: 0, status: 'failed' }, { retry: 1, status: 'passed' },
  ]);
  control.cleanup();
}, 60_000);

it('a healthy first attempt still exits successfully', () => {
  const control = runControl('healthy');
  expect(control.code).toBe(0);
  expect(control.report.stats).toMatchObject({ expected: 1, unexpected: 0, skipped: 0, flaky: 0 });
  expect(control.test.status).toBe('expected');
  expect(control.test.results.map(({ retry, status }) => ({ retry, status }))).toEqual([{ retry: 0, status: 'passed' }]);
  control.cleanup();
}, 60_000);
