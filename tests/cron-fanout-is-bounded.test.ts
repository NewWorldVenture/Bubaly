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
      // TWO COUNTERS, AND THEY MUST STAY TWO. Do not "simplify" `unserved` back
      // into `skipped`: the two names record outcomes with opposite statuses.
      //
      //   skipped  — a recipient the run REACHED and could not email (no
      //              address on file). Nothing to retry, so the run is still a
      //              success: tests/the-weekly-digest-reaches-every-family and
      //              tests/digest-cron-read-boundary pin that at 200 with a
      //              body of exactly { sent, failed: 0, skipped: 1 }.
      //   unserved — the tail the run NEVER ATTEMPTED because the budget ran
      //              out. It is the failure that raises no error of its own, so
      //              it must be counted from the loop index and must force 502.
      //
      // One counter cannot mean both; folding them back together forces one of
      // those two answers to be wrong. The property asserted here is unchanged
      // from when this guard said `skipped`: the tail is counted off the loop
      // index, and a non-zero count cannot produce a 200.
      //
      // The whole point: unserved must reach both the body and the status.
      expect(s).toMatch(/unserved\s*=\s*\w+\.length - i/);
      expect(s).toMatch(/failed === 0 && unserved === 0/);
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
