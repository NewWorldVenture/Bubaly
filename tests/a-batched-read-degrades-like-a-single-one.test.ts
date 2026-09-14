// `readInChunks` promised partial-failure tolerance that `Promise.all` denied.
//
// Its docstring says: "The first error wins and the rows gathered so far are
// still returned, which matches how the single-request version behaves for
// callers that log the error and render what they have." A query builder
// RESOLVES with { data, error } for anything the database answers and REJECTS
// only on a transport failure — DNS, TCP, TLS, an aborted fetch — and inside
// `Promise.all` one rejected chunk rejected the whole read. The caller got
// nothing and its `if (error)` branch never ran, so the sentence above was false
// in precisely the outage it was written for.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readInChunks } from '@/lib/supabase/chunked-in';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

describe('a batched read degrades like a single one', () => {
  it('returns the rows it has when one chunk never completes', async () => {
    // 150 ids at 100 per request is two chunks; the second dies in transport.
    let chunk = 0;
    const { data, error } = await readInChunks(ids(150), async (batch) => {
      if (++chunk === 2) throw new Error('fetch failed');
      return { data: batch.map((id) => ({ id })), error: null };
    });
    expect(error).toEqual({ message: 'fetch failed' });
    expect(data).toHaveLength(100);
  });

  it('does not reject, so the caller reaches its own error branch', async () => {
    await expect(readInChunks(ids(150), async () => { throw new Error('CONNECT_TIMEOUT'); }))
      .resolves.toMatchObject({ data: [], error: { message: 'CONNECT_TIMEOUT' } });
  });

  it('still reports a resolved error the same way', async () => {
    // The half that always worked, kept as the control: a database that ANSWERS
    // with an error must be indistinguishable to the caller from one that could
    // not be reached. That equivalence is the whole point of settling.
    const { data, error } = await readInChunks(ids(150), async (batch) =>
      batch[0] === 'id-100' ? { data: null, error: { message: 'permission denied' } }
        : { data: batch.map((id) => ({ id })), error: null });
    expect(error).toEqual({ message: 'permission denied' });
    expect(data).toHaveLength(100);
  });

  it('a clean read is unchanged', async () => {
    const { data, error } = await readInChunks(ids(250), async (batch) => ({ data: batch.map((id) => ({ id })), error: null }));
    expect(error).toBeNull();
    expect(data).toHaveLength(250);
  });

  it('is settled rather than Promise.all-ed', async () => {
    // The behavioural cases above are the real guard; this one names the
    // mechanism so a future edit back to Promise.all is rejected with the reason
    // rather than with four mysterious failures.
    const source = readFileSync('lib/supabase/chunked-in.ts', 'utf8');
    expect(source).toContain('settleAll(chunks.map');
    expect(source).not.toMatch(/Promise\.all\(chunks/);
  });
});

// The census that led here, kept so nobody re-runs it from scratch.
//
// The audit finding counted 47 pages with a raw `Promise.all` over Supabase
// reads and called the fix "mechanical". Reading the six it named by hand, FIVE
// were false positives — each had solved the problem another way, which is
// exactly why all three of the finding's signals (a `Promise.all`, no `settle`
// import, no `.error` substring) fired on them.
describe('the sites that handle a transport rejection another way', () => {
  const HANDLED: [string, string, RegExp][] = [
    ['app/(app)/dashboard/dining/page.tsx', 'a local per-query try/catch', /const safe = async[\s\S]*?catch \{ return \[\]; \}/],
    ['app/(app)/dashboard/planning/page.tsx', 'a local per-query fail-safe', /async function safe</],
    ['app/(app)/dashboard/food/page.tsx', 'the shared degrade-read, which also LOGS the failure', /makeDegradeRead\('food'\)/],
    ['app/(app)/guardian/page.tsx', 'settleAll already, with every error read', /settleAll\(/],
    ['app/(marketing)/blog/page.tsx', 'helpers that catch internally (lib/blog/posts.ts)', /getAllPosts\(\)/],
    ['app/(app)/dashboard/onboarding-funnel/page.tsx', 'readTelemetry catches and returns { data: null, error }', /loadOnboardingEvents\(/],
  ];

  it.each(HANDLED)('%s is protected by %s', (file, _mechanism, evidence) => {
    expect(readFileSync(file, 'utf8')).toMatch(evidence);
  });
});
