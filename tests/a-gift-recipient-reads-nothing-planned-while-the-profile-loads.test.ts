import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { byName, render, settle, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// The relationship helper hides the gifts being planned for the partner they
// are FOR from that partner (F3). Which of the family the viewer is comes from
// `relationship_profile`, and the module's four reads — dates, gifts, profile,
// wishes — load independently. Only the dates gated the screen, so when dates
// and gifts answered before the profile, the filter read "no profile yet" as
// "not the recipient" and showed the recipient the whole plan until the
// profile caught up.
//
// The module-harness models `useRealtimeQuery` as already loaded, which cannot
// produce that ordering. Here the hook is the REAL one, and each table's read
// is held at a gate the test opens: the component, the hook and its loading
// states are production's; only the network is a database in memory with a
// door on it.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const reads = vi.hoisted(() => ({
  gates: new Map<string, { opened: Promise<{ message: string } | null>; open: (fault: { message: string } | null) => void }>(),
}));
const actions = vi.hoisted(() => ({
  toggle: vi.fn(async () => ({ ok: true, onCalendar: true, eventId: 'e1' })),
  sync: vi.fn(async () => ({ ok: true })),
  remove: vi.fn(async () => ({ ok: true })),
}));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
// No authenticated cache provider: the hook runs network-only, as it does
// for a module rendered outside the cache boundary.
vi.mock('@/lib/offline/cache-scope', () => ({
  useAuthenticatedCacheScope: () => null,
  isAuthenticatedCacheScopeCurrent: () => true,
}));
vi.mock('@/lib/supabase/client', () => {
  const gate = (table: string) => {
    let entry = reads.gates.get(table);
    if (!entry) {
      let open!: (fault: { message: string } | null) => void;
      const opened = new Promise<{ message: string } | null>((resolve) => { open = resolve; });
      entry = { opened, open };
      reads.gates.set(table, entry);
    }
    return entry.opened;
  };
  const client = {
    // A read waits at its table's gate and is answered by the database as it
    // stands when the gate opens — or by the fault the gate was opened with.
    from: (table: string) => {
      const builder = (h.db as InMemorySupabase).from(table);
      const proxy: object = new Proxy(builder, {
        get(object, key) {
          if (key === 'then') {
            return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => gate(table)
              .then((fault): unknown => (fault
                ? { data: null, error: { code: 'XX000', message: fault.message, details: null, hint: null } }
                : object.then((reply) => reply)))
              .then(resolve, reject);
          }
          const value = Reflect.get(object, key);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            const result = Reflect.apply(value, object, args);
            return result === object ? proxy : result;
          };
        },
      });
      return proxy;
    },
    channel: () => {
      const channel = { on: () => channel, subscribe: () => channel };
      return channel;
    },
    removeChannel: async () => 'ok',
  };
  return { createClient: () => client };
});
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/app/(app)/dashboard/relationship/actions', () => ({
  toggleDateOnCalendarAction: actions.toggle,
  syncDateOnCalendarAction: actions.sync,
  removeRelationshipDateAction: actions.remove,
}));

const { RelationshipModule } = await import('@/components/modules/relationship-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
const ME = 'member-1';
const BO = 'member-2';
let db: InMemorySupabase;

// What the recipient may never read: the gifts Bo is planning for them, and
// every total those gifts are counted into. Bo's two ideas are $150 (open) and
// $420 (bought); with Ada's own $40 idea the open total would be $190, and the
// bought one would show as "1 done".
const PLANNED_FOR_ME = ['Surprise spa day', 'Weekend in Lisbon', '$150', '$420', '$190', '· 1 done', '2 to buy'];
// What the recipient may: the gift they are planning themselves.
const MY_OWN = 'Concert tickets for Bo';

const open = async (table: string, fault: { message: string } | null = null) => {
  const gate = reads.gates.get(table);
  if (!gate) throw new Error(`no read of ${table} is waiting`);
  gate.open(fault);
  await settle();
};
const screen = () => render(h.hooks, createElement(RelationshipModule));
/** The first render, and the reads it starts arriving at their gates. */
const mount = async () => { screen(); await settle(); };
const shows = (tree: ReactNode) => text(tree);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T15:00:00Z'));
  // The hook listens for `online` on the window; a bare target stands in.
  vi.stubGlobal('window', new EventTarget());
  resetHookSlots(h.hooks);
  reads.gates.clear();
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true;
  h.timeZone = 'UTC';
  h.app.members = [
    { id: ME, display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: null },
    { id: BO, display_name: 'Bo', role: 'parent', is_active: true, color: null, birthday: null },
  ];
  h.app.selfMember = { ...h.app.members[0], family_id: FAMILY };
  vi.spyOn(console, 'error').mockImplementation(() => {});

  db.seed('relationship_dates', [{ id: 'date-1', family_id: FAMILY, kind: 'anniversary', title: 'Our anniversary', event_date: '2026-11-14', recurs_annually: true, reminder_days_before: 14, status: 'upcoming', calendar_event_id: null, location: null, member_id: null, notes: null }]);
  db.seed('relationship_gift_ideas', [
    { id: 'g-bo-1', family_id: FAMILY, created_by: 'user-of-bo', title: 'Surprise spa day', status: 'idea', source: 'manual', for_name: 'Ada', price_cents: 15000, wishlist_item_id: null, reason: null, url: null, occasion: null },
    { id: 'g-bo-2', family_id: FAMILY, created_by: 'user-of-bo', title: 'Weekend in Lisbon', status: 'purchased', source: 'manual', for_name: 'Ada', price_cents: 42000, wishlist_item_id: null, reason: null, url: null, occasion: null },
    { id: 'g-ada', family_id: FAMILY, created_by: h.app.userId, title: MY_OWN, status: 'idea', source: 'manual', for_name: 'Bo', price_cents: 4000, wishlist_item_id: null, reason: null, url: null, occasion: null },
  ]);
  db.seed('wishlist_items', [
    { id: 'w-ada', family_id: FAMILY, member_id: ME, title: 'Telescope', price: 200, priority: 'high', is_purchased: false, claimed_by: BO, url: null },
    { id: 'w-bo', family_id: FAMILY, member_id: BO, title: 'Sea kayak', price: 300, priority: 'high', is_purchased: false, claimed_by: null, url: null },
  ]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the partner the gifts are for, while the profile is still loading', () => {
  it('reads none of the plan when dates and gifts arrive first, and only their own gift once the profile says who they are', async () => {
    db.seed('relationship_profile', [{ id: 'p1', family_id: FAMILY, partner_name: 'Ada', partner_member_id: ME, interests: [], love_languages: [], gift_budget_cents: null, notes: null }]);
    await mount();
    expect([...reads.gates.keys()].sort()).toEqual(['relationship_dates', 'relationship_gift_ideas', 'relationship_profile', 'wishlist_items']);

    // Dates, gifts and wishes answer; the profile does not, yet.
    await open('relationship_dates');
    await open('relationship_gift_ideas');
    await open('wishlist_items');
    const waiting = screen();
    expect(shows(waiting)).toContain('Our anniversary');
    for (const secret of PLANNED_FOR_ME) expect(shows(waiting)).not.toContain(secret);
    expect(shows(waiting)).not.toContain(t('relationship.noGiftIdeasYet'));
    // The digest is built for the recipient the profile names: not asked for yet.
    expect(byName(waiting, t('relationship.aiSuggestions')).props.disabled).toBe(true);

    // The profile answers: Ada is the partner the gifts are for.
    await open('relationship_profile');
    const settled = screen();
    for (const secret of PLANNED_FOR_ME) expect(shows(settled)).not.toContain(secret);
    expect(shows(settled)).toContain(MY_OWN);
    expect(shows(settled)).toContain('1 to buy');
    expect(shows(settled)).toContain('$40 to go');
    expect(() => byName(settled, t('relationship.fromWishlist'))).toThrow();
    expect(byName(settled, t('relationship.aiSuggestions')).props.disabled).toBe(false);
  });

  it('reads none of it when the profile read fails, before or after the failure', async () => {
    db.seed('relationship_profile', [{ id: 'p1', family_id: FAMILY, partner_name: 'Ada', partner_member_id: ME, interests: [], love_languages: [], gift_budget_cents: null, notes: null }]);
    await mount();
    await open('relationship_dates');
    await open('relationship_gift_ideas');
    await open('wishlist_items');
    const waiting = screen();
    for (const secret of PLANNED_FOR_ME) expect(shows(waiting)).not.toContain(secret);

    await open('relationship_profile', { message: 'permission denied for table relationship_profile' });
    const failed = screen();
    for (const secret of PLANNED_FOR_ME) expect(shows(failed)).not.toContain(secret);
    expect(shows(failed)).not.toContain(MY_OWN);
  });
});

describe('the partner who plans the gifts', () => {
  it('reads the whole plan, and is offered the wish list, once every read has answered', async () => {
    db.seed('relationship_profile', [{ id: 'p1', family_id: FAMILY, partner_name: 'Bo', partner_member_id: BO, interests: [], love_languages: [], gift_budget_cents: null, notes: null }]);
    await mount();
    await open('relationship_dates');
    await open('relationship_gift_ideas');
    // The profile answers before the wishes the candidates are built from.
    await open('relationship_profile');
    const waiting = screen();
    expect(() => byName(waiting, t('relationship.fromWishlist'))).toThrow();

    await open('wishlist_items');
    const settled = screen();
    for (const title of ['Surprise spa day', 'Weekend in Lisbon', MY_OWN]) expect(shows(settled)).toContain(title);
    expect(shows(settled)).toContain('2 to buy');
    expect(shows(settled)).toContain('$190 to go');
    expect(shows(settled)).toContain('· 1 done');
    expect(byName(settled, t('relationship.fromWishlist')).props.disabled).toBeFalsy();
    expect(byName(settled, t('relationship.aiSuggestions')).props.disabled).toBe(false);
  });
});
