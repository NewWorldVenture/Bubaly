import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * Cancelling a marketplace order cancels its pickup.
 *
 * `setOrderStatusAction` moved the order to `cancelled` and nothing else. A
 * confirmed pickup for it stayed `confirmed`, with its event on the family
 * calendar, so the family kept being reminded of an exchange that was off
 * (lib/server/notifications.ts reads every event in the next 48 hours). The
 * Orders page hides the pickup panel once the order is cancelled, so nobody
 * could take it down from the app afterwards.
 */
const harness = vi.hoisted(() => ({ db: null as unknown, memberId: 'member-b' }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${harness.memberId}` },
    memberships: [],
    active: { familyId: 'family-1', role: 'parent', member: { id: harness.memberId, family_id: 'family-1' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
const { setOrderStatusAction } = await import('@/app/(app)/marketplace/actions');

const MEET_AT = '2026-10-12T15:00:00.000Z';

describe('cancelling a marketplace order', () => {
  let db: InMemorySupabase;
  beforeEach(() => {
    db = createInMemorySupabase();
    harness.db = db;
    harness.memberId = 'member-b';
    db.seed('marketplace_orders', [{
      id: 'order-1', family_id: 'family-1', listing_id: 'listing-1',
      buyer_member: 'member-b', seller_member: 'member-s', kind: 'buy', status: 'confirmed',
    }]);
    db.seed('calendar_events', [
      { id: 'event-pickup', family_id: 'family-1', title: 'Marketplace pickup · Library', starts_at: MEET_AT },
      { id: 'event-other', family_id: 'family-1', title: 'Swim practice', starts_at: MEET_AT },
    ]);
  });

  function seedPickup(status: string, calendarEventId: string | null) {
    db.seed('marketplace_handoffs', [{
      id: 'handoff-1', order_id: 'order-1', family_id: 'family-1', listing_id: 'listing-1',
      proposed_by: 'member-s', proposer_role: 'seller', status, location_label: 'Library',
      meet_at: MEET_AT, confirm_code: status === 'confirmed' ? 'K7Q4' : null, calendar_event_id: calendarEventId,
    }]);
  }

  const eventIds = () => db.table('calendar_events').map((e) => e.id);

  it('cancels its confirmed pickup and takes it off the family calendar', async () => {
    seedPickup('confirmed', 'event-pickup');

    expect(await setOrderStatusAction('order-1', 'cancelled')).toEqual({ ok: true });

    expect(db.table('marketplace_orders')[0]).toMatchObject({ status: 'cancelled' });
    expect(db.table('marketplace_handoffs')[0]).toMatchObject({ status: 'cancelled' });
    expect(eventIds()).toEqual(['event-other']);
  });

  it('cancels a pickup that was only proposed', async () => {
    seedPickup('proposed', null);

    expect(await setOrderStatusAction('order-1', 'cancelled')).toEqual({ ok: true });

    expect(db.table('marketplace_handoffs')[0]).toMatchObject({ status: 'cancelled' });
    expect(eventIds()).toEqual(['event-pickup', 'event-other']);
  });

  it('leaves the pickup alone on any other step', async () => {
    seedPickup('confirmed', 'event-pickup');

    expect(await setOrderStatusAction('order-1', 'active')).toEqual({ ok: true });

    expect(db.table('marketplace_handoffs')[0]).toMatchObject({ status: 'confirmed', confirm_code: 'K7Q4' });
    expect(eventIds()).toEqual(['event-pickup', 'event-other']);
  });

  it('leaves the pickup alone when the order did not move', async () => {
    seedPickup('confirmed', 'event-pickup');
    // The other party started the exchange between this read and its claim.
    const realFrom = db.from.bind(db);
    db.from = ((table: string) => {
      const builder = realFrom(table);
      if (table !== 'marketplace_orders') return builder;
      const update = builder.update.bind(builder);
      builder.update = (patch) => {
        db.table('marketplace_orders')[0].status = 'active';
        return update(patch);
      };
      return builder;
    }) as typeof db.from;

    const res = await setOrderStatusAction('order-1', 'cancelled');

    expect(res.ok).toBe(false);
    expect(db.table('marketplace_handoffs')[0]).toMatchObject({ status: 'confirmed' });
    expect(eventIds()).toEqual(['event-pickup', 'event-other']);
  });

  it('only touches the pickup of the order it cancelled', async () => {
    seedPickup('confirmed', 'event-pickup');
    db.seed('marketplace_handoffs', [{
      id: 'handoff-2', order_id: 'order-2', family_id: 'family-1', listing_id: 'listing-2',
      proposed_by: 'member-s', proposer_role: 'seller', status: 'confirmed', location_label: 'Park',
      meet_at: MEET_AT, confirm_code: 'Z9X8', calendar_event_id: 'event-other',
    }]);

    expect(await setOrderStatusAction('order-1', 'cancelled')).toEqual({ ok: true });

    expect(db.table('marketplace_handoffs').find((h) => h.id === 'handoff-2')).toMatchObject({ status: 'confirmed' });
    expect(eventIds()).toEqual(['event-other']);
  });

  it('keeps a pickup that already happened as it was', async () => {
    seedPickup('completed', 'event-pickup');

    expect(await setOrderStatusAction('order-1', 'cancelled')).toEqual({ ok: true });

    expect(db.table('marketplace_handoffs')[0]).toMatchObject({ status: 'completed' });
    expect(eventIds()).toEqual(['event-pickup', 'event-other']);
  });

  it('still reports the cancelled order when its pickup cannot be cancelled', async () => {
    seedPickup('confirmed', 'event-pickup');
    const realFrom = db.from.bind(db);
    db.from = ((table: string) => {
      const builder = realFrom(table);
      if (table !== 'marketplace_handoffs') return builder;
      const refused = {
        eq: () => refused, in: () => refused,
        select: async () => ({ data: null, error: { code: '42501', message: 'permission denied for table marketplace_handoffs' } }),
      };
      builder.update = (() => refused) as unknown as typeof builder.update;
      return builder;
    }) as typeof db.from;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await setOrderStatusAction('order-1', 'cancelled')).toEqual({ ok: true });

    expect(db.table('marketplace_orders')[0]).toMatchObject({ status: 'cancelled' });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
