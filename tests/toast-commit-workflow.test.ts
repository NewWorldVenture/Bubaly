import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import unitConfig from '../vitest.config';
import browserConfig from '../vitest.toast-browser.config';

const { load } = createRequire(import.meta.url)('js-yaml') as { load: (text: string) => {
  jobs: Record<string, { strategy?: { matrix?: { shard?: number[] } }; steps?: { name?: string; run?: string; if?: string; 'continue-on-error'?: boolean }[] }>;
} };
const workflow = load(readFileSync('.github/workflows/ci.yml', 'utf8'));

describe('the toast commit browser gate really runs after browser installation', () => {
  it('selects only the browser fixture without merging the ordinary unit include', () => {
    expect(browserConfig.test?.include).toEqual(['tests/toast-commit-lifetime.browser.ts']);
    expect(unitConfig.test?.include).toEqual(['tests/**/*.test.ts']);
    expect('tests/toast-commit-lifetime.browser.ts'.endsWith('.test.ts')).toBe(false);
  });
  it('requires a single shard run after Chromium installation without a skip or failure waiver', () => {
    const jobs = Object.values(workflow.jobs).filter(job => job.steps?.some(step => step.name === 'Verify toast commit lifetimes in Chromium'));
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    expect(job.strategy?.matrix?.shard).toContain(1);
    const steps = job.steps!;
    const index = steps.findIndex(step => step.name === 'Verify toast commit lifetimes in Chromium');
    const install = steps.findIndex(step => step.name === 'Install Playwright browser');
    expect(install).toBeGreaterThanOrEqual(0); expect(index).toBeGreaterThan(install);
    expect(steps[install].run).toBe('npx playwright install --with-deps chromium');
    expect(steps[index].if).toBe('matrix.shard == 1');
    expect(steps[index].run).toBe('node node_modules/vitest/vitest.mjs run --config vitest.toast-browser.config.ts --maxWorkers 1');
    expect(steps[index]['continue-on-error']).not.toBe(true);
  });
  it('has no conditional browser availability skip inside the selected fixture', () => {
    const fixture = readFileSync('tests/toast-commit-lifetime.browser.ts', 'utf8');
    expect(fixture).not.toMatch(/(?:describe|it|test)\.(?:skip|skipIf|runIf|todo)/);
    expect(fixture).toContain('browser = await chromium.launch(');
  });
});
