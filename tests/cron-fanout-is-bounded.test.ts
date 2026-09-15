import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A cron route that fans out per family or per recipient, serially, with no
// declared budget is not merely slow — it is silently unfair. The loop walks its
// collection in a stable order and keeps no cursor, so a run killed mid-loop
// serves the SAME prefix every week and never reaches the tail. Those families
// or members simply stop receiving the thing, and the route answers 200.
//
// weekly-digest and chore-reminders were both that shape. The repository had
// already learned the lesson elsewhere and written it down — model-refresh's
// header says "cron scales to thousands of families without blowing
// maxDuration", and provider-sync, library-feeds and marketing each carry an
// explicit budget — so this keeps the two that were fixed from drifting back.

const DIR = 'app/api/cron';
const FANOUT = ['weekly-digest', 'chore-reminders'];
const src = (name: string) => readFileSync(`${DIR}/${name}/route.ts`, 'utf8');

describe('the fan-out crons are bounded and honest about what they missed', () => {
  it('covers routes that exist', () => {
    const present = readdirSync(DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    for (const name of FANOUT) expect(present).toContain(name);
  });

  for (const name of FANOUT) {
    it(`${name} declares a budget rather than inheriting the platform default`, () => {
      expect(src(name)).toMatch(/export const maxDuration = \d+/);
      expect(src(name)).toMatch(/export const runtime = 'nodejs'/);
    });

    it(`${name} stops before the budget instead of being killed mid-loop`, () => {
      const s = src(name);
      expect(s).toMatch(/BUDGET_MS/);
      expect(s).toMatch(/Date\.now\(\) - startedAt > BUDGET_MS/);
    });

    it(`${name} fans out with bounded concurrency, not one at a time`, () => {
      const s = src(name);
      expect(s).toMatch(/CONCURRENCY/);
      expect(s).toMatch(/await Promise\.all\(/);
    });

    it(`${name} reports an unserved tail and does not answer 200`, () => {
      const s = src(name);
      // The whole point: skipped must reach both the body and the status.
      expect(s).toMatch(/skipped\s*=\s*\w+\.length - i/);
      expect(s).toMatch(/failed === 0 && skipped === 0/);
      expect(s).toMatch(/status: ok \? 200 : 502/);
    });

    it(`${name}'s budget leaves headroom under its own maxDuration`, () => {
      const s = src(name);
      const maxDuration = Number(/export const maxDuration = (\d+)/.exec(s)![1]);
      const budgetMs = Number(/const BUDGET_MS = ([\d_]+)/.exec(s)![1].replace(/_/g, ''));
      // A budget at or past maxDuration would never be reached before the kill.
      expect(budgetMs).toBeLessThan(maxDuration * 1000);
    });
  }
});
