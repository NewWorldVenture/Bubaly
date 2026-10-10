import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A cancelled marketplace pickup comes off the family calendar.
 *
 * Confirming a pickup (`confirmHandoffAction`) puts it on the family calendar
 * and links the event as `marketplace_handoffs.calendar_event_id`. Cancelling it
 * (`cancelHandoffAction`) set the pickup to `cancelled` and nothing else, so the
 * event stayed. The daily notifications run (lib/server/notifications.ts) turns
 * every calendar event in the next 48 hours into a notification for the family,
 * so everyone was reminded of a meetup that was off; and when the two parties
 * arranged a new one, the calendar showed both times. Same class as 0360's
 * head-out event left behind by a deleted plan.
 *
 * Confirming also inserts the event BEFORE its guarded `status = 'proposed'`
 * claim. When the claim loses (the other side cancelled a moment earlier, or a
 * double press), the action reports failure and the event it just made stayed.
 */
const harness = vi.hoisted(() => ({ db: null as unknown, memberId: 'member-s' }));
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
const { proposeHandoffAction, confirmHandoffAction, cancelHandoffAction } = await import('@/app/(app)/marketplace/handoff/actions');

const MEET_AT = '2026-10-12T15:00:00.000Z';

function seedOrder(db: InMemorySupabase) {
  db.seed('marketplace_orders', [{
    id: 'order-1', family_id: 'family-1', listing_id: 'listing-1',
    buyer_member: 'member-b', seller_member: 'member-s', status: 'confirmed',
  }]);
}

function seedConfirmedPickup(db: InMemorySupabase) {
  db.seed('calendar_events', [
    { id: 'event-pickup', family_id: 'family-1', title: 'Marketplace pickup · Library', starts_at: MEET_AT },
    { id: 'event-other', family_id: 'family-1', title: 'Swim practice', starts_at: MEET_AT },
  ]);
  db.seed('marketplace_handoffs', [{
    id: 'handoff-1', order_id: 'order-1', family_id: 'family-1', listing_id: 'listing-1',
    proposed_by: 'member-s', proposer_role: 'seller', status: 'confirmed', location_label: 'Library',
    location_kind: 'public_spot', meet_at: MEET_AT, confirm_code: 'K7Q4', calendar_event_id: 'event-pickup',
  }]);
}

const eventIds = (db: InMemorySupabase) => db.table('calendar_events').map((e) => e.id);

describe('a cancelled marketplace pickup', () => {
  let db: InMemorySupabase;
  beforeEach(() => {
    db = createInMemorySupabase();
    harness.db = db;
    harness.memberId = 'member-s';
    seedOrder(db);
  });

  it('comes off the family calendar, and nothing else does', async () => {
    seedConfirmedPickup(db);

    expect(await cancelHandoffAction('order-1')).toEqual({ ok: true });

    expect(db.table('marketplace_handoffs')[0]).toMatchObject({ status: 'cancelled' });
    expect(eventIds(db)).toEqual(['event-other']);
  });

  it('is removed only from its own family\'s calendar', async () => {
    seedConfirmedPickup(db);
    const [pickup] = db.table('calendar_events');
    pickup.family_id = 'family-2';

    expect(await cancelHandoffAction('order-1')).toEqual({ ok: true });

    expect(eventIds(db)).toEqual(['event-pickup', 'event-other']);
  });

  it('cancels a pickup that never reached the calendar without touching it', async () => {
    db.seed('calendar_events', [{ id: 'event-other', family_id: 'family-1', title: 'Swim practice', starts_at: MEET_AT }]);
    db.seed('marketplace_handoffs', [{
      id: 'handoff-1', order_id: 'order-1', family_id: 'family-1', listing_id: 'listing-1',
      proposed_by: 'member-s', proposer_role: 'seller', status: 'proposed', location_label: 'Library',
      meet_at: MEET_AT, confirm_code: null, calendar_event_id: null,
    }]);

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await cancelHandoffAction('order-1')).toEqual({ ok: true });

    expect(db.table('marketplace_handoffs')[0]).toMatchObject({ status: 'cancelled' });
    expect(eventIds(db)).toEqual(['event-other']);
    // Nothing to remove is not a failed removal.
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('still reports the cancel when the calendar cannot be cleaned up', async () => {
    seedConfirmedPickup(db);
    const realFrom = db.from.bind(db);
    db.from = ((table: string) => {
      const builder = realFrom(table);
      if (table !== 'calendar_events') return builder;
      // A refused delete: RLS answering no rows rather than an error.
      builder.delete = () => builder.select('id').eq('id', '__nothing__');
      return builder;
    }) as typeof db.from;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await cancelHandoffAction('order-1')).toEqual({ ok: true });

    expect(db.table('marketplace_handoffs')[0]).toMatchObject({ status: 'cancelled' });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('leaves one pickup on the calendar after it is arranged again', async () => {
    seedConfirmedPickup(db);

    harness.memberId = 'member-b';
    expect(await cancelHandoffAction('order-1')).toEqual({ ok: true });
    harness.memberId = 'member-s';
    expect(await proposeHandoffAction({ orderId: 'order-1', meetAtIso: '2026-10-14T17:00:00.000Z', locationLabel: 'Police station', locationKind: 'public_spot' })).toEqual({ ok: true });
    harness.memberId = 'member-b';
    const confirmed = await confirmHandoffAction('order-1');
    expect(confirmed.ok).toBe(true);

    const pickups = db.table('calendar_events').filter((e) => String(e.title).startsWith('Marketplace pickup'));
    expect(pickups).toHaveLength(1);
    expect(pickups[0]).toMatchObject({ starts_at: '2026-10-14T17:00:00.000Z' });
    expect(db.table('marketplace_handoffs')[0]).toMatchObject({ status: 'confirmed', calendar_event_id: pickups[0].id });
  });
});

describe('a confirm that loses its claim', () => {
  let db: InMemorySupabase;
  beforeEach(() => {
    db = createInMemorySupabase();
    harness.db = db;
    harness.memberId = 'member-b';
    seedOrder(db);
    db.seed('calendar_events', [{ id: 'event-other', family_id: 'family-1', title: 'Swim practice', starts_at: MEET_AT }]);
    db.seed('marketplace_handoffs', [{
      id: 'handoff-1', order_id: 'order-1', family_id: 'family-1', listing_id: 'listing-1',
      proposed_by: 'member-s', proposer_role: 'seller', status: 'proposed', location_label: 'Library',
      meet_at: MEET_AT, confirm_code: null, calendar_event_id: null,
    }]);
  });

  /** The seller cancels between this confirm's read and its guarded claim. */
  function cancelWhileConfirming() {
    const realFrom = db.from.bind(db);
    db.from = ((table: string) => {
      const builder = realFrom(table);
      if (table === 'calendar_events') {
        const insert = builder.insert.bind(builder);
        builder.insert = (rows) => {
          db.table('marketplace_handoffs')[0].status = 'cancelled';
          return insert(rows);
        };
      }
      return builder;
    }) as typeof db.from;
  }

  it('takes back the calendar event it made', async () => {
    cancelWhileConfirming();

    const res = await confirmHandoffAction('order-1');

    expect(res).toEqual({ ok: false, error: 'Could not confirm the pickup.' });
    expect(db.table('marketplace_handoffs')[0]).toMatchObject({ status: 'cancelled', confirm_code: null, calendar_event_id: null });
    expect(eventIds(db)).toEqual(['event-other']);
  });

  it('keeps the event when the claim lands', async () => {
    const res = await confirmHandoffAction('order-1');

    expect(res.ok).toBe(true);
    const [handoff] = db.table('marketplace_handoffs');
    expect(handoff.status).toBe('confirmed');
    expect(eventIds(db)).toEqual(['event-other', handoff.calendar_event_id]);
  });
});
