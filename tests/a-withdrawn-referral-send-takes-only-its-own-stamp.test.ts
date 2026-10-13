// The referral email daily limit (REFERRAL_EMAIL_POLICY: ten a day) is
// counted from the send timestamps on the family's referrals rows. A send is
// written first and admitted afterwards, from a read taken after the write
// (tests/two-referral-emails-at-once-stay-within-the-daily-limit.test.ts).
// Owner coordinator finding AUD-1037-REFERRAL-BUDGET names two ways that
// count could still fall below the emails that actually went.
//
// 1. A withdrawn send took other requests' sends with it. A request whose
//    admission read failed, or which ranked past ten, rolled back its fresh
//    row with a delete by id and status alone. A repeat invitation to the same
//    address could have appended its own send to that row in between, been
//    admitted and been emailed; the delete removed that send from the count.
//    On a reused row the rollback removed EVERY timestamp equal to its own, so
//    a second send stamped in the same millisecond lost its reservation too.
//    Either way the family could be emailed an eleventh time.
//    Now a fresh row is deleted only while it still holds exactly what its
//    insert wrote, and otherwise ONE copy of the request's own stamp is
//    removed, under the row's full-metadata compare-and-set. A rollback that
//    cannot be done safely leaves the send counted.
//
// 2. Both reads were single unpaged selects. PostgREST answers one with at
//    most db-max-rows rows and no error, so a family with enough old
//    invitations had its recent sends cut from the read. Both reads now page
//    by id, until a page holds every row its `count` says is left, and a
//    failed page fails the read.
//
// Everything runs against the repository's in-memory database double; a
// proxy holds one request at a chosen query so the interleavings are exact.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import {
  DEFAULT_REFERRAL_CONFIG, REFERRAL_EMAIL_POLICY, REFERRAL_EMAIL_SOURCE, referralEmailSendTimes,
} from '@/lib/referrals/core';

type DB = SupabaseClient<Database>;

const FAMILY = '11111111-1111-4111-8111-111111111111';
const CODE = 'SYNTH-7K4Q';
const T0 = new Date('2026-10-12T12:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const HOUR = 60 * 60_000;

const makeDb = (maxRows?: number) => createInMemorySupabase({
  maxRows,
  uniques: { referrals: [['referred_family_id']] },
  defaults: {
    referrals: { status: 'signed_up', source: null, referred_family_id: null, referred_email: null, referrer_reward_cents: 0, referred_reward_cents: 0, converted_at: null, rewarded_at: null, metadata: {} },
  },
});

const holder = vi.hoisted(() => ({ db: null as unknown }));
const mail = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => holder.db,
  createServer: async () => holder.db,
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/emails/referral', () => ({ ReferralEmail: () => null }));
vi.mock('@/lib/email', () => ({
  APP_URL: 'https://example.invalid',
  sendReactEmail: async ({ to }: { to: string }) => { mail.sent.push(to); return { ok: true }; },
}));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'synthetic-user', email: 'parent@example.invalid' },
    active: { familyId: FAMILY, member: { display_name: 'Synthetic Parent' }, family: { name: 'Synthetic' } },
  }),
}));

const { recordReferralEmailInvite } = await import('@/lib/referrals/server');

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

type Reply = { data: unknown; error: unknown; count?: number | null };
/** One query as the proxy sees it: its table, what it does, its 1-based number among this request's queries of that kind on that table, and every builder call made. */
type Call = { table: string; kind: 'read' | 'insert' | 'update' | 'delete' | 'upsert'; n: number; methods: string[] };

/**
 * The same database, seen by one request. `before` runs before a query
 * executes (so holding it holds the query), `after` once it has executed and
 * before the request sees the reply, and `fail` answers chosen queries with an
 * error instead of running them.
 */
function hooked(service: DB, hooks: {
  before?: (call: Call) => Promise<void> | void;
  after?: (call: Call, reply: Reply) => Promise<void> | void;
  fail?: (call: Call) => { message: string } | null;
}): DB {
  const counts = new Map<string, number>();
  return new Proxy(service, {
    get(target, key, receiver) {
      if (key !== 'from') return Reflect.get(target, key, receiver);
      return (table: string) => {
        const builder = target.from(table as never) as unknown as object;
        const methods: string[] = [];
        const run = async (execute: () => PromiseLike<Reply>): Promise<Reply> => {
          const first = methods[0];
          const kind: Call['kind'] = first === 'insert' || first === 'update' || first === 'delete' || first === 'upsert' ? first : 'read';
          const n = (counts.get(`${table}:${kind}`) ?? 0) + 1;
          counts.set(`${table}:${kind}`, n);
          const call = { table, kind, n, methods: [...methods] };
          await hooks.before?.(call);
          const failure = hooks.fail?.(call);
          const reply = failure ? { data: null, count: null, error: { code: 'XX000', details: null, hint: null, ...failure } } : await execute();
          await hooks.after?.(call, reply);
          return reply;
        };
        const wrapped: object = new Proxy(builder, {
          get(object, method) {
            const value = Reflect.get(object, method, object);
            if (typeof value !== 'function') return value;
            if (method === 'then') {
              return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
                run(() => Reflect.apply(value, object, [(r: Reply) => r]) as PromiseLike<Reply>).then(resolve, reject);
            }
            if (method === 'maybeSingle' || method === 'single') {
              return (...args: unknown[]) => run(() => Reflect.apply(value, object, args) as PromiseLike<Reply>);
            }
            return (...args: unknown[]) => {
              methods.push(String(method));
              const result = Reflect.apply(value, object, args);
              return result === object ? wrapped : result;
            };
          },
        });
        return wrapped;
      };
    },
  }) as DB;
}

let db: InMemorySupabase;
let client: DB;
function useDb(maxRows?: number) {
  db = makeDb(maxRows);
  client = db as unknown as DB;
  holder.db = client;
}

/** Ids that sort in the order rows are seeded, so a capped page is predictable. */
let seq = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

/** `count` invitations, each with one send `minutesAgo` (1, 2, … by default) before T0. */
function seedSends(count: number, opts: { prefix?: string; ageMs?: (i: number) => number } = {}) {
  const prefix = opts.prefix ?? 'seeded';
  const age = opts.ageMs ?? ((i: number) => (i + 1) * 60_000);
  db.seed('referrals', Array.from({ length: count }, (_, i) => ({
    id: nextId(), code: CODE, referrer_family_id: FAMILY, referred_email: `${prefix}-${i + 1}@example.invalid`,
    status: 'pending', source: REFERRAL_EMAIL_SOURCE,
    metadata: { email_sent_at: [new Date(T0.getTime() - age(i)).toISOString()] },
  })));
}

function sendsOf(): number {
  return db.table('referrals')
    .filter((row) => row.referrer_family_id === FAMILY)
    .reduce((n, row) => n + referralEmailSendTimes(row.metadata).length, 0);
}

const rowFor = (email: string) => db.table('referrals').find((row) => row.referred_email === email);
const stampsOf = (email: string) => referralEmailSendTimes(rowFor(email)?.metadata);

const invite = (service: DB, email: string, now: Date) =>
  recordReferralEmailInvite(service, { referrerFamilyId: FAMILY, code: CODE, email, config: DEFAULT_REFERRAL_CONFIG, now });

const FRIEND = 'friend@example.invalid';
const isReferrals = (call: Call) => call.table === 'referrals';

beforeEach(() => {
  seq = 0;
  useDb();
  mail.sent.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a withdrawn send takes only its own stamp', () => {
  it('a fresh row whose admission read fails keeps the send a repeat to the same address added at the same instant', async () => {
    seedSends(8);
    const written = deferred();
    const go = deferred();
    // A writes its fresh row and is held there; its admission read (its second read) then fails.
    const first = invite(hooked(client, {
      after: async (call) => { if (isReferrals(call) && call.kind === 'insert') { written.resolve(); await go.promise; } },
      fail: (call) => (isReferrals(call) && call.kind === 'read' && call.n === 2 ? { message: 'synthetic admission read failure' } : null),
    }), FRIEND, at(0));
    await written.promise;

    // B repeats the address at the same instant: it appends to A's row, is admitted at ten, and its email goes.
    const repeat = await invite(client, FRIEND, at(0));
    expect(repeat).toMatchObject({ ok: true, created: false, remaining: 0 });
    expect(stampsOf(FRIEND)).toEqual([at(0).toISOString(), at(0).toISOString()]);

    go.resolve();
    expect(await first).toEqual({ ok: false, reason: 'read_failed' });

    // A's own stamp is gone and B's is still counted: eight earlier sends plus B's email.
    expect(stampsOf(FRIEND)).toEqual([at(0).toISOString()]);
    expect(sendsOf()).toBe(9);
    // So one more email fits today, and then the family is at its limit: ten emails, not eleven.
    expect(await invite(client, 'later-1@example.invalid', at(2_000))).toMatchObject({ ok: true, remaining: 0 });
    expect(await invite(client, 'later-2@example.invalid', at(3_000))).toMatchObject({ ok: false, reason: 'throttled' });
    expect(sendsOf()).toBe(REFERRAL_EMAIL_POLICY.limit);
  });

  it('a repeat that lands between the failed admission read and the cleanup is kept', async () => {
    seedSends(8);
    const cleaning = deferred();
    const go = deferred();
    const first = invite(hooked(client, {
      before: async (call) => { if (isReferrals(call) && call.kind === 'delete') { cleaning.resolve(); await go.promise; } },
      fail: (call) => (isReferrals(call) && call.kind === 'read' && call.n === 2 ? { message: 'synthetic admission read failure' } : null),
    }), FRIEND, at(0));
    await cleaning.promise;

    expect(await invite(client, FRIEND, at(500))).toMatchObject({ ok: true, created: false, remaining: 0 });

    go.resolve();
    expect(await first).toEqual({ ok: false, reason: 'read_failed' });
    expect(stampsOf(FRIEND)).toEqual([at(500).toISOString()]);
    expect(sendsOf()).toBe(9);
  });

  it('a reused row keeps the other copy of a timestamp two sends share', async () => {
    seedSends(8);
    const repeated = 'seeded-1@example.invalid';
    const [earlier] = stampsOf(repeated);
    const written = deferred();
    const go = deferred();
    const first = invite(hooked(client, {
      after: async (call) => { if (isReferrals(call) && call.kind === 'update' && call.n === 1) { written.resolve(); await go.promise; } },
      fail: (call) => (isReferrals(call) && call.kind === 'read' && call.n === 2 ? { message: 'synthetic admission read failure' } : null),
    }), repeated, at(0));
    await written.promise;

    expect(await invite(client, repeated, at(0))).toMatchObject({ ok: true, created: false, remaining: 0 });
    expect(stampsOf(repeated)).toEqual([earlier, at(0).toISOString(), at(0).toISOString()]);

    go.resolve();
    expect(await first).toEqual({ ok: false, reason: 'read_failed' });
    // One copy is A's and goes; the other is the admitted repeat's and stays.
    expect(stampsOf(repeated)).toEqual([earlier, at(0).toISOString()]);
    expect(sendsOf()).toBe(9);
  });

  it('a fresh row ranked past ten withdraws only its own send, and the admitted repeat on it still counts', async () => {
    seedSends(8);
    const cRead = deferred(); const cGo = deferred(); const cChecked = deferred();
    const aWritten = deferred(); const aGo = deferred();
    // C reads eight and waits to write.
    const c = invite(hooked(client, {
      after: async (call) => {
        if (!isReferrals(call) || call.kind !== 'read') return;
        if (call.n === 1) { cRead.resolve(); await cGo.promise; }
        if (call.n === 2) cChecked.resolve();
      },
    }), 'c@example.invalid', at(0));
    await cRead.promise;
    // A writes a fresh row for FRIEND and waits before its admission read.
    const a = invite(hooked(client, {
      after: async (call) => { if (isReferrals(call) && call.kind === 'insert') { aWritten.resolve(); await aGo.promise; } },
    }), FRIEND, at(2_000));
    await aWritten.promise;
    // B repeats FRIEND at the same instant, reads nine, appends, reads ten and is admitted: its email goes.
    expect(await invite(client, FRIEND, at(2_000))).toMatchObject({ ok: true, created: false, remaining: 0 });
    // C writes and reads eleven. It ranks ninth, so it waits for a send ranked past ten to withdraw.
    cGo.resolve();
    await cChecked.promise;
    // A reads eleven and ranks eleventh: it backs off.
    aGo.resolve();
    expect(await a).toMatchObject({ ok: false, reason: 'throttled' });
    // C is admitted once A's own send is gone, and B's still counts.
    expect(await c).toMatchObject({ ok: true, created: true, remaining: 0 });
    expect(stampsOf(FRIEND)).toEqual([at(2_000).toISOString()]);
    // Eight earlier sends, B and C: ten emails went, and ten are recorded.
    expect(sendsOf()).toBe(REFERRAL_EMAIL_POLICY.limit);
    expect(await invite(client, 'later@example.invalid', at(5_000))).toMatchObject({ ok: false, reason: 'throttled' });
  });

  it('control: a cleanup whose compare-and-set loses to a newer send leaves its stamp counted, and logs it', async () => {
    seedSends(8);
    const repeated = 'seeded-2@example.invalid';
    const [earlier] = stampsOf(repeated);
    const readForCleanup = deferred();
    const go = deferred();
    const first = invite(hooked(client, {
      after: async (call) => { if (isReferrals(call) && call.kind === 'read' && call.n === 3) { readForCleanup.resolve(); await go.promise; } },
      fail: (call) => (isReferrals(call) && call.kind === 'read' && call.n === 2 ? { message: 'synthetic admission read failure' } : null),
    }), repeated, at(0));
    await readForCleanup.promise;
    expect(await invite(client, repeated, at(0))).toMatchObject({ ok: true, created: false, remaining: 0 });

    go.resolve();
    expect(await first).toEqual({ ok: false, reason: 'read_failed' });
    expect(console.error).toHaveBeenCalledWith('[referrals/email] invite rollback update failed', expect.any(Object));
    // The uncertain send stays counted: fewer emails than ten may go, never more.
    expect(stampsOf(repeated)).toEqual([earlier, at(0).toISOString(), at(0).toISOString()]);
    expect(await invite(client, 'later@example.invalid', at(5_000))).toMatchObject({ ok: false, reason: 'throttled' });
  });

  it('control: a withdrawn fresh row nobody else wrote to is deleted outright', async () => {
    seedSends(3);
    const failing = hooked(client, {
      fail: (call) => (isReferrals(call) && call.kind === 'read' && call.n === 2 ? { message: 'synthetic admission read failure' } : null),
    });
    expect(await invite(failing, FRIEND, at(0))).toEqual({ ok: false, reason: 'read_failed' });
    expect(rowFor(FRIEND)).toBeUndefined();
    expect(sendsOf()).toBe(3);
  });
});

describe('the limit is counted from every row, not the first page of them', () => {
  /**
   * `old` invitations whose sends left the window days ago, then `target`
   * (an old address that will be invited again), then ten sends today. With a
   * cap of five rows per response, one unpaged read sees only the old rows
   * and the target.
   */
  function oldRowsThenTenToday(old = 4) {
    seedSends(old, { prefix: 'old', ageMs: (i) => (72 + i) * HOUR });
    seedSends(1, { prefix: 'target', ageMs: () => 96 * HOUR });
    seedSends(10, { prefix: 'today' });
  }
  const TARGET = 'target-1@example.invalid';

  it('a repeat to an old address is throttled before anything is written when ten went today', async () => {
    useDb(5);
    oldRowsThenTenToday();
    const writes: string[] = [];
    const service = hooked(client, { before: (call) => { if (call.kind !== 'read') writes.push(call.kind); } });

    expect(await invite(service, TARGET, at(0))).toMatchObject({ ok: false, reason: 'throttled' });
    expect(writes).toEqual([]);
    expect(stampsOf(TARGET)).toHaveLength(1);
    expect(sendsOf()).toBe(15);
  });

  it('the "Email an invite" action sends no eleventh email from behind a capped page', async () => {
    // The action stamps its send with the clock.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    useDb(5);
    oldRowsThenTenToday();
    db.seed('referral_codes', [{ family_id: FAMILY, code: CODE, created_by: null }]);
    const { sendReferralEmailAction } = await import('@/app/(app)/referrals/actions');

    expect(await sendReferralEmailAction(TARGET)).toEqual({ ok: false, reason: 'referralActions.dailyEmailLimitReached' });
    expect(mail.sent).toEqual([]);
  });

  it('a later page that fails fails the read, and nothing is written', async () => {
    useDb(5);
    oldRowsThenTenToday();
    const writes: string[] = [];
    const service = hooked(client, {
      before: (call) => { if (call.kind !== 'read') writes.push(call.kind); },
      fail: (call) => (isReferrals(call) && call.kind === 'read' && call.methods.includes('gt') ? { message: 'synthetic page failure' } : null),
    });

    expect(await invite(service, TARGET, at(0))).toEqual({ ok: false, reason: 'read_failed' });
    expect(writes).toEqual([]);
  });

  it('an admission read whose later page fails withdraws the send and answers read_failed', async () => {
    useDb(5);
    seedSends(6);
    let continuations = 0;
    const service = hooked(client, {
      fail: (call) => {
        if (!isReferrals(call) || call.kind !== 'read' || !call.methods.includes('gt')) return null;
        continuations += 1;
        // The first continuation finishes the limit check; the second is the admission read's.
        return continuations === 2 ? { message: 'synthetic page failure' } : null;
      },
    });

    expect(await invite(service, FRIEND, at(0))).toEqual({ ok: false, reason: 'read_failed' });
    expect(console.error).toHaveBeenCalledWith('[referrals/email] referral admission read failed', expect.any(Object));
    expect(rowFor(FRIEND)).toBeUndefined();
    expect(sendsOf()).toBe(6);
  });

  it('a row deleted behind the cursor while the family is paged does not hide a later send', async () => {
    useDb(5);
    // Four old invitations, then ten today: the first page is the four old rows and one of today's.
    seedSends(4, { prefix: 'old', ageMs: (i) => (72 + i) * HOUR });
    seedSends(10, { prefix: 'today' });
    const writes: string[] = [];
    const service = hooked(client, {
      before: (call) => { if (call.kind !== 'read') writes.push(call.kind); },
      after: (call) => {
        // Between the first page and the next, an old invitation on the first page is deleted.
        if (isReferrals(call) && call.kind === 'read' && call.n === 1) {
          db.replace('referrals', db.table('referrals').filter((row) => row.referred_email !== 'old-1@example.invalid'));
        }
      },
    });

    // Paged by offset, the next page would start one row late and miss one of today's ten.
    expect(await invite(service, FRIEND, at(0))).toMatchObject({ ok: false, reason: 'throttled' });
    expect(writes).toEqual([]);
  });

  it('control: below the limit, a family larger than one page still sends, and counts every row', async () => {
    useDb(5);
    seedSends(4, { prefix: 'old', ageMs: (i) => (72 + i) * HOUR });
    seedSends(8, { prefix: 'today' });

    expect(await invite(client, FRIEND, at(0))).toMatchObject({ ok: true, created: true, remaining: 1 });
    expect(await invite(client, 'second@example.invalid', at(1_000))).toMatchObject({ ok: true, created: true, remaining: 0 });
    expect(await invite(client, 'third@example.invalid', at(2_000))).toMatchObject({ ok: false, reason: 'throttled' });
  });
});
