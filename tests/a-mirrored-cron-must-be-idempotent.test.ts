import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEDULES } from '../scripts/cron-dispatch.mjs';

const ROOT = join(__dirname, '..');
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as {
  crons: { path: string; schedule: string }[];
};
const dispatcher = readFileSync(join(ROOT, 'scripts/cron-dispatch.mjs'), 'utf8');

/**
 * Two schedulers drive the same routes, and one sentence is what makes that safe.
 *
 * `scripts/cron-dispatch.mjs` explains why both exist: Vercel's Hobby plan
 * refuses anything more frequent than daily, so `vercel.json` carries daily-safe
 * schedules "so production deploys on any plan" while the real cadences live in
 * `SCHEDULES` and are driven every five minutes by
 * `.github/workflows/cron-dispatch.yml`. The two lists are deliberately MIRRORED
 * — the same header says that on Vercel Pro you "copy SCHEDULES below" into
 * vercel.json and disable the workflow — and `tests/cron-dispatch.test.ts`
 * already guards that mirror in both directions.
 *
 * What nothing guards is the claim the mirror rests on:
 *
 *   "The routes are idempotent and CRON_SECRET-gated (lib/server/cron-auth.ts),
 *    so a Vercel daily run and a GitHub run of the same route never conflict."
 *
 * That is true of almost every route, and it is true for good reasons that were
 * checked rather than assumed: `wallet-allowance` claims each rule with a
 * compare-and-swap whose loser matches zero rows, `close-auctions` re-reads only
 * `status = 'available'` after its settlement RPC, and every notification path
 * funnels through `notify()`, which filters already-notified recipients before
 * inserting.
 *
 * `admin-digest` is the exception, and because both schedules are the identical
 * `30 12 * * *`, the exception is not a rare retry — it is **every day**. Its
 * window is `Date.now() - 24h` and nothing records that a digest was sent, so
 * two runs at the same minute both find the same activity and both send. Every
 * super admin receives two identical emails daily.
 *
 * Deliberately NOT a scan for a dedupe marker across all 24 routes. That was
 * tried: ten routes show no marker in their own `route.ts` because the
 * mechanism lives in a lib they call, so the scan would open with nine false
 * accusations — which is how a guard gets exemptions bolted on until it means
 * nothing.
 */

/**
 * Routes known to break the dispatcher's idempotency claim. A backlog, not a
 * licence: it may only SHRINK, and the rules below fail if an entry is stale.
 */
const KNOWN_DOUBLE_SEND: { path: string; why: string; fix: string }[] = [
  {
    path: '/api/cron/admin-digest',
    why: 'window is Date.now() - 24h and no run is recorded, so two dispatches at the same minute both send',
    fix: 'persist a high-water mark (last_digested_at) and derive `since` from it',
  },
];

/** The dedupe mechanisms a route can use to survive a second dispatch. */
const IDEMPOTENCY = /notify\(|onConflict|\.lte\('next_run_on|claimed|sent_at|dedupe|already|processed/;

describe('a mirrored cron must survive being dispatched twice', () => {
  it('the mirror really is total (guards the guard)', () => {
    // If the two lists ever stopped overlapping, double-dispatch would not be a
    // property of this system and every rule below would be about nothing.
    const vercelPaths = new Set(vercel.crons.map((c) => c.path));
    const dispatched = new Set(Object.keys(SCHEDULES));
    expect(vercelPaths.size).toBeGreaterThan(20);
    for (const p of dispatched) expect(vercelPaths.has(p), `${p} is dispatched but not in vercel.json`).toBe(true);
  });

  it('records the dispatcher’s claim verbatim, so a contradiction is visible', () => {
    // The rules below only matter while this sentence is what justifies the
    // mirror. If it is ever rewritten, they should be re-read rather than
    // silently kept.
    expect(dispatcher).toContain('The routes are idempotent');
    expect(dispatcher).toContain('never conflict');
  });

  it('every backlog entry still double-fires at the identical minute', () => {
    // Evidence, not assertion: the entry is only a defect while BOTH schedulers
    // fire it at the same time. If Vercel's schedule is moved off the
    // dispatcher's, the duplicate stops and the entry must go.
    for (const { path } of KNOWN_DOUBLE_SEND) {
      const v = vercel.crons.find((c) => c.path === path);
      expect(v, `${path} is no longer in vercel.json; remove it from KNOWN_DOUBLE_SEND`).toBeDefined();
      expect(
        v?.schedule,
        `${path} no longer shares a minute with the dispatcher; the duplicate is gone, remove the entry`,
      ).toBe((SCHEDULES as Record<string, string>)[path]);
    }
  });

  it('every backlog entry still lacks a dedupe — the list shrinks when one is fixed', () => {
    for (const { path, fix } of KNOWN_DOUBLE_SEND) {
      const source = readFileSync(join(ROOT, `app${path}/route.ts`), 'utf8');
      expect(
        IDEMPOTENCY.test(source),
        `${path} now carries a dedupe mechanism — remove it from KNOWN_DOUBLE_SEND (fix was: ${fix})`,
      ).toBe(false);
    }
  });

  it('states a fix and a mechanism for each entry', () => {
    // An entry without either is a complaint rather than a record.
    for (const { path, why, fix } of KNOWN_DOUBLE_SEND) {
      expect(why.length, `${path} does not say how it double-sends`).toBeGreaterThan(30);
      expect(fix.length, `${path} does not say what would fix it`).toBeGreaterThan(20);
    }
  });

  it('recognises the dedupe shapes it looks for (calibrates the matcher)', () => {
    // Checked against the real spellings in this repo, so the rule above cannot
    // pass by failing to recognise a fix that landed.
    expect(IDEMPOTENCY.test("const sent = await notify(scope, { recipients: 'family' })")).toBe(true);
    expect(IDEMPOTENCY.test(".update({ next_run_on: next }).lte('next_run_on', today)")).toBe(true);
    expect(IDEMPOTENCY.test("upsert(row, { onConflict: 'family_id' })")).toBe(true);
    expect(IDEMPOTENCY.test("const since = new Date(Date.now() - 24 * 60 * 60 * 1000)")).toBe(false);
  });
});
