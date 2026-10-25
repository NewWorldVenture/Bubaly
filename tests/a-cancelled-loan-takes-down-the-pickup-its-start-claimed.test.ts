import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * A cancelled loan takes down the pickup its start had already claimed.
 *
 * A rent or a borrow starts at its pickup (startLoanAtPickup in
 * app/(app)/marketplace/handoff/actions.ts), and the pickup is claimed FIRST:
 * 'confirmed' → 'completed', then the order 'confirmed' → 'active'. Between
 * those two writes, and for good after a start whose order write failed, the
 * order is still 'confirmed' with a 'completed' pickup. Cancelling the order
 * then (setOrderStatusAction → cancelOrderPickup) looked only for a proposed or
 * confirmed pickup, so it took nothing down:
 *
 *  - N6-revert-cross-household: between two households the event is on the
 *    CONFIRMER's calendar (AUD-1037). The borrower who confirmed, cancelling in
 *    that window, was left with the pickup on their own calendar; the lender's
 *    take-down runs in the lender's family and cannot reach it.
 *  - N6-revert-failed-start: a start whose order write failed left a
 *    'completed' pickup, and its event, on an order that was later cancelled,
 *    with nothing left that would ever take it down.
 *
 * A sale is not a loan: its pickup and its order complete together in one RPC
 * (marketplace_complete_handoff), so a sale's completed pickup is never taken
 * down by a cancel (and tests/cancelling-an-order-cancels-its-pickup.test.ts
 * keeps one seeded on a still-confirmed order as it was).
 */
const harness = vi.hoisted(() => ({ db: null as unknown, familyId: 'fam-lender', memberId: 'm-lender' }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${harness.memberId}` },
    memberships: [],
    active: { familyId: harness.familyId, role: 'parent', member: { id: harness.memberId, family_id: harness.familyId }, family: { timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  const messages = getMessages('en-US');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params) };
});
const { proposeHandoffAction, confirmHandoffAction, completeHandoffAction } = await import('@/app/(app)/marketplace/handoff/actions');
const { setOrderStatusAction } = await import('@/app/(app)/marketplace/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

type Party = { familyId: string; memberId: string };
const LENDER: Party = { familyId: 'fam-lender', memberId: 'm-lender' };
const BORROWER: Party = { familyId: 'fam-borrower', memberId: 'm-borrower' };
const as = (who: Party) => { harness.familyId = who.familyId; harness.memberId = who.memberId; };
const MEET_AT = '2026-10-24T17:00:00.000Z';
const normalize = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** marketplace_complete_handoff as 0483 wrote it: the pickup and the order complete together. */
function completeRpc(args: Record<string, unknown>, mem: InMemorySupabase) {
  const order = mem.table('marketplace_orders').find((o) => o.id === args.p_order_id);
  if (!order) return { ok: false, reason: 'order_not_found' };
  if (!['confirmed', 'active', 'returned'].includes(String(order.status))) return { ok: false, reason: 'order_not_open' };
  const handoff = mem.table('marketplace_handoffs').find((h) => h.order_id === args.p_order_id);
  if (!handoff || handoff.status !== 'confirmed') return { ok: false, reason: 'handoff_not_ready' };
  if (!normalize(args.p_code) || normalize(args.p_code) !== normalize(handoff.confirm_code)) return { ok: false, reason: 'code_mismatch' };
  Object.assign(handoff, { status: 'completed', completed_at: '2026-10-24T17:05:00.000Z' });
  order.status = 'completed';
  return { ok: true, status: 'completed' };
}

let db: InMemorySupabase;
beforeEach(() => {
  db = createInMemorySupabase({ rpc: { marketplace_complete_handoff: completeRpc }, uniques: { marketplace_handoffs: [['order_id']] } });
  harness.db = db;
  as(LENDER);
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

/**
 * An order whose lender proposed the pickup and whose borrower confirmed it:
 * the borrower holds the code (returned here), the event is on the borrower's
 * calendar, and the lender enters the code at the pickup.
 */
async function arrangedPickup(kind: string, borrower: Party): Promise<string> {
  db.seed('family_members', [
    { id: LENDER.memberId, family_id: LENDER.familyId, display_name: 'Sam', role: 'parent', is_active: true },
    { id: borrower.memberId, family_id: borrower.familyId, display_name: 'Bea', role: 'parent', is_active: true },
  ]);
  db.seed('marketplace_orders', [{
    id: 'order-1', family_id: LENDER.familyId, buyer_family_id: borrower.familyId === LENDER.familyId ? null : borrower.familyId,
    listing_id: 'listing-1', buyer_member: borrower.memberId, seller_member: LENDER.memberId, kind, status: 'confirmed', amount_cents: 0,
  }]);
  db.seed('calendar_events', [
    { id: 'ev-lender-swim', family_id: LENDER.familyId, title: 'Swim practice', starts_at: MEET_AT },
    { id: 'ev-borrower-dentist', family_id: borrower.familyId, title: 'Dentist', starts_at: MEET_AT },
  ]);
  as(LENDER);
  expect(await proposeHandoffAction({ orderId: 'order-1', meetAtIso: MEET_AT, locationLabel: 'Library' })).toEqual({ ok: true });
  as(borrower);
  const confirmed = await confirmHandoffAction('order-1', { meetAt: MEET_AT, locationLabel: 'Library' });
  if (!confirmed.ok || !confirmed.data) throw new Error('the borrower could not confirm the pickup');
  expect(pickupEvents(borrower.familyId)).toHaveLength(1);
  as(LENDER);
  return confirmed.data.code;
}

const order = () => db.table('marketplace_orders')[0];
const handoff = () => db.table('marketplace_handoffs')[0];
const pickupEvents = (familyId?: string) => db.table('calendar_events')
  .filter((e) => String(e.title).startsWith('Marketplace pickup') && (familyId === undefined || e.family_id === familyId));
const otherEvents = () => db.table('calendar_events').filter((e) => !String(e.title).startsWith('Marketplace pickup')).map((e) => e.id);
const logged = (message: string) => vi.mocked(console.error).mock.calls.filter((call) => call[0] === message);

/**
 * Run `who`'s cancel of the order start to finish once `patchMatches` sees the
 * order write it should land before. Answers the cancel's own result.
 */
function cancelBefore(who: Party, patchMatches: (patch: Row) => boolean): () => Promise<unknown> {
  const realFrom = db.from.bind(db);
  let cancel: Promise<unknown> | null = null;
  db.from = ((table: string) => {
    const builder = realFrom(table);
    if (table !== 'marketplace_orders' || cancel) return builder;
    const update = builder.update.bind(builder);
    builder.update = (patch: Row) => {
      if (!cancel && patchMatches(patch)) {
        const back = { familyId: harness.familyId, memberId: harness.memberId };
        cancel = (async () => {
          as(who);
          try { return await setOrderStatusAction('order-1', 'cancelled'); } finally { as(back); }
        })();
        const then = builder.then.bind(builder);
        (builder as { then: typeof builder.then }).then = ((ok, bad) => (cancel as Promise<unknown>).then(() => then(ok, bad))) as typeof builder.then;
      }
      return update(patch);
    };
    return builder;
  }) as typeof db.from;
  return async () => {
    expect(cancel, 'the cancel ran inside the window').not.toBeNull();
    return cancel;
  };
}

describe('a loan between two households, cancelled between the lender\'s claim and the loan start (N6-revert-cross-household)', () => {
  it('by the borrower who confirmed it: their own copy comes off, and nothing is left to log', async () => {
    const code = await arrangedPickup('borrow', BORROWER);
    const cancelled = cancelBefore(BORROWER, (patch) => {
      if (patch.status !== 'active') return false;
      // The lender's claim has landed; the loan has not started.
      expect(handoff().status).toBe('completed');
      return true;
    });

    expect(await completeHandoffAction({ orderId: 'order-1', code })).toEqual({ ok: false, error: t('handoff.pickupChangedRefresh') });
    expect(await cancelled()).toEqual({ ok: true });

    expect(order().status).toBe('cancelled');
    expect(handoff()).toMatchObject({ status: 'cancelled', completed_at: null });
    // AUD-1037: the canceller confirmed it, so the copy is theirs and it goes.
    expect(pickupEvents()).toEqual([]);
    expect(otherEvents()).toEqual(['ev-lender-swim', 'ev-borrower-dentist']);
    // The lender's own take-down then finds the pickup already down, which is
    // the outcome it was after, not a failure.
    expect(console.error).not.toHaveBeenCalled();
  });

  it('by the lender from another tab: the borrower\'s copy is still not the lender\'s to delete, and the miss is logged', async () => {
    const code = await arrangedPickup('borrow', BORROWER);
    const cancelled = cancelBefore(LENDER, (patch) => patch.status === 'active');

    expect(await completeHandoffAction({ orderId: 'order-1', code })).toEqual({ ok: false, error: t('handoff.pickupChangedRefresh') });
    expect(await cancelled()).toEqual({ ok: true });

    expect(handoff()).toMatchObject({ status: 'cancelled', completed_at: null });
    expect(pickupEvents(BORROWER.familyId)).toHaveLength(1);
    expect(otherEvents()).toEqual(['ev-lender-swim', 'ev-borrower-dentist']);
    expect(logged('[marketplace-handoff] the pickup stayed on the family calendar')).toHaveLength(1);
  });

  it('control: the borrower cancelling before the claim ends the same way, and the code then starts nothing', async () => {
    const code = await arrangedPickup('borrow', BORROWER);
    as(BORROWER);
    expect(await setOrderStatusAction('order-1', 'cancelled')).toEqual({ ok: true });
    as(LENDER);

    expect((await completeHandoffAction({ orderId: 'order-1', code })).ok).toBe(false);
    expect(order().status).toBe('cancelled');
    expect(handoff()).toMatchObject({ status: 'cancelled', completed_at: null });
    expect(pickupEvents()).toEqual([]);
  });
});

/** The loan's 'active' write fails in transit, once, after the claim has landed. */
function failTheLoanStart(): () => boolean {
  const realFrom = db.from.bind(db);
  let failed = false;
  db.from = ((table: string) => {
    const builder = realFrom(table);
    if (table !== 'marketplace_orders' || failed) return builder;
    const update = builder.update.bind(builder);
    builder.update = (patch: Row) => {
      if (!failed && patch.status === 'active') {
        failed = true;
        expect(handoff().status).toBe('completed');
        (builder as { then: unknown }).then = ((ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve({ data: null, error: { message: 'TypeError: fetch failed' } }).then(ok, bad));
      }
      return update(patch);
    };
    return builder;
  }) as typeof db.from;
  return () => failed;
}

describe('a loan whose start failed after its claim, then cancelled (N6-revert-failed-start)', () => {
  it.each(['borrow', 'rent'])('a %s within one family: the cancel takes the completed pickup and its event down', async (kind) => {
    const SIBLING: Party = { familyId: LENDER.familyId, memberId: 'm-sibling' };
    const code = await arrangedPickup(kind, SIBLING);
    const failed = failTheLoanStart();

    expect(await completeHandoffAction({ orderId: 'order-1', code })).toEqual({ ok: false, error: t('actions.couldNotCompleteThePickup') });
    expect(failed()).toBe(true);
    // The claim stays: a request that failed in transit may still have landed.
    expect(order().status).toBe('confirmed');
    expect(handoff().status).toBe('completed');
    expect(await completeHandoffAction({ orderId: 'order-1', code })).toEqual({ ok: false, error: t('actions.thisPickupIsNotReady') });

    as(SIBLING);
    expect(await setOrderStatusAction('order-1', 'cancelled')).toEqual({ ok: true });

    expect(order().status).toBe('cancelled');
    expect(handoff()).toMatchObject({ status: 'cancelled', completed_at: null });
    expect(pickupEvents()).toEqual([]);
    expect(otherEvents()).toEqual(['ev-lender-swim', 'ev-borrower-dentist']);
  });

  it('between two households: the borrower who confirmed it cancels, and their copy comes off', async () => {
    const code = await arrangedPickup('borrow', BORROWER);
    failTheLoanStart();
    expect((await completeHandoffAction({ orderId: 'order-1', code })).ok).toBe(false);

    as(BORROWER);
    expect(await setOrderStatusAction('order-1', 'cancelled')).toEqual({ ok: true });

    expect(handoff()).toMatchObject({ status: 'cancelled', completed_at: null });
    expect(pickupEvents()).toEqual([]);
  });
});

describe('a completed sale is never touched (control)', () => {
  it('a sale handed over: the cancel is refused, and the pickup and its event stay as they were', async () => {
    const code = await arrangedPickup('buy', BORROWER);
    expect(await completeHandoffAction({ orderId: 'order-1', code })).toEqual({ ok: true });
    const pickup = { ...handoff() };

    as(BORROWER);
    expect(await setOrderStatusAction('order-1', 'cancelled')).toEqual({ ok: false, error: t('marketplace.orderStepNoLongerAvailable') });

    expect(order().status).toBe('completed');
    expect(handoff()).toEqual(pickup);
    expect(handoff()).toMatchObject({ status: 'completed', completed_at: '2026-10-24T17:05:00.000Z' });
    expect(pickupEvents(BORROWER.familyId)).toHaveLength(1);
  });

  it('a sale\'s RPC landing between the buyer\'s read and the cancel\'s write: the order and its pickup stay completed', async () => {
    const code = await arrangedPickup('buy', BORROWER);
    const realFrom = db.from.bind(db);
    let handedOver: Promise<unknown> | null = null;
    db.from = ((table: string) => {
      const builder = realFrom(table);
      if (table !== 'marketplace_orders' || handedOver) return builder;
      const update = builder.update.bind(builder);
      builder.update = (patch: Row) => {
        if (!handedOver && patch.status === 'cancelled') {
          handedOver = (async () => {
            as(LENDER);
            try { return await completeHandoffAction({ orderId: 'order-1', code }); } finally { as(BORROWER); }
          })();
          const then = builder.then.bind(builder);
          (builder as { then: typeof builder.then }).then = ((ok, bad) => (handedOver as Promise<unknown>).then(() => then(ok, bad))) as typeof builder.then;
        }
        return update(patch);
      };
      return builder;
    }) as typeof db.from;

    as(BORROWER);
    expect(await setOrderStatusAction('order-1', 'cancelled')).toEqual({ ok: false, error: t('actions.orderNotFound') });
    expect(await handedOver).toEqual({ ok: true });

    expect(order().status).toBe('completed');
    expect(handoff()).toMatchObject({ status: 'completed', completed_at: '2026-10-24T17:05:00.000Z' });
    expect(pickupEvents(BORROWER.familyId)).toHaveLength(1);
  });

  it('a sale\'s completed pickup on an order still confirmed is not the cancel\'s either: only a loan\'s start leaves one', async () => {
    await arrangedPickup('buy', BORROWER);
    // The state no real sale reaches (its RPC completes both together), seeded
    // to pin that the take-down is decided by the order's kind.
    Object.assign(handoff(), { status: 'completed', completed_at: '2026-10-24T17:05:00.000Z' });

    as(BORROWER);
    expect(await setOrderStatusAction('order-1', 'cancelled')).toEqual({ ok: true });

    expect(handoff()).toMatchObject({ status: 'completed', completed_at: '2026-10-24T17:05:00.000Z' });
    expect(pickupEvents(BORROWER.familyId)).toHaveLength(1);
  });
});
