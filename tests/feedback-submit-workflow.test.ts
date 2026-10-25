import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import unitConfig from '../vitest.config';
import browserConfig from '../vitest.feedback-browser.config';

type Step = { name?: string; run?: string; if?: string; 'continue-on-error'?: boolean };
const { load } = createRequire(import.meta.url)('js-yaml') as {
  load: (text: string) => { jobs: Record<string, { strategy?: { matrix?: { shard?: number[] } }; steps?: Step[] }> };
};
const workflow = load(readFileSync('.github/workflows/ci.yml', 'utf8'));

describe('the feedback outcome browser regression is a required CI gate', () => {
  it('selects its actual browser fixture separately from ordinary unit tests', () => {
    expect(browserConfig.test?.include).toEqual(['tests/feedback-submit-outcome.browser.ts']);
    expect(unitConfig.test?.include).toEqual(['tests/**/*.test.ts']);
    const fixture = readFileSync('tests/feedback-submit-outcome.browser.ts', 'utf8');
    expect(fixture).not.toMatch(/(?:describe|it|test)\.(?:skip|skipIf|runIf|todo)/);
    expect(fixture).toContain('browser = await chromium.launch(');
  });
  it('requires one shard after browser installation and keeps the toast gate', () => {
    const name = 'Verify feedback submission outcomes in Chromium';
    const jobs = Object.values(workflow.jobs).filter(job => job.steps?.some(step => step.name === name));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].strategy?.matrix?.shard).toContain(1);
    const steps = jobs[0].steps!;
    const index = steps.findIndex(step => step.name === name);
    const install = steps.findIndex(step => step.name === 'Install Playwright browser');
    expect(install).toBeGreaterThanOrEqual(0);
    expect(index).toBeGreaterThan(install);
    expect(steps[install].run).toBe('npx playwright install --with-deps chromium');
    expect(steps[index].if).toBe('matrix.shard == 1');
    expect(steps[index].run).toBe('node node_modules/vitest/vitest.mjs run --config vitest.feedback-browser.config.ts --maxWorkers 1');
    expect(steps[index]['continue-on-error']).not.toBe(true);
    expect(steps.filter(step => step.name === 'Verify toast commit lifetimes in Chromium')).toHaveLength(1);
  });
});
