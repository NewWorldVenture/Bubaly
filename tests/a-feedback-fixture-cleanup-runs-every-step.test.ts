// The SEC-007 browser suite owns a disposable account, a super-admin grant,
// Storage objects and idea rows. Its teardown first closes the context without
// a snapshot, and that close can reject. Before this, a rejection there (or in
// any one deletion) skipped every step after it, leaving the account and its
// grant behind. Every failure here is synthetic.
import { describe, expect, it, vi } from 'vitest';
import { cleanUpFeedbackFixture, runEveryStep } from './e2e/helpers/feedback-fixture-cleanup';

type Fail = Partial<Record<'ideas' | 'list' | 'remove' | 'grant', 'answer' | 'throw'>>;

function fixture(fail: Fail = {}, { closeRejects = false, disposeRejects = false, dbThrows = false } = {}) {
  const calls: string[] = [];
  const outcome = (what: keyof Fail, value: Record<string, unknown> = {}) => {
    calls.push(what);
    if (fail[what] === 'throw') return Promise.reject(new Error(`synthetic ${what} threw`));
    return Promise.resolve({ ...value, error: fail[what] === 'answer' ? { message: `synthetic ${what} failed` } : null });
  };
  const db = {
    from: (table: string) => ({
      delete: () => ({
        like: () => outcome(table === 'feedback_ideas' ? 'ideas' : 'grant'),
        eq: () => outcome(table === 'super_admins' ? 'grant' : 'ideas'),
      }),
    }),
    storage: {
      from: () => ({
        list: () => outcome('list', { data: fail.list ? null : [{ name: 'a.png' }, { name: 'b.png' }] }),
        remove: (paths: string[]) => { calls.push(`remove ${paths.join(',')}`); return outcome('remove'); },
      }),
    },
  };
  const account = {
    email: 'Synthetic@Example.test', password: 'synthetic-password-not-real', userId: 'user-1', familyId: 'family-1',
    dispose: vi.fn(async () => { calls.push('dispose'); if (disposeRejects) throw new Error('synthetic dispose failed'); }),
  };
  const close = vi.fn(async () => { calls.push('close'); if (closeRejects) throw new Error('synthetic close failed'); });
  const run = (withAccount = true) => cleanUpFeedbackFixture({
    close, bucket: 'feedback-attachments', run: 'r1', account: withAccount ? account : null,
    db: () => { if (dbThrows) throw new Error('synthetic client failed'); return db as never; },
  });
  return { calls, account, close, run };
}

async function failure(promise: Promise<unknown>): Promise<AggregateError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(AggregateError);
  return error as AggregateError;
}

describe('the SEC-007 fixture teardown runs every step', () => {
  it('in order, when nothing fails', async () => {
    const f = fixture();
    await f.run();
    expect(f.calls).toEqual(['close', 'ideas', 'list', 'remove user-1/a.png,user-1/b.png', 'remove', 'grant', 'dispose']);
  });

  it('a context that will not close still has its rows, objects, grant and account removed', async () => {
    const f = fixture({}, { closeRejects: true });
    const error = await failure(f.run());
    expect(f.calls).toEqual(['close', 'ideas', 'list', 'remove user-1/a.png,user-1/b.png', 'remove', 'grant', 'dispose']);
    expect(error.message).toBe('Fixture cleanup failed: close the context.');
  });

  it('when every step fails, each is still attempted once, and each is reported', async () => {
    const f = fixture({ ideas: 'answer', list: 'throw', grant: 'answer' }, { closeRejects: true, disposeRejects: true });
    const error = await failure(f.run());
    expect(f.calls).toEqual(['close', 'ideas', 'list', 'grant', 'dispose']);
    expect(error.message).toBe('Fixture cleanup failed: close the context, delete the run’s ideas, remove the account’s attachments, revoke the super-admin grant, dispose of the account.');
    expect(error.errors).toHaveLength(5);
  });

  it('an answered failure is a failure: Supabase does not throw one', async () => {
    const f = fixture({ remove: 'answer' });
    const error = await failure(f.run());
    expect(f.account.dispose).toHaveBeenCalledOnce();
    expect(error.message).toBe('Fixture cleanup failed: remove the account’s attachments.');
  });

  it('a client that cannot be built fails its own steps, and the context is still closed and the account disposed', async () => {
    const f = fixture({}, { dbThrows: true });
    await failure(f.run());
    expect(f.calls).toEqual(['close', 'dispose']);
  });

  it('with no account (set-up failed before one existed), it closes and deletes the run’s rows only', async () => {
    const f = fixture();
    await f.run(false);
    expect(f.calls).toEqual(['close', 'ideas']);
  });

  it('never puts a credential in its message', async () => {
    const f = fixture({ ideas: 'answer', grant: 'answer' }, { closeRejects: true, disposeRejects: true });
    const error = await failure(f.run());
    expect(error.message).not.toMatch(/synthetic-password|Synthetic@Example/i);
  });

  it('runEveryStep resolves when every step does', async () => {
    await expect(runEveryStep([['one', async () => 1], ['two', async () => 2]])).resolves.toBeUndefined();
  });
});
