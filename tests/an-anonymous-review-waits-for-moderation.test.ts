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
              // Only the initial fingerprint reads enter this barrier. A later
              // real admitted-survivor SELECT must not re-enter or inflate it.
              if (!read || arrived >= expected) return value.bind(object);
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
    h.db = withFaults(db, (table, calls) => table === 'reviews' && calls.some((call) => call.method === 'update' && (call.args[0] as Record<string, unknown>).status === 'approved')
      ? { code: '57P01', message: 'synthetic update failure' } : null);
    expect(await submit(review)).toEqual({ ok: true });
    expect(reviews()).toHaveLength(1);
    expect(reviews()[0]).toMatchObject({ status: 'pending' });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('[reviews]'), expect.objectContaining({ id: reviews()[0].id }));
  });
});

// Independent current-head controls. Only completed fingerprint SELECTs are
// held; write-returning SELECTs added by the repair must never enter this gate.
function completedFingerprintReads(database: Db) {
  let arrivals = 0; let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const snapshots: unknown[] = [];
  const client = new Proxy(database, { get(target, key) {
    if (key !== 'from') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; }
    return (table: string) => {
      const builder = database.from(table); if (table !== 'reviews') return builder;
      const methods: string[] = []; let proxy: typeof builder;
      proxy = new Proxy(builder, { get(object, method) {
        if (method === 'then') return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          const actual = Promise.resolve(object);
          const read = methods.includes('select') && !methods.some(m => ['insert', 'upsert', 'update', 'delete'].includes(m));
          // Retain the first two actual empty snapshots; later survivor reads
          // are real verification work after the initial barrier is released.
          if (!read || arrivals >= 2) return actual.then(resolve, reject);
          return actual.then(async result => { snapshots.push(structuredClone(result)); arrivals++; if (arrivals === 2) release(); await gate; return result; }).then(resolve, reject);
        };
        const value = Reflect.get(object, method); if (typeof value !== 'function') return value;
        return (...args: unknown[]) => { methods.push(String(method)); const result = value.apply(object, args); return result === object ? proxy : result; };
      } }); return proxy;
    };
  } }); return { client, snapshots, arrivals: () => arrivals };
}

it('independent original schedule: two completed empty reads persist only one same-text review', async () => {
  const controlled = completedFingerprintReads(db); h.db = controlled.client;
  const words = { rating: 5, title: 'One synthetic review', body: 'The exact same synthetic words.' };
  expect(await Promise.all([submit({ ...words, name: 'First synthetic person' }), submit({ ...words, name: 'Second synthetic person' })])).toEqual([{ ok: true }, { ok: true }]);
  expect(controlled.arrivals()).toBe(2);
  expect(controlled.snapshots).toEqual([expect.objectContaining({ data: [], error: null }), expect.objectContaining({ data: [], error: null })]);
  console.log('[independent-current-same]', JSON.stringify({ emptyReads: controlled.arrivals(), rows: reviews().length, statuses: reviews().map(r => r.status) }));
  expect(reviews()).toHaveLength(1); expect(reviews()[0].status).toBe('pending');
});

it('independent original healthy control: completed empty reads preserve different text', async () => {
  const controlled = completedFingerprintReads(db); h.db = controlled.client;
  expect(await Promise.all([submit({ rating: 5, title: 'First synthetic text', body: 'One set of words.' }), submit({ rating: 4, title: 'Second synthetic text', body: 'A different set of words.' })])).toEqual([{ ok: true }, { ok: true }]);
  expect(controlled.arrivals()).toBe(2); expect(reviews()).toHaveLength(2);
  expect(new Set(reviews().map(r => JSON.stringify(r.metadata))).size).toBe(2);
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/marketing/admin', () => ({
  requireMarketingAdmin: async () => ({ supabase: db, actorId: 'synthetic-admin', actorEmail: 'admin@example.invalid' }),
  logMarketingAudit: async () => {},
  marketingActionFailure: (_message: string, error: unknown) => { throw error; },
}));
vi.mock('@/lib/marketing/reviews', () => ({ isReviewStatus: (value: string) => ['pending', 'approved', 'rejected'].includes(value) }));

it('independent moderation interleave: unadmitted duplicate rows must not become publicly approved', async () => {
  let arrivals = 0; let release = () => {}; let reached = () => {};
  const allInserted = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  db = withTextArbiter(async (args, store) => { arrivals++; if (arrivals === 2) reached(); await gate; return rateLimitHit(args, store); });
  const controlled = completedFingerprintReads(db); h.db = controlled.client;
  const words = { rating: 5, title: 'One moderation review', body: 'One synthetic set of words.' };
  const submitting = Promise.all([submit({ ...words, name: 'First' }), submit({ ...words, name: 'Second' })]);
  await allInserted;
  expect(controlled.arrivals()).toBe(2);
  expect(controlled.snapshots).toEqual([expect.objectContaining({ data: [], error: null }), expect.objectContaining({ data: [], error: null })]);
  expect(reviews()).toHaveLength(2); expect(reviews().every(r => r.status === 'pending')).toBe(true);
  const { moderateReviewAction } = await import('@/app/(app)/admin/marketing/reviews/actions');
  let moderationRefusals = 0;
  let publishedBeforeAdmission = 0;
  try {
    for (const row of [...reviews()]) {
      try { await moderateReviewAction(String(row.id), 'approved'); }
      catch { moderationRefusals++; }
    }
    publishedBeforeAdmission = reviews().filter(r => r.status === 'approved').length;
  } finally { release(); }
  const replies = await submitting;
  expect(replies).toEqual([{ ok: true }, { ok: true }]);
  console.log('[independent-current-moderation]', JSON.stringify({ beforeAdmission: publishedBeforeAdmission, finalRows: reviews().length, finalStatuses: reviews().map(r => r.status) }));
  expect(reviews()).toHaveLength(1);
  expect.soft(publishedBeforeAdmission, 'no provisional review may become publicly approved before admission').toBe(0);
  expect.soft(moderationRefusals, 'both provisional moderator requests must be truthfully refused').toBe(2);
  // Positive control: admission must not permanently disable real moderation.
  await moderateReviewAction(String(reviews()[0].id), 'approved');
  expect(reviews()[0].status).toBe('approved');
});

// Acceptance differs explicitly from the immutable historical reproduction:
// an all-admission outage cannot require a false successful duplicate receipt.
it('independent insert-admission overlap: no admitted survivor means no successful acknowledgement', async () => {
  let reached = () => {}; let release = () => {}; let reachedSecond = () => {}; let textHits = 0;
  const inserted = new Promise<void>(resolve => { reached = resolve; });
  const secondArbiter = new Promise<void>(resolve => { reachedSecond = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  db = withTextArbiter(async () => {
    textHits++; reached(); if (textHits === 2) reachedSecond();
    await gate; throw new Error('Synthetic durable text-admission outage');
  });
  h.db = db;
  const words = { rating: 5, title: 'One overlap review', body: 'The exact same synthetic overlap words.' };
  const first = submit({ ...words, name: 'First' });
  await inserted;
  expect(reviews()).toHaveLength(1); expect(reviews()[0].status).toBe('pending');
  const second = submit({ ...words, name: 'Second' });
  // Observe B's actual answer OR its real second arbiter arrival; do not hold
  // all callbacks while awaiting an answer that depends on releasing them.
  try { await Promise.race([second.then(() => undefined), secondArbiter]); }
  finally { release(); }
  const replies = await Promise.all([first, second]);
  console.log('[independent-current-overlap-acceptance]', JSON.stringify({ replies, textHits, finalRows: reviews().length }));
  expect.soft(replies.every(reply => reply.ok === false), 'no review was admitted, so neither caller can be told it was received').toBe(true);
  expect(reviews(), 'successful cleanup leaves no provisional row or successful receipt').toHaveLength(0);
});

// A required staging activation is different from optional auto-approval.
it('a refused required activation never acknowledges an invisible review, and a spent counter alone is no retry receipt', async () => {
  h.userId = 'user-member';
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  h.db = observeReviewQueries(db, async (calls, execute) => activatesStage(calls)
    ? { data: null, error: { code: '57P01', message: 'synthetic required activation failure' } }
    : execute());
  const input = { rating: 5, title: 'Held activation', body: 'Synthetic activation acknowledgement control.' };
  const answer = await submit(input);
  expect.soft(answer.ok, 'a required activation was not confirmed').toBe(false);
  expect.soft(reviews().every(row => typeof row.deleted_at === 'string'), 'every surviving staging row must remain hidden').toBe(true);
  expect.soft(reviews().filter(row => row.deleted_at == null), 'no live row can be claimed from a failed activation').toHaveLength(0);
  expect.soft(logged, 'the owned unconfirmed staging outcome must be recorded').toHaveBeenCalled();
  h.db = db;
  const retry = await submit(input);
  // A spent admission counter is not itself evidence of a live review. A
  // future proven recovery may acknowledge only an actual live survivor.
  if (retry.ok) expect(reviews().filter(row => row.deleted_at == null)).toHaveLength(1);
  expect(reviews().filter(row => row.deleted_at == null && ['approved', 'featured'].includes(String(row.status))).length)
    .toBeLessThanOrEqual(retry.ok ? 1 : 0);
});

// Extra lifecycle controls added before product repair. The query observer runs
// actual repository builder effects; it changes only scheduled acknowledgements.
type ObservedCall = { method: string; args: unknown[] };
function observeReviewQueries(database: Db, around: (calls: ObservedCall[], next: () => Promise<unknown>) => Promise<unknown>): Db {
  return new Proxy(database, { get(target, key) {
    if (key !== 'from') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; }
    return (table: string) => {
      const builder = database.from(table); if (table !== 'reviews') return builder;
      const calls: ObservedCall[] = []; let proxy: typeof builder;
      proxy = new Proxy(builder, { get(object, method) {
        if (method === 'then') return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          around(calls, () => Promise.resolve(object)).then(resolve, reject);
        const value = Reflect.get(object, method); if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push({ method: String(method), args });
          // This repository fake executes terminal methods immediately, unlike
          // a thenable Supabase builder. Observe those genuine effects too.
          if (method === 'single' || method === 'maybeSingle') return around(calls, () => Promise.resolve(value.apply(object, args)));
          const result = value.apply(object, args); return result === object ? proxy : result;
        };
      } }); return proxy;
    };
  } });
}
const activatesStage = (calls: ObservedCall[]) => calls.some(call => call.method === 'update' && (call.args[0] as Record<string, unknown>).deleted_at === null);
const isReviewRead = (calls: ObservedCall[]) => calls.some(call => call.method === 'select') && !calls.some(call => ['insert', 'update', 'delete', 'upsert'].includes(call.method));

it('failed cleanup cannot turn an unadmitted staged row into a successful repeat', async () => {
  db = withTextArbiter(() => { throw new Error('Synthetic admission outage with cleanup refusal'); });
  h.db = withFaults(db, (table, calls) => table === 'reviews' && calls.some(call => call.method === 'delete')
    ? { code: '57P01', message: 'synthetic cleanup refusal' } : null);
  const input = { rating: 5, title: 'No staged receipt', body: 'Synthetic cleanup outage.' };
  expect.soft((await submit(input)).ok).toBe(false);
  expect.soft((await submit(input)).ok, 'a surviving provisional row is not an admitted repeat').toBe(false);
  expect(reviews().every(row => typeof row.deleted_at === 'string')).toBe(true);
});

it('a lost activation answer may be confirmed only by the actual live row', async () => {
  let lost = 0;
  h.db = observeReviewQueries(db, async (calls, next) => {
    const result = await next();
    if (activatesStage(calls)) { lost++; return { data: null, error: { code: '57P01', message: 'Synthetic lost activation acknowledgement' } }; }
    return result;
  });
  expect(await submit({ rating: 4, body: 'Synthetic activation answer loss.' })).toEqual({ ok: true });
  expect(lost, 'the actual required activation must have executed before its answer was lost').toBe(1);
  expect(reviews().filter(row => row.deleted_at == null)).toHaveLength(1);
});

it('an unreadable activation witness is uncertain and guarded cleanup cannot delete the admitted row', async () => {
  let lost = 0; let refusedWitnesses = 0;
  h.db = observeReviewQueries(db, async (calls, next) => {
    if (lost && isReviewRead(calls)) { refusedWitnesses++; return { data: null, error: { code: '57P01', message: 'Synthetic witness outage' } }; }
    const result = await next();
    if (activatesStage(calls)) { lost++; return { data: null, error: { code: '57P01', message: 'Synthetic lost activation answer' } }; }
    return result;
  });
  expect.soft((await submit({ rating: 4, body: 'Synthetic unreadable activation witness.' })).ok).toBe(false);
  expect.soft(lost).toBe(1); expect.soft(refusedWitnesses).toBeGreaterThanOrEqual(1);
  expect(reviews().filter(row => row.deleted_at == null), 'cleanup must not erase a successfully activated row after an ambiguous answer').toHaveLength(1);
});

it('activation and cleanup refuse a changed hold instead of taking over or removing it', async () => {
  let changed = 0;
  h.db = observeReviewQueries(db, async (calls, next) => {
    if (activatesStage(calls)) {
      changed++;
      const row = reviews()[0];
      row.metadata = { ...(row.metadata as Record<string, unknown>), submission_admission: 'v1:staged:other-owner' };
    }
    return next();
  });
  expect.soft((await submit({ rating: 4, body: 'Synthetic competing stage ownership.' })).ok).toBe(false);
  expect.soft(changed).toBe(1);
  expect(reviews()).toHaveLength(1);
  expect.soft(reviews()[0].metadata).toMatchObject({ submission_admission: 'v1:staged:other-owner' });
  expect(typeof reviews()[0].deleted_at).toBe('string');
});

it('cleanup never deletes an admitted row when the admission answer arrives unavailable', async () => {
  db = withTextArbiter((_args, store) => {
    const row = store.table('reviews')[0];
    row.deleted_at = null;
    row.metadata = { ...(row.metadata as Record<string, unknown>), submission_admission: 'v1:admitted' };
    throw new Error('Synthetic unavailable answer after external admitted state');
  });
  h.db = db;
  expect.soft((await submit({ rating: 4, body: 'Synthetic admitted ownership cleanup guard.' })).ok).toBe(false);
  expect(reviews(), 'a conditional provisional cleanup must preserve admitted state').toHaveLength(1);
  expect(reviews()[0].deleted_at).toBeNull();
});

it('a hidden stage cannot receive an admin reply but its admitted survivor can', async () => {
  let reached = () => {}; let release = () => {};
  const staged = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  db = withTextArbiter(async (args, store) => { reached(); await gate; return rateLimitHit(args, store); });
  h.db = db;
  const submitting = submit({ rating: 4, body: 'Synthetic reply admission control.' });
  await staged;
  const { replyToReviewAction } = await import('@/app/(app)/admin/marketing/reviews/actions');
  const input = new FormData(); input.set('id', String(reviews()[0].id)); input.set('reply', 'Synthetic moderator reply');
  let refused = false;
  try { await replyToReviewAction(input); } catch { refused = true; } finally { release(); }
  expect.soft(refused, 'admin reply to a hidden provisional row must be refused').toBe(true);
  expect(await submitting).toEqual({ ok: true });
  await replyToReviewAction(input);
  expect(reviews()[0].reply).toBe('Synthetic moderator reply');
});

it('equivalent PostgREST timestamp spelling still confirms this exact owned staging hold', async () => {
  let alternateEchoes = 0;
  h.db = observeReviewQueries(db, async (calls, next) => {
    const result = await next() as { data: Record<string, unknown>[] | null; error: unknown };
    if (calls.some(call => call.method === 'insert') && Array.isArray(result.data)) {
      alternateEchoes++;
      return { ...result, data: result.data.map(row => ({ ...row,
        deleted_at: typeof row.deleted_at === 'string' ? row.deleted_at.replace(/Z$/, '+00:00') : row.deleted_at,
      })) };
    }
    return result;
  });
  expect.soft((await submit({ rating: 4, body: 'Synthetic native timestamp serialization control.' })).ok).toBe(true);
  expect(alternateEchoes, 'the actual inserted hold echo was reformatted without changing its instant').toBe(1);
  expect(reviews().filter(row => row.deleted_at == null)).toHaveLength(1);
});
