import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// `saveRentalAction` turns the form's `datetime-local` pickup and return into
// instants on the family's clock (F21). The converter answers null for a blank
// field AND for a filled-in one that names no instant — 30 February, 25:00 —
// and the action wrote that null either way. So an edit carrying a malformed
// time (a crafted post, an old browser without the native picker) cleared the
// rental's existing pickup instead of being refused. Blank still has to clear:
// it is how a family takes a time off a rental.
//
// Driven through the real server action against an in-memory database.

const h = vi.hoisted(() => ({ db: null as unknown, tz: 'America/New_York' }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1' },
    active: { familyId: 'family-1', role: 'parent', member: { id: 'member-1' }, family: { name: 'Family One', timezone: h.tz } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const auto = await import('@/app/(app)/dashboard/auto/actions');

const FAMILY = 'family-1';
const PICKUP = '2026-10-15T05:00:00.000Z'; // 1am on the 15th in New York
const RETURN = '2026-10-19T02:00:00.000Z'; // 10pm on the 18th in New York
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>();
  h.db = db;
  h.tz = 'America/New_York';
  db.seed('rental_cars', [{
    id: 'rental-1', family_id: FAMILY, company: 'Enterprise', confirmation_number: 'ABC123', pickup_location: 'JFK',
    dropoff_location: 'JFK', pickup_at: PICKUP, return_at: RETURN, vehicle_desc: 'Compact', daily_rate: 45, total_cost: 180,
    coverage: null, status: 'upcoming', notes: null, deleted_at: null,
  }]);
});
afterEach(() => { vi.restoreAllMocks(); });

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const edit = (fields: Record<string, string>) => form({
  id: 'rental-1', company: 'Enterprise', confirmation_number: 'ABC123', pickup_location: 'JFK', dropoff_location: 'JFK',
  pickup_at: '2026-10-15T01:00', return_at: '2026-10-18T22:00', vehicle_desc: 'Compact', daily_rate: '45', total_cost: '180',
  status: 'upcoming', ...fields,
});
const rental = () => db.table('rental_cars')[0];

describe('a rental time that names no instant', () => {
  it.each([
    ['pickup', { pickup_at: '2026-02-30T10:00', company: 'Hertz' }, 'actions.thatPickupTimeCouldNotBeRead'],
    ['pickup', { pickup_at: '2026-10-20T25:00', company: 'Hertz' }, 'actions.thatPickupTimeCouldNotBeRead'],
    ['return', { return_at: '2026-04-31T09:00', company: 'Hertz' }, 'actions.thatReturnTimeCouldNotBeRead'],
    ['return', { return_at: 'next tuesday', company: 'Hertz' }, 'actions.thatReturnTimeCouldNotBeRead'],
  ])('is refused on an edit of the %s, and nothing of the edit is written (%j)', async (_which, fields, message) => {
    const refused = auto.saveRentalAction(edit(fields));
    await expect(refused).rejects.toThrow(message);
    await expect(refused).rejects.toMatchObject({ digest: 'ACTION_REFUSED:invalid' });

    expect(rental()).toMatchObject({ pickup_at: PICKUP, return_at: RETURN, company: 'Enterprise' });
  });

  it('is refused on a new rental, and no rental is created', async () => {
    await expect(auto.saveRentalAction(form({ company: 'Avis', pickup_at: '2026-02-30T10:00', return_at: '' })))
      .rejects.toThrow('actions.thatPickupTimeCouldNotBeRead');
    expect(db.table('rental_cars')).toHaveLength(1);
  });
});

describe('a blank rental time', () => {
  it('clears the pickup and return it was meant to clear', async () => {
    await auto.saveRentalAction(edit({ pickup_at: '', return_at: '   ' }));
    expect(rental()).toMatchObject({ pickup_at: null, return_at: null, company: 'Enterprise' });
  });

  it('clears one and keeps the other when only one is blank', async () => {
    await auto.saveRentalAction(edit({ return_at: '' }));
    expect(rental()).toMatchObject({ pickup_at: PICKUP, return_at: null });
  });

  it('a well-formed edit still lands as the family\'s wall time', async () => {
    await auto.saveRentalAction(edit({ pickup_at: '2026-10-16T08:30' }));
    expect(rental()).toMatchObject({ pickup_at: '2026-10-16T12:30:00.000Z', return_at: RETURN });
  });
});
