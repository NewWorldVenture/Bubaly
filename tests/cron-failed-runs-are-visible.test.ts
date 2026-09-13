import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A cron route that answers 200 after its work failed is indistinguishable from
// a clean run: Vercel Cron records the status, and nothing else does — no route
// in this directory writes a durable run record. F-009 established the house
// pattern (a failed run answers non-200); feedback-github-sync returned a
// hardcoded `{ ok: true }` with 200 while counting errors it had already
// alerted super admins about.

const dir = 'app/api/cron';
const routes = readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => `${dir}/${e.name}/route.ts`);

describe('a failed cron run is visible in its status code', () => {
  it('covers every scheduled job', () => {
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons?: { path: string }[] };
    expect(routes.length).toBeGreaterThanOrEqual((vercel.crons ?? []).length);
  });

  // The precise rule, and it took two tries to get right. `ok: true` alone is
  // fine — several routes return it for a legitimate nothing-to-do state
  // ("no activity in the last 24h", "wallet_not_deployed"), which is a clean run
  // and must stay a 200. The defect is reporting success in the SAME response
  // that carries a failure counter.
  const FAILURE_COUNTERS = ['failed', 'failures', 'errors', 'deadLettered'];

  it('never reports ok:true in a response that also carries a failure count', () => {
    for (const file of routes) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/NextResponse\.json\(\s*\{([^}]*)\}/g)) {
        const body = m[1];
        if (!/\bok:\s*true\b/.test(body)) continue;
        const counter = FAILURE_COUNTERS.find((c) => new RegExp(`\\b${c}\\b`).test(body));
        expect(
          counter,
          `${file} answers ok:true in a response carrying "${counter}" — derive ok from it`,
        ).toBeUndefined();
      }
    }
  });

  it('a spread summary cannot smuggle a failure count past a literal ok', () => {
    // `{ ok: true, ...summary }` hid four of these: the counter is not visible in
    // the response literal at all. A spread must put `ok` AFTER it, computed.
    for (const file of routes) {
      const src = readFileSync(file, 'utf8');
      expect(
        /NextResponse\.json\(\s*\{\s*ok:\s*true\s*,\s*\.\.\./.test(src),
        `${file} spreads a summary behind a hardcoded ok:true`,
      ).toBe(false);
    }
  });

  it('every route can answer a non-200 after authorization', () => {
    for (const file of routes) {
      const src = readFileSync(file, 'utf8');
      const afterAuth = src.slice(src.indexOf('hasCronAuthorization'));
      // 502 is the house code for "ran, but the work failed".
      expect(afterAuth, `${file} can only ever answer 200 once authorized`).toMatch(/50[0-9]/);
    }
  });

  it('feedback-github-sync answers 502 when the sync reported errors', () => {
    const src = readFileSync(`${dir}/feedback-github-sync/route.ts`, 'utf8');
    expect(src).toContain('result.errors === 0');
    expect(src).toMatch(/status:\s*ok\s*\?\s*200\s*:\s*502/);
  });

  it('an unconfigured bot is still a clean run, not a failure', () => {
    // `configured: false` returns errors: 0, so the route must answer 200.
    const lib = readFileSync('lib/feedback/github-sync.ts', 'utf8');
    expect(lib).toContain('return { configured: false, created: 0, reconciled: 0, changes: [], errors: 0 }');
  });
});
