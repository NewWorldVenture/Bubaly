import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { renderTranslated } from './helpers/render-translated';

/**
 * The hand-off code is one party's to share, a loan starts at its pickup, and
 * a confirm agrees to the proposal its screen showed.
 *
 * N2 / N11. Confirming a pickup mints the hand-off code. The Orders page sent
 * it to BOTH parties and rendered the "enter code to complete" box for both,
 * and completeHandoffAction accepted either party, so either one alone
 * "completed in person" — a borrower read the code off their own screen,
 * typed it, and closed the loan (and its overdue reminders) with the item
 * still in hand. Now the confirmer alone holds the code (it is returned to
 * them and shown to them alone) and the proposer alone enters it.
 *
 * N6. marketplace_complete_handoff (0483) writes the order 'completed' for
 * every kind, so a rent or a borrow was recorded as over the moment it was
 * picked up: no "Mark returned" for the lender, no return reminders. The app
 * no longer sends a loan's pickup there: the code moves it to 'active'. An
 * order cancelled between the pickup's claim and the loan's start takes the
 * pickup and its calendar event down (N6-revert): put back to 'confirmed', it
 * was a live code and a calendar event on an order that is off.
 *
 * N9. A reschedule rewrites the time and place and leaves the pickup
 * 'proposed', so a confirm claimed on status alone agreed to whatever was
 * stored — a time the confirmer never saw, and in the race window one that
 * disagreed with the calendar event it had just made.
 *
 * The Orders page part also holds N5/N13 (the review form is not offered to a
 * buyer from another household, whose review the database refuses), N7 (a
 * loan's amount is its rate, not a charge) and N20 (the seller's "Bubaly
 * takes" is the service fee the buyer is told about, not that fee less a card
 * fee nobody is charged).
 */
const harness = vi.hoisted(() => ({ db: null as unknown, memberId: 'm-seller', familyId: 'fam-1', role: 'parent', rpcCalls: [] as string[] }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => undefined, error: () => undefined }) }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${harness.memberId}` },
    memberships: [],
    active: { familyId: harness.familyId, role: harness.role, member: { id: harness.memberId, family_id: harness.familyId }, family: { timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  const messages = getMessages('en-US');
  return {
    getLocaleContext: async () => ({ locale: localeOrDefault('en-US'), source: 'default', messages }),
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params),
  };
});

const { proposeHandoffAction, confirmHandoffAction, completeHandoffAction } = await import('@/app/(app)/marketplace/handoff/actions');
const { setOrderStatusAction, leaveReviewAction } = await import('@/app/(app)/marketplace/actions');
const { default: OrdersPage } = await import('@/app/(app)/marketplace/orders/page');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);

const CODE = 'K7Q4MZ';
const MEET_AT = '2026-10-24T17:00:00.000Z';
const LATER = '2026-10-25T09:00:00.000Z';
const normalize = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** marketplace_complete_handoff as 0483 left it: either party, the stored code, and 'completed' for every kind. */
function completeRpc(args: Record<string, unknown>, mem: InMemorySupabase) {
  harness.rpcCalls.push('marketplace_complete_handoff');
  const order = mem.table('marketplace_orders').find((o) => o.id === args.p_order_id);
  if (!order) return { ok: false, reason: 'order_not_found' };
  if (order.buyer_member !== harness.memberId && order.seller_member !== harness.memberId) return { ok: false, reason: 'forbidden' };
  if (!['confirmed', 'active', 'returned'].includes(String(order.status))) return { ok: false, reason: 'order_not_open' };
  const handoff = mem.table('marketplace_handoffs').find((h) => h.order_id === args.p_order_id);
  if (!handoff) return { ok: false, reason: 'handoff_not_found' };
  if (handoff.status !== 'confirmed') return { ok: false, reason: 'handoff_not_ready' };
  if (!normalize(args.p_code) || normalize(args.p_code) !== normalize(handoff.confirm_code)) return { ok: false, reason: 'code_mismatch' };
  handoff.status = 'completed';
  order.status = 'completed';
  return { ok: true, status: 'completed' };
}

let db: InMemorySupabase;
function seed(order: Row, handoff: Row | null) {
  db.seed('family_members', [
    { id: 'm-seller', family_id: 'fam-1', display_name: 'Sam', role: 'parent', is_active: true },
    { id: 'm-buyer', family_id: 'fam-1', display_name: 'Bea', role: 'adult', is_active: true },
  ]);
  db.seed('marketplace_orders', [{
    id: 'order-1', family_id: 'fam-1', listing_id: 'listing-1', buyer_member: 'm-buyer', seller_member: 'm-seller',
    kind: 'buy', status: 'confirmed', amount_cents: 2_000, ends_on: null, returned_at: null, created_at: '2026-10-20T10:00:00Z', ...order,
  }]);
  db.seed('marketplace_listings', [{ id: 'listing-1', family_id: 'fam-1', member_id: 'm-seller', title: 'Ladder', rent_period: 'day' }]);
  if (handoff) {
    db.seed('marketplace_handoffs', [{
      id: 'handoff-1', order_id: 'order-1', family_id: 'fam-1', listing_id: 'listing-1',
      proposed_by: 'm-seller', proposer_role: 'seller', status: 'confirmed', meet_at: MEET_AT, location_label: 'Library',
      location_kind: 'public_spot', confirm_code: CODE, calendar_event_id: null, notes: null, ...handoff,
    }]);
  }
}
const as = (memberId: string) => { harness.memberId = memberId; };
const order = () => db.table('marketplace_orders')[0];
const handoff = () => db.table('marketplace_handoffs')[0];

beforeEach(() => {
  db = createInMemorySupabase({ rpc: { marketplace_complete_handoff: completeRpc }, uniques: { marketplace_handoffs: [['order_id']] } });
  harness.db = db;
  harness.memberId = 'm-seller';
  harness.familyId = 'fam-1';
  harness.role = 'parent';
  harness.rpcCalls = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('the hand-off code is entered by the party who did not confirm (N2, N11)', () => {
  it('the buyer who confirmed the seller\'s proposal holds the code and cannot complete with it', async () => {
    seed({}, { proposer_role: 'seller' });
    as('m-buyer');
    expect(await completeHandoffAction({ orderId: 'order-1', code: CODE })).toEqual({ ok: false, error: t('handoff.theOtherPersonEntersTheCode') });
    expect(order().status).toBe('confirmed');
    expect(handoff().status).toBe('confirmed');
    expect(harness.rpcCalls).toEqual([]);
  });

  it('the seller who proposed completes the sale with the code the buyer gives them', async () => {
    seed({}, { proposer_role: 'seller' });
    as('m-seller');
    expect(await completeHandoffAction({ orderId: 'order-1', code: CODE.toLowerCase() })).toEqual({ ok: true });
    expect(order().status).toBe('completed');
    expect(harness.rpcCalls).toEqual(['marketplace_complete_handoff']);
  });

  it('the other way round when the buyer proposed: the seller holds the code, the buyer enters it', async () => {
    seed({}, { proposer_role: 'buyer', proposed_by: 'm-buyer' });
    as('m-seller');
    expect(await completeHandoffAction({ orderId: 'order-1', code: CODE })).toEqual({ ok: false, error: t('handoff.theOtherPersonEntersTheCode') });
    expect(order().status).toBe('confirmed');
    as('m-buyer');
    expect(await completeHandoffAction({ orderId: 'order-1', code: CODE })).toEqual({ ok: true });
    expect(order().status).toBe('completed');
  });

  it('a pickup not yet confirmed has no code to enter', async () => {
    seed({}, { status: 'proposed', confirm_code: null });
    as('m-seller');
    expect(await completeHandoffAction({ orderId: 'order-1', code: CODE })).toEqual({ ok: false, error: t('actions.thisPickupIsNotReady') });
  });
});

describe('a rent or a borrow starts at its pickup (N6)', () => {
  it('the lender enters the borrower\'s code: the loan is active, not completed, and the RPC is not called', async () => {
    seed({ kind: 'borrow' }, { proposer_role: 'seller' });
    as('m-buyer');
    // The borrower holds the code: they cannot close (or start) the loan alone.
    expect((await completeHandoffAction({ orderId: 'order-1', code: CODE })).ok).toBe(false);
    expect(order().status).toBe('confirmed');

    as('m-seller');
    expect(await completeHandoffAction({ orderId: 'order-1', code: CODE })).toEqual({ ok: true, data: { loanStarted: true } });
    expect(order().status).toBe('active');
    expect(handoff()).toMatchObject({ status: 'completed' });
    expect(harness.rpcCalls).toEqual([]);

    // The return is still the lender's to record.
    expect(await setOrderStatusAction('order-1', 'returned')).toEqual({ ok: true });
    expect(order().status).toBe('returned');
  });

  it('a rent the borrower proposed: the lender holds the code and the borrower enters it at pickup', async () => {
    seed({ kind: 'rent' }, { proposer_role: 'buyer', proposed_by: 'm-buyer' });
    as('m-buyer');
    expect(await completeHandoffAction({ orderId: 'order-1', code: CODE })).toEqual({ ok: true, data: { loanStarted: true } });
    expect(order().status).toBe('active');
  });

  it('a wrong code changes nothing', async () => {
    seed({ kind: 'borrow' }, { proposer_role: 'seller' });
    as('m-seller');
    expect(await completeHandoffAction({ orderId: 'order-1', code: 'WRONG1' })).toEqual({ ok: false, error: t('actions.thatCodeDoesnTMatch') });
    expect(order().status).toBe('confirmed');
    expect(handoff().status).toBe('confirmed');
  });

  it('a pickup cancelled between the read and the claim leaves the loan unstarted', async () => {
    seed({ kind: 'borrow' }, { proposer_role: 'seller' });
    as('m-seller');
    const realFrom = db.from.bind(db);
    db.from = ((table: string) => {
      const builder = realFrom(table);
      if (table === 'marketplace_handoffs') {
        const update = builder.update.bind(builder);
        builder.update = (patch: Row) => { handoff().status = 'cancelled'; return update(patch); };
      }
      return builder;
    }) as typeof db.from;

    expect(await completeHandoffAction({ orderId: 'order-1', code: CODE })).toEqual({ ok: false, error: t('handoff.pickupChangedRefresh') });
    expect(order().status).toBe('confirmed');
    expect(handoff().status).toBe('cancelled');
  });

  it('two submits of the code racing leave the loan started, not put back to confirmed', async () => {
    seed({ kind: 'borrow' }, { proposer_role: 'seller' });
    as('m-seller');
    // Submit A has read the order and the pickup and is about to claim the
    // pickup when submit B (the same lender, a second tab) runs start to finish.
    const realFrom = db.from.bind(db);
    let second: Promise<unknown> | null = null;
    db.from = ((table: string) => {
      const builder = realFrom(table);
      if (table === 'marketplace_handoffs' && !second) {
        const update = builder.update.bind(builder);
        builder.update = (patch: Row) => {
          if (!second) {
            second = completeHandoffAction({ orderId: 'order-1', code: CODE });
            const then = builder.then.bind(builder);
            (builder as { then: typeof builder.then }).then = ((ok, bad) => (second as Promise<unknown>).then(() => then(ok, bad))) as typeof builder.then;
          }
          return update(patch);
        };
      }
      return builder;
    }) as typeof db.from;

    const first = await completeHandoffAction({ orderId: 'order-1', code: CODE });
    const other = await second;

    // One of the two started the loan; the other was told the pickup moved on.
    expect([first, other]).toContainEqual({ ok: true, data: { loanStarted: true } });
    expect(order().status).toBe('active');
    expect(handoff().status).toBe('completed');
  });

  it('a loan cancelled after its pickup was claimed takes the pickup down, and starts nothing', async () => {
    seed({ kind: 'borrow' }, { proposer_role: 'seller', completed_at: null, calendar_event_id: 'ev-1' });
    db.seed('calendar_events', [{ id: 'ev-1', family_id: 'fam-1', title: 'Marketplace pickup · Library', starts_at: MEET_AT }]);
    as('m-seller');
    const realFrom = db.from.bind(db);
    db.from = ((table: string) => {
      const builder = realFrom(table);
      if (table === 'marketplace_orders') {
        const update = builder.update.bind(builder);
        builder.update = (patch: Row) => { order().status = 'cancelled'; return update(patch); };
      }
      return builder;
    }) as typeof db.from;

    expect(await completeHandoffAction({ orderId: 'order-1', code: CODE })).toEqual({ ok: false, error: t('handoff.pickupChangedRefresh') });
    expect(order().status).toBe('cancelled');
    // Not put back to 'confirmed': a live code and a calendar event on an order that is off.
    expect(handoff()).toMatchObject({ status: 'cancelled', completed_at: null });
    expect(db.table('calendar_events')).toEqual([]);
  });

  it('the borrower cancelling between the lender\'s claim and the loan start leaves no live pickup and no calendar event', async () => {
    seed({ kind: 'borrow' }, { proposer_role: 'seller', completed_at: null, calendar_event_id: 'ev-1' });
    db.seed('calendar_events', [
      { id: 'ev-1', family_id: 'fam-1', title: 'Marketplace pickup · Library', starts_at: MEET_AT },
      { id: 'ev-dentist', family_id: 'fam-1', title: 'Dentist', starts_at: LATER },
    ]);
    // The lender has claimed the pickup and is about to start the order when
    // the borrower's own Cancel runs start to finish. Its cancelOrderPickup
    // finds the pickup already 'completed', so it takes nothing down.
    const realFrom = db.from.bind(db);
    let cancel: Promise<unknown> | null = null;
    db.from = ((table: string) => {
      const builder = realFrom(table);
      if (table === 'marketplace_orders' && !cancel) {
        const update = builder.update.bind(builder);
        builder.update = (patch: Row) => {
          if (!cancel && patch.status === 'active') {
            expect(handoff().status).toBe('completed');
            cancel = (async () => {
              as('m-buyer');
              try { return await setOrderStatusAction('order-1', 'cancelled'); } finally { as('m-seller'); }
            })();
            const then = builder.then.bind(builder);
            (builder as { then: typeof builder.then }).then = ((ok, bad) => (cancel as Promise<unknown>).then(() => then(ok, bad))) as typeof builder.then;
          }
          return update(patch);
        };
      }
      return builder;
    }) as typeof db.from;

    as('m-seller');
    expect(await completeHandoffAction({ orderId: 'order-1', code: CODE })).toEqual({ ok: false, error: t('handoff.pickupChangedRefresh') });
    expect(await cancel).toEqual({ ok: true });
    expect(order().status).toBe('cancelled');
    expect(handoff()).toMatchObject({ status: 'cancelled', completed_at: null });
    // The pickup's own event is gone; the family's others are not touched.
    expect(db.table('calendar_events').map((e) => e.id)).toEqual(['ev-dentist']);
  });
});

describe('a confirm agrees to the proposal its screen showed (N9)', () => {
  beforeEach(() => {
    seed({}, { status: 'proposed', confirm_code: null, proposer_role: 'seller', meet_at: LATER, location_label: 'Police station' });
    as('m-buyer');
  });

  it('refuses a proposal rescheduled since the screen showed it', async () => {
    // The screen showed Saturday at the library; the seller has since moved it.
    expect(await confirmHandoffAction('order-1', { meetAt: MEET_AT, locationLabel: 'Library' }))
      .toEqual({ ok: false, error: t('handoff.pickupChangedRefresh') });
    expect(handoff()).toMatchObject({ status: 'proposed', confirm_code: null, meet_at: LATER });
    expect(db.table('calendar_events')).toEqual([]);
  });

  it('confirms the proposal it showed, however the timestamp is spelled', async () => {
    const res = await confirmHandoffAction('order-1', { meetAt: '2026-10-25T09:00:00+00:00', locationLabel: 'Police station' });
    expect(res.ok).toBe(true);
    expect(handoff()).toMatchObject({ status: 'confirmed', meet_at: LATER });
    expect(db.table('calendar_events')).toMatchObject([{ starts_at: LATER, location: 'Police station' }]);
  });

  it('a reschedule landing between the read and the claim is not confirmed under the old time\'s event', async () => {
    const realFrom = db.from.bind(db);
    db.from = ((table: string) => {
      const builder = realFrom(table);
      if (table === 'calendar_events') {
        const insert = builder.insert.bind(builder);
        builder.insert = (rows: Row | Row[]) => {
          Object.assign(handoff(), { meet_at: MEET_AT, location_label: 'Mall food court' });
          return insert(rows);
        };
      }
      return builder;
    }) as typeof db.from;

    const res = await confirmHandoffAction('order-1', { meetAt: LATER, locationLabel: 'Police station' });

    expect(res.ok).toBe(false);
    expect(handoff()).toMatchObject({ status: 'proposed', confirm_code: null, meet_at: MEET_AT, location_label: 'Mall food court' });
    // The event made from the superseded time is taken back.
    expect(db.table('calendar_events')).toEqual([]);
  });
});

/** The Orders page as `memberId` reads it. */
async function ordersPage(memberId: string): Promise<string> {
  as(memberId);
  return renderTranslated(await OrdersPage()).replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
}

describe('the Orders page shows the code to its holder and the box to the other party', () => {
  it('a sale: the confirming buyer reads the code; the proposing seller gets the box, and never the code', async () => {
    seed({}, { proposer_role: 'seller' });

    const buyer = await ordersPage('m-buyer');
    expect(buyer).toContain(CODE);
    expect(buyer).not.toContain(t('handoff.enterCodeToComplete'));

    const seller = await ordersPage('m-seller');
    expect(seller).not.toContain(CODE);
    expect(seller).toContain(t('handoff.enterCodeToComplete'));
    expect(seller).toContain(`> ${t('handoff.complete')}</button>`);
  });

  it('a loan: the box confirms the pickup, and after it the lender still marks it returned', async () => {
    seed({ kind: 'borrow', amount_cents: 0 }, { proposer_role: 'seller' });
    expect(await ordersPage('m-seller')).toContain(`> ${t('handoff.confirmPickup')}</button>`);

    Object.assign(order(), { status: 'active' });
    Object.assign(handoff(), { status: 'completed' });
    const lender = await ordersPage('m-seller');
    expect(lender).toContain('Mark returned');
    expect(lender).not.toContain(t('orderControls.leaveAReview'));
  });
});

describe('a loan\'s amount is its rate, not a charge (N7)', () => {
  it('a rent order reads "$5/day", with no "You pay" or "You receive"', async () => {
    seed({ kind: 'rent', amount_cents: 500 }, null);
    db.seed('stripe_settings', [{ id: 'singleton', enabled: true, service_fee_cents: 90 }]);
    for (const member of ['m-buyer', 'm-seller']) {
      const html = await ordersPage(member);
      expect(html, member).toContain('$5/day');
      expect(html, member).not.toContain(t('orders.youPay'));
      expect(html, member).not.toContain(t('orders.youReceive'));
    }
  });
});

describe('both sides of a sale read the same service fee (N20)', () => {
  it('a $20 sale with the 90¢ fee: the buyer pays $20.90 and the seller is told Bubaly takes $0.90', async () => {
    seed({ amount_cents: 2_000 }, null);
    db.seed('stripe_settings', [{ id: 'singleton', enabled: true, service_fee_cents: 90 }]);
    expect(await ordersPage('m-buyer')).toContain(`${t('orders.youPay')} <span class="font-semibold text-brand-text">$20.90</span>`);
    const seller = await ordersPage('m-seller');
    expect(seller).toContain(t('orders.bubalyTakes', { amount: '$0.90' }));
    expect(seller).toContain(`${t('orders.youReceive')} <span class="font-semibold text-emerald-600 dark:text-emerald-400">$20</span>`);
  });
});

describe('a review is offered only where the database will take it (N5, N13)', () => {
  const crossFamily = () => {
    // Won from another household: the SELLER's family_id, the buyer's household as buyer_family_id.
    seed({ status: 'completed', family_id: 'fam-seller', buyer_family_id: 'fam-1' }, null);
  };

  it('the buyer from another household is not offered the form, and the action says why instead of failing', async () => {
    crossFamily();
    const html = await ordersPage('m-buyer');
    expect(html).toContain('Ladder');
    expect(html).not.toContain(t('orderControls.leaveAReview'));

    expect(await leaveReviewAction({ orderId: 'order-1', rating: 5 }))
      .toEqual({ ok: false, error: t('marketplace.reviewsAcrossHouseholdsAreNotOpenYet') });
    expect(db.table('marketplace_reviews')).toEqual([]);
  });

  it('a party in the order\'s own family is offered it, and the review is filed under the order\'s family', async () => {
    seed({ status: 'completed' }, null);
    expect(await ordersPage('m-buyer')).toContain(t('orderControls.leaveAReview'));
    expect(await leaveReviewAction({ orderId: 'order-1', rating: 4 })).toEqual({ ok: true });
    expect(db.table('marketplace_reviews')).toMatchObject([{ family_id: 'fam-1', reviewer_member: 'm-buyer', reviewee_member: 'm-seller', role: 'buyer', rating: 4 }]);
  });
});

describe('an existing proposal can still be rescheduled and confirmed end to end', () => {
  it('propose → confirm (holder gets the code) → the proposer completes', async () => {
    seed({}, null);
    as('m-seller');
    expect(await proposeHandoffAction({ orderId: 'order-1', meetAtIso: MEET_AT, locationLabel: 'Library' })).toEqual({ ok: true });
    as('m-buyer');
    const confirmed = await confirmHandoffAction('order-1', { meetAt: MEET_AT, locationLabel: 'Library' });
    expect(confirmed.ok).toBe(true);
    const code = confirmed.ok ? confirmed.data?.code : undefined;
    expect(code).toBe(handoff().confirm_code);
    as('m-seller');
    expect(await completeHandoffAction({ orderId: 'order-1', code: String(code) })).toEqual({ ok: true });
    expect(order().status).toBe('completed');
  });
});
