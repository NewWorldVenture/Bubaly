import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Three fixes to the test harness itself that nothing held in place. Each one is
// a line in a config file; each was found because its absence cost something.
const vitestConfig = readFileSync('vitest.config.ts', 'utf8');
const code = vitestConfig.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');

describe('the vitest config', () => {
  it('sets a test and hook timeout (MAIN-F-F05)', () => {
    // 96 tests share a cold `await import(...)` that measured 5,007 ms cold
    // against 422 ms warm; under the 5 s default the first one flaked (TEST-010).
    expect(code).toMatch(/testTimeout:\s*20_000/);
    expect(code).toMatch(/hookTimeout:\s*20_000/);
  });

  it('configures JSX through oxc, the transformer vitest 4 actually uses, and has no dead esbuild block (MAIN-F-F12)', () => {
    expect(code).toMatch(/oxc:\s*\{\s*jsx:\s*\{\s*runtime:\s*'automatic'/);
    expect(code).not.toMatch(/\besbuild\s*:/);
  });

  it('lets the environment choose the time zone, so the DST job is not overridden', () => {
    expect(code).toContain("TZ: process.env.TZ ?? 'UTC'");
  });
});

describe('CI runs the suite on a DST-observing host (MAIN-F-F04)', () => {
  // The spring-forward case in tests/assistant-capture-fidelity.test.ts can only
  // go red where the clocks change. Production and the default job run UTC, so
  // without this step the bug it caught would pass every run again.
  it('has a unit-test step with TZ=America/Los_Angeles', () => {
    expect(ci).toMatch(/- name: Unit tests \(DST-observing host\)\s+run: npm test\s+env:\s+TZ: America\/Los_Angeles/);
  });

  it('and the case it exists for is still there', () => {
    expect(readFileSync('tests/assistant-capture-fidelity.test.ts', 'utf8')).toContain('first minute that exists');
  });
});

describe('lint fails on a warning (MAIN-F-D14)', () => {
  // The three exhaustive-deps warnings lived for weeks as "the documented
  // baseline" because `next lint` exits 0 on warnings, so CI could not see a
  // fourth. The baseline is now zero, and a warning fails the Lint step.
  it('the lint script refuses any warning', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.lint).toMatch(/--max-warnings 0\b/);
  });

  it('and CI runs that script', () => {
    expect(ci).toMatch(/- name: Lint\s+run: npm run lint\b/);
  });
});

describe('the mobile app\'s dependencies are audited (MAIN-F-C10)', () => {
  it('the mobile CI job runs npm audit on production dependencies', () => {
    const mobileJob = ci.slice(ci.indexOf('\n  mobile:'), ci.indexOf('\n  database:'));
    expect(mobileJob).toContain('working-directory: mobile');
    expect(mobileJob).toMatch(/run: npm audit --omit=dev --audit-level=(high|moderate|critical)\b/);
  });
});
