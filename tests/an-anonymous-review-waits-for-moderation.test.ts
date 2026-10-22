// A stranger's review is never published on arrival (audit N4).
//
// /reviews/new is public. Once an admin set reputation_settings.auto_approve_min,
// any review at or above it was written `approved` and drawn on the public
// /reviews wall at once — the only control was 5 a minute per address, so one
// address could post 7,200 approved five-star reviews a day under invented
// names, and rotating addresses removed even that bound. Driven through the
// real action against the in-memory database: a stranger's submission waits for
// moderation whatever the threshold, a signed-in member's still clears it (the
// control), a filled honeypot writes nothing and is told what a person is told,
// an address gets three a day, and the same text twice in a day is one review.
//
// The repeat check used to be a limiter bucket charged BEFORE the insert, so a
// refused insert consumed it and the same person's retry was answered
// { ok: true } with nothing written (audit RV1-N4). The record that a text was
// written now travels with the row, so a refused write leaves nothing to find.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const h = vi.hoisted(() => ({ db: null as unknown, userId: null as string | null, ip: '203.0.113.9' }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/auth/signed-in-user', () => ({ signedInUserId: async () => h.userId }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': h.ip }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

type Db = ReturnType<typeof createInMemorySupabase>;
let db: Db;
const submit = async (input: Record<string, unknown>) => (await import('@/app/reviews/new/actions')).submitReviewAction(input as never);
const reviews = () => db.table('reviews');

beforeEach(() => {
  vi.resetModules();
  h.userId = null;
  h.ip = '203.0.113.9';
  db = createInMemorySupabase({ rpc: { rate_limit_hit: rateLimitHit } });
  // The admin has set the threshold: the configuration under which the defect holds.
  db.seed('reputation_settings', [{ singleton: true, auto_approve_min: 4 }]);
  h.db = db;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('who clears the auto-approve threshold', () => {
  it('a stranger\'s five-star review is written pending, not approved', async () => {
    expect(await submit({ rating: 5, title: 'Wonderful', body: 'Changed our mornings.', name: 'Pat' })).toEqual({ ok: true });
    expect(reviews()).toHaveLength(1);
    expect(reviews()[0]).toMatchObject({ rating: 5, title: 'Wonderful', author_name: 'Pat', status: 'pending' });
  });

  it('a signed-in member\'s review still clears it, and still waits below it (control)', async () => {
    h.userId = 'user-member';
    expect(await submit({ rating: 5, title: 'Wonderful', body: 'Changed our mornings.' })).toEqual({ ok: true });
    expect(await submit({ rating: 3, title: 'Fine', body: 'Does the job.' })).toEqual({ ok: true });
    expect(reviews().map((row) => [row.rating, row.status])).toEqual([[5, 'approved'], [3, 'pending']]);
  });

  it('with no threshold configured a member\'s review is pending too (the shipped default)', async () => {
    db.table('reputation_settings')[0].auto_approve_min = null;
    h.userId = 'user-member';
    expect(await submit({ rating: 5, body: 'Lovely.' })).toEqual({ ok: true });
    expect(reviews()[0]).toMatchObject({ status: 'pending' });
  });
});

describe('what a bot gets', () => {
  it('a filled honeypot is answered exactly like a success and writes nothing', async () => {
    expect(await submit({ rating: 5, body: 'Buy now', website: 'https://spam.example' })).toEqual({ ok: true });
    expect(reviews()).toEqual([]);
  });

  it('an empty honeypot is a person (control)', async () => {
    expect(await submit({ rating: 4, body: 'Helpful.', website: '' })).toEqual({ ok: true });
    expect(reviews()).toHaveLength(1);
  });

  it('the fourth review from one address in a day is refused; another address is not', async () => {
    for (const body of ['First.', 'Second.', 'Third.']) expect(await submit({ rating: 5, body })).toEqual({ ok: true });
    expect(await submit({ rating: 5, body: 'Fourth.' })).toEqual({ ok: false, error: 'actions.tooManyReviewAttemptsPlease' });
    expect(reviews()).toHaveLength(3);
    h.ip = '198.51.100.7';
    expect(await submit({ rating: 5, body: 'Fourth, elsewhere.' })).toEqual({ ok: true });
    expect(reviews()).toHaveLength(4);
  });

  it('the same text twice in a day is one review, and the repeat is told nothing', async () => {
    const review = { rating: 5, title: 'Wonderful', body: 'Changed our mornings.' };
    expect(await submit(review)).toEqual({ ok: true });
    expect(await submit({ ...review, name: 'Someone Else' })).toEqual({ ok: true });
    expect(reviews()).toHaveLength(1);
  });

  it('a refused insert does not spend the repeat check: the retry with the same text is written (audit RV1-N4)', async () => {
    const review = { rating: 5, title: 'Wonderful', body: 'Changed our mornings.' };
    let refuse = true;
    h.db = withFaults(db, (table, calls) => table === 'reviews' && refuse && calls.some((call) => call.method === 'insert')
      ? { code: '57P01', message: 'synthetic write failure' } : null);
    expect(await submit(review)).toEqual({ ok: false, error: 'actions.couldNotSaveYourReview' });
    expect(reviews()).toEqual([]);
    refuse = false;
    expect(await submit(review)).toEqual({ ok: true });
    expect(reviews()).toHaveLength(1);
    expect(reviews()[0]).toMatchObject({ title: 'Wonderful', body: 'Changed our mornings.', status: 'pending' });
    // And once written, the same words are still one review.
    expect(await submit({ ...review, name: 'Someone Else' })).toEqual({ ok: true });
    expect(reviews()).toHaveLength(1);
  });

  it('a repeat check that cannot be read is reported, not answered as a success that wrote nothing', async () => {
    h.db = withFaults(db, (table, calls) => table === 'reviews' && calls.some((call) => call.method === 'select')
      ? { code: '57P01', message: 'synthetic read failure' } : null);
    expect(await submit({ rating: 5, body: 'Helpful.' })).toEqual({ ok: false, error: 'actions.couldNotSaveYourReview' });
    expect(reviews()).toEqual([]);
  });
});

// Two submissions at once (PR #1077 review). The repeat check above reads the
// rows that were written, and a read cannot see a write that has not happened
// yet: two submissions of the same words that both read before either wrote
// both found nothing and both wrote, since nothing in the schema makes the
// fingerprint unique. `holdFingerprintReads` makes that schedule
// deterministic: each fingerprint read completes, and its answer is held until
// both have arrived. Only the fingerprint reads are held, never the `.select`
// that confirms an insert, an update or a delete.
function holdFingerprintReads<T extends object>(client: T, expected = 2): { client: T; arrived: () => number } {
  let arrived = 0;
  let release: () => void = () => {};
  const together = new Promise<void>((resolve) => { release = resolve; });
  const held = new Proxy(client, {
    get(target, property, receiver) {
      if (property !== 'from') return Reflect.get(target, property, receiver);
      return (table: string) => {
        const builder = (target as unknown as { from: (name: string) => object }).from(table);
        if (table !== 'reviews') return builder;
        const methods: string[] = [];
        const chain: object = new Proxy(builder, {
          get(object, key) {
            const value: unknown = Reflect.get(object, key);
            if (typeof value !== 'function') return value;
            if (key === 'then') {
              const read = methods.includes('select') && !methods.some((m) => ['insert', 'upsert', 'update', 'delete'].includes(m));
              if (!read) return value.bind(object);
              return (resolve: (reply: unknown) => unknown, reject: (reason: unknown) => unknown) => {
                const answered = Promise.resolve(value.call(object, (reply: unknown) => reply));
                arrived += 1;
                if (arrived === expected) release();
                return together.then(() => answered).then(resolve, reject);
              };
            }
            return (...args: unknown[]) => {
              methods.push(String(key));
              const result: unknown = Reflect.apply(value, object, args);
              return result === object ? chain : result;
            };
          },
        });
        return chain;
      };
    },
  });
  return { client: held, arrived: () => arrived };
}

/** A database whose `rate_limit_hit` runs `around` for the review-text key and counts every other key as usual. */
function withTextArbiter(around: (args: Record<string, unknown>, store: Db) => unknown): Db {
  const store = createInMemorySupabase({
    rpc: { rate_limit_hit: (args, inner) => String(args.p_key).startsWith('review:text:') ? around(args, inner as Db) : rateLimitHit(args, inner) },
  });
  store.seed('reputation_settings', [{ singleton: true, auto_approve_min: 4 }]);
  return store;
}

describe('two submissions at once', () => {
  const review = { rating: 5, title: 'Wonderful', body: 'Changed our mornings.' };
  const both = () => Promise.all([submit({ ...review, name: 'First' }), submit({ ...review, name: 'Second' })]);

  it('the same words twice at once are one review, and both are told ok', async () => {
    const hold = holdFingerprintReads(db);
    h.db = hold.client;
    expect(await both()).toEqual([{ ok: true }, { ok: true }]);
    expect(hold.arrived(), 'both repeat checks answered before either submission wrote').toBe(2);
    expect(reviews()).toHaveLength(1);
  });

  it('different words at once are two reviews (control)', async () => {
    const hold = holdFingerprintReads(db);
    h.db = hold.client;
    const answers = await Promise.all([submit({ rating: 5, body: 'Helpful.' }), submit({ rating: 4, body: 'Handy.' })]);
    expect(answers).toEqual([{ ok: true }, { ok: true }]);
    expect(hold.arrived()).toBe(2);
    expect(reviews().map((row) => row.body).sort()).toEqual(['Handy.', 'Helpful.']);
  });

  it('when the first of two identical submissions is refused its insert, the second is the one written', async () => {
    const hold = holdFingerprintReads(withFaults(db, (table, calls) => table === 'reviews'
      && calls.some((call) => call.method === 'insert' && (call.args[0] as Record<string, unknown>).author_name === 'First')
      ? { code: '57P01', message: 'synthetic write failure' } : null));
    h.db = hold.client;
    expect(await both()).toEqual([{ ok: false, error: 'actions.couldNotSaveYourReview' }, { ok: true }]);
    expect(hold.arrived()).toBe(2);
    expect(reviews()).toHaveLength(1);
    expect(reviews()[0]).toMatchObject({ author_name: 'Second', title: 'Wonderful', status: 'pending' });
  });

  it('a signed-in member\'s duplicate is never published, not even until it is removed', async () => {
    h.userId = 'user-member';
    // How many reviews were public at each repeat check: both rows are written by then.
    const published: number[] = [];
    db = withTextArbiter((args, store) => {
      published.push(store.table('reviews').filter((row) => row.status === 'approved').length);
      return rateLimitHit(args, store);
    });
    const hold = holdFingerprintReads(db);
    h.db = hold.client;
    expect(await both()).toEqual([{ ok: true }, { ok: true }]);
    expect(reviews()).toHaveLength(1);
    expect(reviews()[0]).toMatchObject({ title: 'Wonderful', status: 'approved' });
    expect(published).toHaveLength(2);
    expect(Math.max(...published), 'the duplicate was on the public wall until it was deleted').toBeLessThanOrEqual(1);
  });

  it('a repeat check that cannot be answered after the insert is reported, the row it could not vouch for is removed, and the retry is written', async () => {
    let down = true;
    db = withTextArbiter((args, store) => {
      if (down) throw new Error('synthetic limiter outage');
      return rateLimitHit(args, store);
    });
    h.db = db;
    expect(await submit(review)).toEqual({ ok: false, error: 'actions.couldNotSaveYourReview' });
    expect(reviews()).toEqual([]);
    down = false;
    expect(await submit(review)).toEqual({ ok: true });
    expect(reviews()).toHaveLength(1);
    expect(reviews()[0]).toMatchObject({ title: 'Wonderful', status: 'pending' });
  });

  it('when that row cannot be removed either, the answer is still the error, the row stays unpublished, and the server log names it', async () => {
    h.userId = 'user-member';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    db = withTextArbiter(() => { throw new Error('synthetic limiter outage'); });
    h.db = withFaults(db, (table, calls) => table === 'reviews' && calls.some((call) => call.method === 'delete')
      ? { code: '57P01', message: 'synthetic delete failure' } : null);
    expect(await submit(review)).toEqual({ ok: false, error: 'actions.couldNotSaveYourReview' });
    expect(reviews()).toHaveLength(1);
    expect(reviews()[0]).toMatchObject({ status: 'pending' });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('[reviews]'), expect.objectContaining({ id: reviews()[0].id }));
  });

  it('a duplicate that cannot be removed is answered as a repeat, stays unpublished, and the server log names it', async () => {
    h.userId = 'user-member';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hold = holdFingerprintReads(withFaults(db, (table, calls) => table === 'reviews' && calls.some((call) => call.method === 'delete')
      ? { code: '57P01', message: 'synthetic delete failure' } : null));
    h.db = hold.client;
    expect(await both()).toEqual([{ ok: true }, { ok: true }]);
    expect(reviews().map((row) => row.status).sort()).toEqual(['approved', 'pending']);
    const leftover = reviews().find((row) => row.status === 'pending');
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('[reviews]'), expect.objectContaining({ id: leftover?.id }));
  });

  it('an auto-approval that cannot be written leaves the review pending, and the server log names it', async () => {
    h.userId = 'user-member';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.db = withFaults(db, (table, calls) => table === 'reviews' && calls.some((call) => call.method === 'update')
      ? { code: '57P01', message: 'synthetic update failure' } : null);
    expect(await submit(review)).toEqual({ ok: true });
    expect(reviews()).toHaveLength(1);
    expect(reviews()[0]).toMatchObject({ status: 'pending' });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('[reviews]'), expect.objectContaining({ id: reviews()[0].id }));
  });
});
