import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * Rescheduling a pickup from a stale screen does not undo one the other side
 * just confirmed.
 *
 * `proposeHandoffAction` upserted the order's single pickup on `order_id` and
 * never looked at what it replaced. "Reschedule" is offered while a pickup is
 * proposed; pressed on a screen that still showed it proposed after the other
 * party had confirmed it, the upsert put it back to `proposed`, cleared the
 * hand-off code the other party was already holding, and unlinked its calendar
 * event. A pickup already completed was reopened the same way.
 *
 * It now reads the pickup, rewrites it only from `proposed` or `cancelled` with
 * the write guarded on the status it read, inserts a first one (the unique
 * `order_id` refuses a racing second), and otherwise says the pickup changed.
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
const { proposeHandoffAction } = await import('@/app/(app)/marketplace/handoff/actions');

const CHANGED = 'This pickup changed a moment ago. Refresh to see where it stands.';
const MEET_AT = '2026-10-12T15:00:00.000Z';
const NEW_TIME = '2026-10-14T17:00:00.000Z';
const reschedule = () => proposeHandoffAction({ orderId: 'order-1', meetAtIso: NEW_TIME, locationLabel: 'Police station', locationKind: 'public_spot' });

describe('proposing a pickup', () => {
  let db: InMemorySupabase;
  beforeEach(() => {
    db = createInMemorySupabase({ uniques: { marketplace_handoffs: [['order_id']] } });
    harness.db = db;
    harness.memberId = 'member-s';
    db.seed('marketplace_orders', [{
      id: 'order-1', family_id: 'family-1', listing_id: 'listing-1',
      buyer_member: 'member-b', seller_member: 'member-s', kind: 'buy', status: 'confirmed',
    }]);
    db.seed('calendar_events', [
      { id: 'event-pickup', family_id: 'family-1', title: 'Marketplace pickup · Library', starts_at: MEET_AT },
      { id: 'event-other', family_id: 'family-1', title: 'Swim practice', starts_at: MEET_AT },
    ]);
  });

  function seedPickup(status: string, extra: Record<string, unknown> = {}) {
    db.seed('marketplace_handoffs', [{
      id: 'handoff-1', order_id: 'order-1', family_id: 'family-1', listing_id: 'listing-1',
      proposed_by: 'member-b', proposer_role: 'buyer', status, location_label: 'Library', location_kind: 'public_spot',
      meet_at: MEET_AT, confirm_code: null, calendar_event_id: null, ...extra,
    }]);
  }

  const eventIds = () => db.table('calendar_events').map((e) => e.id);

  it('does not undo a pickup the other side confirmed', async () => {
    seedPickup('confirmed', { confirm_code: 'K7Q4', calendar_event_id: 'event-pickup' });

    expect(await reschedule()).toEqual({ ok: false, error: CHANGED });

    expect(db.table('marketplace_handoffs')).toHaveLength(1);
    expect(db.table('marketplace_handoffs')[0]).toMatchObject({
      status: 'confirmed', confirm_code: 'K7Q4', calendar_event_id: 'event-pickup', location_label: 'Library', meet_at: MEET_AT,
    });
    expect(eventIds()).toEqual(['event-pickup', 'event-other']);
  });

  it('does not reopen a pickup that already happened', async () => {
    seedPickup('completed', { confirm_code: 'K7Q4' });

    expect(await reschedule()).toEqual({ ok: false, error: CHANGED });

    expect(db.table('marketplace_handoffs')[0]).toMatchObject({ status: 'completed', confirm_code: 'K7Q4', location_label: 'Library' });
  });

  it('does not overwrite a pickup confirmed between its read and its write', async () => {
    seedPickup('proposed');
    const realFrom = db.from.bind(db);
    db.from = ((table: string) => {
      const builder = realFrom(table);
      if (table !== 'marketplace_handoffs') return builder;
      for (const verb of ['update', 'upsert'] as const) {
        const write = (builder[verb] as (...args: unknown[]) => typeof builder).bind(builder);
        (builder as unknown as Record<string, unknown>)[verb] = (...args: unknown[]) => {
          Object.assign(db.table('marketplace_handoffs')[0], { status: 'confirmed', confirm_code: 'K7Q4', calendar_event_id: 'event-pickup' });
          return write(...args);
        };
      }
      return builder;
    }) as typeof db.from;

    expect(await reschedule()).toEqual({ ok: false, error: CHANGED });

    expect(db.table('marketplace_handoffs')[0]).toMatchObject({ status: 'confirmed', confirm_code: 'K7Q4', calendar_event_id: 'event-pickup', location_label: 'Library' });
  });

  it('reschedules a pickup that is still only proposed', async () => {
    seedPickup('proposed');

    expect(await reschedule()).toEqual({ ok: true });

    expect(db.table('marketplace_handoffs')).toHaveLength(1);
    expect(db.table('marketplace_handoffs')[0]).toMatchObject({
      status: 'proposed', proposed_by: 'member-s', proposer_role: 'seller', location_label: 'Police station', meet_at: NEW_TIME,
    });
  });

  it('arranges a cancelled pickup again, taking down an event it left behind', async () => {
    seedPickup('cancelled', { calendar_event_id: 'event-pickup' });

    expect(await reschedule()).toEqual({ ok: true });

    expect(db.table('marketplace_handoffs')[0]).toMatchObject({
      status: 'proposed', location_label: 'Police station', confirm_code: null, calendar_event_id: null,
    });
    expect(eventIds()).toEqual(['event-other']);
  });

  it('arranges the first pickup for an order', async () => {
    expect(await reschedule()).toEqual({ ok: true });

    expect(db.table('marketplace_handoffs')).toHaveLength(1);
    expect(db.table('marketplace_handoffs')[0]).toMatchObject({
      order_id: 'order-1', family_id: 'family-1', listing_id: 'listing-1', status: 'proposed',
      proposed_by: 'member-s', proposer_role: 'seller', location_label: 'Police station',
    });
  });

  it('does not overwrite a first pickup the other side arranged a moment earlier', async () => {
    const realFrom = db.from.bind(db);
    let raced = false;
    db.from = ((table: string) => {
      const builder = realFrom(table);
      if (table !== 'marketplace_handoffs') return builder;
      for (const verb of ['insert', 'upsert'] as const) {
        const write = (builder[verb] as (...args: unknown[]) => typeof builder).bind(builder);
        (builder as unknown as Record<string, unknown>)[verb] = (...args: unknown[]) => {
          if (!raced) {
            raced = true;
            db.seed('marketplace_handoffs', [{
              id: 'handoff-b', order_id: 'order-1', family_id: 'family-1', listing_id: 'listing-1',
              proposed_by: 'member-b', proposer_role: 'buyer', status: 'proposed', location_label: 'Library', meet_at: MEET_AT,
            }]);
          }
          return write(...args);
        };
      }
      return builder;
    }) as typeof db.from;

    expect(await reschedule()).toEqual({ ok: false, error: CHANGED });

    expect(db.table('marketplace_handoffs')).toHaveLength(1);
    expect(db.table('marketplace_handoffs')[0]).toMatchObject({ id: 'handoff-b', proposer_role: 'buyer', location_label: 'Library' });
  });
});
