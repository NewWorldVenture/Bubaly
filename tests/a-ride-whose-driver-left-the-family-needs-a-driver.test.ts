import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, click, form, has, nodes, render, settle, submit, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';
import { activeDriverId } from '@/lib/rides/schedule';

// The Rides & Carpool planner (components/modules/rides-module.tsx), driven as
// a parent drives it, against an in-memory database.
//
// Removing a member is a soft delete (REMOVED_MEMBER_PATCH: is_active = false),
// so `rides.driver_id`'s `on delete set null` never fires: the ride keeps the
// removed member's id, while the roster the page reads is the ACTIVE members.
// Every ride a removed co-parent, grandparent or sitter was down to drive was
// left out of "N rides need a driver", because that count only asked whether
// `driver_id` was set, and its card read "Driver: ?" with no name. Nobody was
// driving it and the family was not told. Edit made it worse: the driver
// picker showed "Needs a driver" (no option matched the stored id) while the
// form still held the removed member's id, and Save wrote it back.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);

const { RidesModule } = await import('@/components/modules/rides-module');

const FAMILY = h.app.familyId;
const ADA = { id: 'member-ada', display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: null };
const BEN = { id: 'member-ben', display_name: 'Ben', role: 'child', is_active: true, color: null, birthday: null };
// Sam was the grandparent who drove on Tuesdays, and has been removed.
const SAM_REMOVED = 'member-sam';
let db: ReturnType<typeof createInMemorySupabase>;

const ride = (id: string, title: string, pickup: string, driver: string | null) => ({
  id, family_id: FAMILY, title, ride_date: '2026-10-13', pickup_time: pickup, dropoff_time: null,
  pickup_location: 'School', dropoff_location: 'Field 3', driver_id: driver, rider_ids: [BEN.id],
  status: 'planned', notes: null, event_id: null, created_by: 'user-1',
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 18:00 on Monday 12 October in Los Angeles; the rides are tomorrow.
  vi.setSystemTime(new Date('2026-10-13T01:00:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true;
  h.timeZone = 'America/Los_Angeles';
  h.app.members = [ADA, BEN];
  h.app.selfMember = { ...ADA, family_id: FAMILY };
  h.app.family = { id: FAMILY, name: 'Fixture family', timezone: 'America/Los_Angeles' };
  (h.app as Record<string, unknown>).role = 'parent';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('rides', [
    ride('soccer', 'Soccer pickup', '08:00:00', SAM_REMOVED),
    ride('swim', 'Swim drop-off', '09:00:00', ADA.id),
  ]);
});
afterEach(async () => { await settle(); vi.useRealTimers(); vi.restoreAllMocks(); });

const screen = () => render(h.hooks, createElement(RidesModule));
/** The card of the ride titled `title`: the innermost rounded card that names it. */
function card(tree: ReactNode, title: string) {
  const cards = nodes(tree).filter((n) => typeof n.props.className === 'string'
    && (n.props.className as string).includes('rounded-2xl border p-4') && has(n, title));
  if (!cards.length) throw new Error(`no card for ${title}`);
  return cards[cards.length - 1];
}

describe('a ride whose driver has left the family', () => {
  it('is counted among the rides that need a driver', () => {
    const tree = screen();
    expect(has(tree, '1 ride needs a driver')).toBe(true);
  });

  it('says Unassigned on its card, while a ride with a driver in the family names them', () => {
    const tree = screen();
    expect(has(card(tree, 'Soccer pickup'), 'Unassigned')).toBe(true);
    expect(has(card(tree, 'Swim drop-off'), 'Unassigned')).toBe(false);
    expect(has(card(tree, 'Swim drop-off'), 'Ada')).toBe(true);
  });

  it('opens in Edit as needing a driver, and saving does not write the removed member back', async () => {
    // The first Edit is the 08:00 soccer pickup.
    await click(allByName(screen(), 'Edit')[0]);
    const tree = screen();
    const picker = nodes(form(tree).props.children as ReactNode)
      .find((n) => n.type === 'select' && nodes(n.props.children as ReactNode).some((o) => o.type === 'option' && text(o) === 'Needs a driver'));
    expect(picker?.props.value).toBe('');
    await submit(form(tree));
    expect(h.toasts.error).toEqual([]);
    expect(db.table('rides').find((row) => row.id === 'soccer')?.driver_id).toBeNull();
    // The ride with a driver in the family keeps them.
    expect(db.table('rides').find((row) => row.id === 'swim')?.driver_id).toBe(ADA.id);
  });

  it('is not guessed at when the roster has not loaded: the stored driver stands', () => {
    h.app.members = [];
    const tree = screen();
    expect(has(tree, 'need a driver')).toBe(false);
    expect(has(tree, 'needs a driver')).toBe(false);
  });
});

describe('activeDriverId', () => {
  const roster = new Set([ADA.id, BEN.id]);
  it('keeps a driver who is in the family, and drops one who is not', () => {
    expect(activeDriverId(ADA.id, roster)).toBe(ADA.id);
    expect(activeDriverId(SAM_REMOVED, roster)).toBeNull();
    expect(activeDriverId(null, roster)).toBeNull();
  });
  it('keeps the stored driver when the roster is unknown', () => {
    expect(activeDriverId(SAM_REMOVED, null)).toBe(SAM_REMOVED);
  });
});
