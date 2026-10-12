// A family may email its referral code at most ten times a day
// (REFERRAL_EMAIL_POLICY). Each send is a timestamp on the invited address's
// referrals row, and the limit is counted from those timestamps.
//
// THE DEFECT (owner's finding 6127838006 on #1022): `recordReferralEmailInvite`
// read the family's sends, decided from that read, and then wrote one send on
// one row. The compare-and-set protects that one row and nothing else. With
// nine sends recorded, two invitations to different addresses started together
// both read nine. Both wrote, to different rows, and both answered `ok: true`.
// The family ended the day with eleven sends, and two emails went out.
//
// THE FIX: write first, then decide, then send the email. Each request writes
// its own send and then reads every send the family has in the window.
//
// - It is admitted only if that read shows at most ten sends, its own
//   included. This is what keeps the family at ten, and it needs no lock,
//   clock or order. An admitted send is never withdrawn. Suppose eleven
//   sends were admitted. Take the one whose write landed last: its read came
//   after all eleven writes, so it saw eleven and would have refused.
// - When the read shows more than ten, the request decides which send gives
//   way. Every request ranks the family's sends in the same total order: send
//   time, then row id, then position on the row. The order is total, and
//   each request's read includes its own send, so racers that see each other
//   agree on who is past ten. A request ranked past ten removes its own send,
//   and only its own (its row by id, or its stamp on a reused row), and
//   answers throttled. A request ranked within ten reads again, a bounded
//   number of times, and is admitted once the other send is gone. So of two
//   requests at nine, the earlier one gets through.
// - A send can rank before an admitted one and still be written after it
//   (a request whose clock is behind). The count check then refuses it,
//   because the admitted send never leaves. If a rollback fails, it is
//   logged and that request still answers throttled. Either way the family
//   can end up with fewer than ten emails, but never more than ten.
//
// The races below run against the repository's in-memory database double. A
// proxy holds each request after its first read until the test lets it go.
// That forces "both read nine, then both write", which is the owner's
// reproduction, and the skewed and failed-rollback orders as well.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';
import {
  DEFAULT_REFERRAL_CONFIG, REFERRAL_EMAIL_POLICY, REFERRAL_EMAIL_SOURCE, decideReferralEmailAdmission, referralEmailSendTimes,
} from '@/lib/referrals/core';

type DB = SupabaseClient<Database>;

const FAMILY = '11111111-1111-4111-8111-111111111111';
const OTHER_FAMILY = '44444444-4444-4444-8444-444444444444';
const CODE = 'SYNTH-7K4Q';
const OTHER_CODE = 'OTHER-AB12';
const T0 = new Date('2026-10-12T12:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

const db = createInMemorySupabase({
  uniques: { referrals: [['referred_family_id']] },
  defaults: {
    referrals: { status: 'signed_up', source: null, referred_family_id: null, referred_email: null, referrer_reward_cents: 0, referred_reward_cents: 0, converted_at: null, rewarded_at: null, metadata: {} },
  },
});
const client = db as unknown as DB;

// The action test below goes through createServiceClient; each call hands out
// whatever the test chose, by default the plain database.
const services = vi.hoisted(() => ({ next: null as null | (() => unknown) }));
const mail = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => (services.next ? services.next() : client),
  createServer: async () => client,
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

/** A gate that opens once `n` requests have arrived at it. */
function barrier(n: number) {
  let arrived = 0;
  const open = deferred();
  return async () => { arrived += 1; if (arrived >= n) open.resolve(); await open.promise; };
}

type Row = Record<string, unknown>;

/**
 * The same database, seen by one request. Its FIRST read of `referrals` is
 * taken at once (the snapshot it decides from) and then held in `afterFirstRead`
 * before the request may go on to write. `mapRead` reshapes the n-th read's
 * rows (1-based): reversing them, say, since Postgres guarantees no row order
 * without ORDER BY. `stats.reads` counts the request's reads of `referrals`.
 */
function oneRequest(service: DB, opts: {
  afterFirstRead?: () => Promise<void>;
  mapRead?: (rows: Row[], readNumber: number) => Row[];
  stats?: { reads: number };
} = {}): DB {
  let held = false;
  let reads = 0;
  return new Proxy(service, {
    get(target, key, receiver) {
      if (key !== 'from') return Reflect.get(target, key, receiver);
      return (table: string) => {
        const builder = target.from(table as never) as unknown as object;
        if (table !== 'referrals') return builder;
        let firstMethod: string | null = null;
        const wrapped: object = new Proxy(builder, {
          get(object, method) {
            const value = Reflect.get(object, method, object);
            if (typeof value !== 'function') return value;
            if (method === 'then') {
              return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
                // Calling the double's `then` executes the query now.
                const reply = Reflect.apply(value, object, [(r: unknown) => r]) as Promise<{ data: unknown }>;
                const isRead = firstMethod === 'select';
                const readNumber = isRead ? ++reads : 0;
                if (isRead && opts.stats) opts.stats.reads = reads;
                return reply.then(async (r) => {
                  if (isRead && opts.mapRead && Array.isArray(r.data)) r = { ...r, data: opts.mapRead(r.data as Row[], readNumber) };
                  if (isRead && !held) { held = true; await opts.afterFirstRead?.(); }
                  return r;
                }).then(resolve, reject);
              };
            }
            return (...args: unknown[]) => {
              if (firstMethod === null) firstMethod = String(method);
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

function seedSends(familyId: string, code: string, count: number, base: Date = T0) {
  db.seed('referrals', Array.from({ length: count }, (_, i) => ({
    code, referrer_family_id: familyId, referred_email: `seeded-${familyId.slice(0, 4)}-${i + 1}@example.invalid`,
    status: 'pending', source: REFERRAL_EMAIL_SOURCE,
    metadata: { email_sent_at: [new Date(base.getTime() - (i + 1) * 60_000).toISOString()] },
  })));
}

function sendsOf(familyId: string): number {
  return db.table('referrals')
    .filter((row) => row.referrer_family_id === familyId)
    .reduce((n, row) => n + referralEmailSendTimes(row.metadata).length, 0);
}

function rowFor(email: string) {
  return db.table('referrals').find((row) => row.referred_email === email);
}

const invite = (service: DB, email: string, now: Date, familyId = FAMILY, code = CODE) =>
  recordReferralEmailInvite(service, { referrerFamilyId: familyId, code, email, config: DEFAULT_REFERRAL_CONFIG, now });

beforeEach(() => {
  db.reset();
  services.next = null;
  mail.sent.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('two referral emails at once stay within the daily limit', () => {
  it('with nine sends recorded, two invitations to different addresses started together: one is sent, ten in all', async () => {
    seedSends(FAMILY, CODE, 9);
    const bothRead = barrier(2);
    const [first, second] = await Promise.all([
      invite(oneRequest(client, { afterFirstRead: bothRead }), 'first@example.invalid', at(0)),
      invite(oneRequest(client, { afterFirstRead: bothRead }), 'second@example.invalid', at(1_000)),
    ]);
    expect(sendsOf(FAMILY)).toBe(REFERRAL_EMAIL_POLICY.limit);
    // The earlier send ranks first and goes; the later one gives way.
    expect(first).toMatchObject({ ok: true, created: true, remaining: 0 });
    expect(second).toMatchObject({ ok: false, reason: 'throttled' });
    expect((second as { retryAfterSec: number }).retryAfterSec).toBeGreaterThan(0);
    expect(rowFor('first@example.invalid')).toBeDefined();
    expect(rowFor('second@example.invalid'), 'the refused request removes its own row').toBeUndefined();
  });

  it('two sends stamped at the same instant, each read in its own row order, are told apart at once', async () => {
    seedSends(FAMILY, CODE, 9);
    const bothRead = barrier(2);
    const stats = [{ reads: 0 }, { reads: 0 }];
    const outcomes = await Promise.all([
      invite(oneRequest(client, { afterFirstRead: bothRead, stats: stats[0] }), 'first@example.invalid', at(0)),
      invite(oneRequest(client, { afterFirstRead: bothRead, stats: stats[1], mapRead: (rows) => [...rows].reverse() }), 'second@example.invalid', at(0)),
    ]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    // The row id breaks the tie: one gives way on its first look, the other is
    // admitted on its next. Neither sits out the whole re-check budget.
    for (const s of stats) expect(s.reads).toBeLessThanOrEqual(3);
    expect(outcomes.filter((o) => !o.ok)).toEqual([expect.objectContaining({ ok: false, reason: 'throttled' })]);
    expect(sendsOf(FAMILY)).toBe(REFERRAL_EMAIL_POLICY.limit);
    expect(['first@example.invalid', 'second@example.invalid'].filter((e) => rowFor(e))).toHaveLength(1);
  });

  it('a repeat send to a recorded address racing a new address: one is sent, and the refused repeat keeps the earlier stamp', async () => {
    seedSends(FAMILY, CODE, 9);
    const repeated = 'seeded-1111-1@example.invalid';
    const before = referralEmailSendTimes(rowFor(repeated)?.metadata);
    const bothRead = barrier(2);
    const [fresh, repeat] = await Promise.all([
      invite(oneRequest(client, { afterFirstRead: bothRead }), 'fresh@example.invalid', at(0)),
      invite(oneRequest(client, { afterFirstRead: bothRead }), repeated, at(1_000)),
    ]);
    expect(fresh).toMatchObject({ ok: true, created: true, remaining: 0 });
    expect(repeat).toMatchObject({ ok: false, reason: 'throttled' });
    expect(sendsOf(FAMILY)).toBe(REFERRAL_EMAIL_POLICY.limit);
    expect(referralEmailSendTimes(rowFor(repeated)?.metadata), 'only the refused stamp is removed').toEqual(before);
  });

  it('three at once with eight recorded: the two earliest are sent', async () => {
    seedSends(FAMILY, CODE, 8);
    const allRead = barrier(3);
    const outcomes = await Promise.all(['a', 'b', 'c'].map((name, i) =>
      invite(oneRequest(client, { afterFirstRead: allRead }), `${name}@example.invalid`, at(i * 1_000))));
    expect(outcomes.map((o) => o.ok)).toEqual([true, true, false]);
    expect(sendsOf(FAMILY)).toBe(REFERRAL_EMAIL_POLICY.limit);
  });

  it('a request whose clock is behind, writing after another was admitted, is refused rather than sent as the eleventh', async () => {
    seedSends(FAMILY, CODE, 9);
    const laterDone = deferred();
    // The earlier-stamped request reads nine, then waits until the other has finished entirely.
    const behind = invite(oneRequest(client, { afterFirstRead: () => laterDone.promise }), 'behind@example.invalid', at(0));
    const ahead = await invite(client, 'ahead@example.invalid', at(5_000));
    laterDone.resolve();
    expect(ahead).toMatchObject({ ok: true, created: true, remaining: 0 });
    expect(await behind).toMatchObject({ ok: false, reason: 'throttled' });
    expect(sendsOf(FAMILY)).toBe(REFERRAL_EMAIL_POLICY.limit);
    expect(rowFor('behind@example.invalid')).toBeUndefined();
  });

  it('a refused request whose rollback fails logs it and is not sent; nothing is admitted past ten', async () => {
    seedSends(FAMILY, CODE, 9);
    const bothRead = barrier(2);
    const failingDelete = withFaults(client, (table, calls) =>
      table === 'referrals' && calls.some((c) => c.method === 'delete') ? { message: 'synthetic delete failure' } : null);
    const outcomes = await Promise.all([
      invite(oneRequest(client, { afterFirstRead: bothRead }), 'first@example.invalid', at(0)),
      invite(oneRequest(failingDelete, { afterFirstRead: bothRead }), 'second@example.invalid', at(1_000)),
    ]);
    expect(outcomes[1]).toMatchObject({ ok: false, reason: 'throttled' });
    expect(console.error).toHaveBeenCalledWith('[referrals/email] invite rollback delete failed', expect.any(Object));
    // The stuck row still counts, so the other request cannot be the eleventh either.
    expect(outcomes.filter((o) => o.ok)).toHaveLength(0);
    expect(sendsOf(FAMILY)).toBeLessThanOrEqual(REFERRAL_EMAIL_POLICY.limit);
  });

  it('a failed read after the write withdraws the send and answers read_failed', async () => {
    seedSends(FAMILY, CODE, 3);
    let selects = 0;
    const secondReadFails = withFaults(client, (table, calls) => {
      if (table !== 'referrals' || calls[0]?.method !== 'select') return null;
      selects += 1;
      return selects === 2 ? { message: 'synthetic read failure' } : null;
    });
    expect(await invite(secondReadFails, 'first@example.invalid', at(0))).toEqual({ ok: false, reason: 'read_failed' });
    expect(console.error).toHaveBeenCalledWith('[referrals/email] referral admission read failed', expect.any(Object));
    expect(rowFor('first@example.invalid')).toBeUndefined();
    expect(sendsOf(FAMILY)).toBe(3);
  });

  it('a send that is gone by the time it is checked is not reported as sent', async () => {
    seedSends(FAMILY, CODE, 3);
    const seeded = new Set(db.table('referrals').map((row) => row.id));
    const service = oneRequest(client, { mapRead: (rows, n) => (n === 2 ? rows.filter((row) => seeded.has(row.id)) : rows) });
    expect(await invite(service, 'first@example.invalid', at(0))).toEqual({ ok: false, reason: 'write_failed' });
    expect(console.error).toHaveBeenCalledWith('[referrals/email] referral send missing after write', expect.any(Object));
  });

  it('below the limit, two at once are both sent', async () => {
    seedSends(FAMILY, CODE, 5);
    const bothRead = barrier(2);
    const outcomes = await Promise.all([
      invite(oneRequest(client, { afterFirstRead: bothRead }), 'first@example.invalid', at(0)),
      invite(oneRequest(client, { afterFirstRead: bothRead }), 'second@example.invalid', at(1_000)),
    ]);
    expect(outcomes).toEqual([
      expect.objectContaining({ ok: true, created: true }),
      expect.objectContaining({ ok: true, created: true }),
    ]);
    expect(sendsOf(FAMILY)).toBe(7);
  });

  it('sequential control: after nine, the tenth is sent and the eleventh is throttled before anything is written', async () => {
    seedSends(FAMILY, CODE, 9);
    expect(await invite(client, 'first@example.invalid', at(0))).toMatchObject({ ok: true, created: true, remaining: 0 });
    expect(await invite(client, 'second@example.invalid', at(1_000))).toMatchObject({ ok: false, reason: 'throttled' });
    expect(sendsOf(FAMILY)).toBe(REFERRAL_EMAIL_POLICY.limit);
    expect(rowFor('second@example.invalid')).toBeUndefined();
  });

  it('another family racing alongside keeps its own allowance', async () => {
    seedSends(FAMILY, CODE, 9);
    seedSends(OTHER_FAMILY, OTHER_CODE, 9);
    const allRead = barrier(3);
    const [first, second, other] = await Promise.all([
      invite(oneRequest(client, { afterFirstRead: allRead }), 'first@example.invalid', at(0)),
      invite(oneRequest(client, { afterFirstRead: allRead }), 'second@example.invalid', at(1_000)),
      invite(oneRequest(client, { afterFirstRead: allRead }), 'other@example.invalid', at(2_000), OTHER_FAMILY, OTHER_CODE),
    ]);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: false, reason: 'throttled' });
    expect(other).toMatchObject({ ok: true, created: true, remaining: 0 });
    expect(sendsOf(FAMILY)).toBe(REFERRAL_EMAIL_POLICY.limit);
    expect(sendsOf(OTHER_FAMILY)).toBe(REFERRAL_EMAIL_POLICY.limit);
  });
});

describe('decideReferralEmailAdmission (pure)', () => {
  const sent = (rowId: string, ...isos: string[]) => ({ id: rowId, metadata: { email_sent_at: isos } });
  const nine = Array.from({ length: 9 }, (_, i) => sent(`seed-${i}`, at(-(i + 1) * 60_000).toISOString()));
  const stamp = at(0).toISOString();

  it('admits up to the limit, own send included, with what is left', () => {
    expect(decideReferralEmailAdmission([...nine, sent('mine', stamp)], { rowId: 'mine', sentAt: at(0) }))
      .toEqual({ verdict: 'admit', used: 10, remaining: 0 });
  });

  it('over the limit, the send ranked tenth waits and the one ranked eleventh backs off, whatever the row order', () => {
    const rows = [...nine, sent('row-b', stamp), sent('row-a', stamp)];
    for (const order of [rows, [...rows].reverse()]) {
      expect(decideReferralEmailAdmission(order, { rowId: 'row-a', sentAt: at(0) })).toMatchObject({ verdict: 'wait', used: 11 });
      expect(decideReferralEmailAdmission(order, { rowId: 'row-b', sentAt: at(0) })).toMatchObject({ verdict: 'back_off', used: 11 });
    }
    const later = [...nine, sent('row-a', at(1_000).toISOString()), sent('row-b', stamp)];
    expect(decideReferralEmailAdmission(later, { rowId: 'row-b', sentAt: at(0) }), 'send time comes before row id').toMatchObject({ verdict: 'wait' });
  });

  it('counts a send dated after its own, and forgets sends older than the window', () => {
    const ahead = [...nine.slice(1), sent('ahead', at(5_000).toISOString()), sent('mine', stamp)];
    expect(decideReferralEmailAdmission(ahead, { rowId: 'mine', sentAt: at(0) })).toMatchObject({ verdict: 'admit', used: 10 });
    expect(decideReferralEmailAdmission([...ahead, sent('ahead-2', at(6_000).toISOString())], { rowId: 'mine', sentAt: at(0) }))
      .toMatchObject({ verdict: 'wait', used: 11 });
    const old = sent('old', at(-REFERRAL_EMAIL_POLICY.windowMs).toISOString());
    expect(decideReferralEmailAdmission([...nine, old, sent('mine', stamp)], { rowId: 'mine', sentAt: at(0) }))
      .toMatchObject({ verdict: 'admit', used: 10 });
  });

  it('a send missing from its row is reported, not admitted', () => {
    expect(decideReferralEmailAdmission([...nine, sent('mine', at(-1).toISOString())], { rowId: 'mine', sentAt: at(0) }))
      .toEqual({ verdict: 'missing' });
  });
});

describe('the referral email action sends only what was admitted', () => {
  it('two "Email an invite" submissions at once, with nine sent today: one email goes out', async () => {
    const now = new Date();
    seedSends(FAMILY, CODE, 9, now);
    db.seed('referral_codes', [{ family_id: FAMILY, code: CODE, created_by: null }]);
    const bothRead = barrier(2);
    services.next = () => oneRequest(client, { afterFirstRead: bothRead });
    const { sendReferralEmailAction } = await import('@/app/(app)/referrals/actions');
    const outcomes = await Promise.all([
      sendReferralEmailAction('first@example.invalid'),
      sendReferralEmailAction('second@example.invalid'),
    ]);
    expect(mail.sent).toHaveLength(1);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toEqual([{ ok: false, reason: 'referralActions.dailyEmailLimitReached' }]);
    expect(sendsOf(FAMILY)).toBe(REFERRAL_EMAIL_POLICY.limit);
  });
});
