import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { settleAll } from '../lib/supabase/settle';

// A Supabase query builder RESOLVES with { data, error } for anything the
// database answers, and REJECTS only when the request never completed — DNS,
// TCP, TLS, a timed-out fetch. Inside Promise.all that difference is the whole
// problem: one rejection rejects the batch, so a page that carefully handles
// res.error for every read still dies on an unhandled rejection and renders the
// error boundary. lib/supabase/settle.ts records that this is what took out
// /dashboard while the production database was reporting CONNECT_TIMEOUT.
//
// These four pages each had a batch where SOME elements were settled and at
// least one was not, which is the same failure with none of the protection the
// surrounding code appears to have.

describe('the batch contract these pages depend on', () => {
  it('Promise.all loses every result when one read never completes', async () => {
    const ok = Promise.resolve({ data: [1], count: 1, error: null });
    await expect(Promise.all([ok, Promise.reject(new Error('CONNECT_TIMEOUT'))]))
      .rejects.toThrow('CONNECT_TIMEOUT');
  });

  it('a settled read delivers the failure in the shape the page already handles', async () => {
    const ok = Promise.resolve({ data: [1], count: 1, error: null });
    const [a, b] = await settleAll([ok, Promise.reject(new Error('CONNECT_TIMEOUT'))]);
    expect(a).toEqual({ data: [1], count: 1, error: null });
    expect(b).toEqual({ data: null, count: null, error: { message: 'CONNECT_TIMEOUT' } });
  });
});

describe('pages whose read batches were mixed are fully settled', () => {
  // Deliberately per-file rather than a repository-wide scan. Three separate
  // attempts at a static rule for this each produced false positives — a
  // ternary whose query branch is already settled reads as unsettled, a local
  // try/catch wrapper (marketplace's `safe`) is settling but unrecognisable by
  // name, and a generic call `settle<T>(…)` breaks naive bracket tracking. A
  // guard that cries wolf trains people to add exemptions, so these assert only
  // what was actually verified by hand.
  // Counted, not matched. The first version of this asserted
  // `expect(src).toMatch(/\? settle\(supabase\.from\(/)` — which passes as long
  // as ONE branch is settled, so unsettling one of missions' three went
  // unnoticed. Verified by doing exactly that: the regression was real and the
  // test stayed green. Counting both sides is what makes it fail.
  const cases: { file: string; settledTernaries: number; settleCalls: number }[] = [
    { file: 'app/(app)/guardian/contacts/page.tsx', settledTernaries: 0, settleCalls: 2 },
    { file: 'app/(app)/guardian/settings/page.tsx', settledTernaries: 0, settleCalls: 2 },
    { file: 'app/(app)/missions/page.tsx', settledTernaries: 3, settleCalls: 3 },
    { file: 'app/(app)/display/page.tsx', settledTernaries: 2, settleCalls: 2 },
  ];

  const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

  for (const { file, settledTernaries, settleCalls } of cases) {
    it(`${file.split('/').slice(-2).join('/')} leaves no query unsettled in its batch`, () => {
      const src = readFileSync(file, 'utf8');

      // The defect itself: a conditional whose query branch rejects on its own.
      expect(
        count(src, /\?\s*supabase\.from\(/g),
        `${file} has a conditional query branch that is not settled`,
      ).toBe(0);

      // And the settled ones are still there — a fix that deletes the reads
      // instead of settling them would otherwise satisfy the line above.
      expect(count(src, /\?\s*settle\(supabase\.from\(/g)).toBe(settledTernaries);
      expect(count(src, /settle[(<]/g)).toBeGreaterThanOrEqual(settleCalls);

      // No batch element may START with a bare builder: that is the shape that
      // rejects the whole Promise.all.
      expect(src, `${file} has a bare query at the start of a batch element`)
        .not.toMatch(/\n\s{4}(await\s+)?supabase\.from\(/);
    });
  }

  it('settles the branch, never the ternary', () => {
    // `settle(cond ? a : b)` does not typecheck — Promise<A> | Promise<B> is not
    // PromiseLike<A | B> — and wrapping the ternary was how the first attempt
    // broke the build.
    for (const f of ['app/(app)/missions/page.tsx', 'app/(app)/display/page.tsx']) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/settle\([^)]*\?\s*supabase\.from\(/);
    }
  });
});
