import { describe, expect, it } from 'vitest';
import { settle, settleAll } from '@/lib/supabase/settle';

// The distinction this guards: Supabase RESOLVES { data, error } for anything
// the database answers, and REJECTS only when the request never completed —
// DNS, TCP, TLS, an aborted fetch. Pages check `res.error`, so a rejection is
// invisible to them, and inside Promise.all one rejection takes out every other
// read in the batch. That is what rendered the error boundary on /dashboard
// while production was reporting CONNECT_TIMEOUT.
describe('settle', () => {
  it('passes a resolved query through untouched, errors included', async () => {
    const ok = { data: [{ id: 1 }], count: 1, error: null };
    expect(await settle(Promise.resolve(ok))).toBe(ok);

    // A query error is NOT a rejection and must not be rewritten.
    const failed = { data: null, count: null, error: { message: 'permission denied' } };
    expect(await settle(Promise.resolve(failed))).toBe(failed);
  });

  it('turns a transport rejection into the shape callers already handle', async () => {
    const result = await settle(Promise.reject(new Error('fetch failed')));
    expect(result).toEqual({ data: null, count: null, error: { message: 'fetch failed' } });
  });

  it('survives a rejection that is not an Error', async () => {
    // eslint-disable-next-line prefer-promise-reject-errors
    const result = await settle(Promise.reject('ECONNRESET'));
    expect(result).toEqual({ data: null, count: null, error: { message: 'ECONNRESET' } });
  });
});

describe('settleAll', () => {
  it('keeps every other result when one query rejects', async () => {
    const [first, second, third] = await settleAll([
      Promise.resolve({ data: ['a'], count: 1, error: null }),
      Promise.reject(new Error('connect ETIMEDOUT')),
      Promise.resolve({ data: ['c'], count: 1, error: null }),
    ]);

    expect(first).toEqual({ data: ['a'], count: 1, error: null });
    expect(second).toEqual({ data: null, count: null, error: { message: 'connect ETIMEDOUT' } });
    expect(third).toEqual({ data: ['c'], count: 1, error: null });
  });

  it('never rejects, however many queries fail', async () => {
    await expect(settleAll([
      Promise.reject(new Error('one')),
      Promise.reject(new Error('two')),
    ])).resolves.toHaveLength(2);
  });

  it('preserves order so tuple destructuring stays correct', async () => {
    const results = await settleAll([
      Promise.resolve({ data: 1, count: null, error: null }),
      Promise.reject(new Error('boom')),
      Promise.resolve({ data: 3, count: null, error: null }),
    ]);
    expect(results.map((r) => (r as { data: unknown }).data)).toEqual([1, null, 3]);
  });
});
