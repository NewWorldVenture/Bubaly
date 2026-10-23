import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { byName, change, click, form, has, nodes, render, settle, submit, text, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// The relationship, voting, wish-list and celebrations modules, driven as a
// person drives them (module-harness: the real component, its own reads and
// writes, the real lib helpers and family clock; an in-memory database).
//
//   relationship  showed the partner the gifts being planned for them (F3);
//                 deleted a date straight from the browser, leaving its
//                 calendar event (F17); saved "0 days before" as 14 (F25)
//   voting        took a vote after the deadline on a page rendered before it
//                 (F7); left an option-less poll when the options failed
//                 (F15/F35); Reopen did nothing past the deadline (F16)
//   wish lists    sorted the owner's bought wishes last (F2/F5)
//   celebrations  counted Today/Tomorrow from the device's day (F22)

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const actions = vi.hoisted(() => ({
  toggle: vi.fn(async () => ({ ok: true, onCalendar: true, eventId: 'e1' })),
  sync: vi.fn(async () => ({ ok: true })),
  remove: vi.fn(async () => ({ ok: true })),
}));

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
vi.mock('@/components/ai/why-this', () => ({ WhyThis: () => null }));
vi.mock('@/components/wishlists/before-you-buy', () => ({ BeforeYouBuy: () => null }));
// Close, Reopen and delete on a poll go through the checked voting actions
// (app/(app)/dashboard/voting/actions.ts): run here for real, as the signed-in
// parent, against the same in-memory database.
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({
  user: { id: h.app.userId, email: null },
  active: { familyId: h.app.familyId, role: (h.app as Record<string, unknown>).role, family: { name: 'Family', timezone: 'UTC' }, member: { id: 'member-1' } },
}) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages } = await import('@/lib/i18n/messages');
  const { translate: tr } = await import('@/lib/i18n/translate');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params) };
});
vi.mock('@/app/(app)/dashboard/relationship/actions', () => ({
  toggleDateOnCalendarAction: actions.toggle,
  syncDateOnCalendarAction: actions.sync,
  removeRelationshipDateAction: actions.remove,
}));

const { RelationshipModule } = await import('@/components/modules/relationship-module');
const { VotingModule } = await import('@/components/modules/voting-module');
const { WishlistsModule } = await import('@/components/modules/wishlists-module');
const { CelebrationsModule } = await import('@/components/modules/celebrations-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
const ME = 'member-1';
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T15:00:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true;
  h.timeZone = 'UTC';
  h.app.members = [
    { id: ME, display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: null },
    { id: 'member-2', display_name: 'Bo', role: 'parent', is_active: true, color: null, birthday: null },
  ];
  h.app.selfMember = { ...h.app.members[0], family_id: FAMILY };
  (h.app as Record<string, unknown>).role = 'parent';
  actions.toggle.mockClear(); actions.sync.mockClear(); actions.remove.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('confirm', () => true);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const fieldBy = (tree: ReactNode, test: (n: Node) => boolean) => {
  const found = nodes(form(tree)).find((n) => typeof n.type === 'string' && test(n));
  if (!found) throw new Error('no such field');
  return found;
};

describe('relationship helper', () => {
  const screen = () => render(h.hooks, createElement(RelationshipModule));

  it('a date set to remind "0 days before" is saved as 0, not 14 (F25)', async () => {
    await click(byName(screen(), t('relationship.addDate')));
    change(fieldBy(screen(), (n) => n.type === 'input' && n.props.placeholder === t('relationship.eGOurAnniversary')), 'Our anniversary');
    change(fieldBy(screen(), (n) => n.type === 'input' && n.props.type === 'date'), '2026-11-14');
    change(fieldBy(screen(), (n) => n.type === 'input' && n.props.type === 'number'), '0');
    await submit(form(screen()));

    expect(db.table('relationship_dates')).toEqual([expect.objectContaining({ title: 'Our anniversary', reminder_days_before: 0 })]);
  });

  it('removing a date goes through the action that takes its calendar event too (F17)', async () => {
    db.seed('relationship_dates', [{ id: 'date-1', family_id: FAMILY, kind: 'anniversary', title: 'Our anniversary', event_date: '2026-11-14', recurs_annually: true, reminder_days_before: 14, status: 'upcoming', calendar_event_id: 'event-1', location: null, member_id: null, notes: null }]);
    await click(byName(screen(), t('relationship.remove')));

    expect(actions.remove).toHaveBeenCalledWith('date-1');
    expect(h.toasts.error).toEqual([]);
  });

  it('editing a date that is on the calendar brings its event along (F17)', async () => {
    db.seed('relationship_dates', [{ id: 'date-1', family_id: FAMILY, kind: 'anniversary', title: 'Our anniversary', event_date: '2026-11-14', recurs_annually: true, reminder_days_before: 14, status: 'upcoming', calendar_event_id: 'event-1', location: null, member_id: null, notes: null }]);
    await click(byName(screen(), t('relationship.edit')));
    change(fieldBy(screen(), (n) => n.type === 'input' && n.props.type === 'date'), '2026-11-21');
    await submit(form(screen()));

    expect(db.table('relationship_dates')[0].event_date).toBe('2026-11-21');
    expect(actions.sync).toHaveBeenCalledWith('date-1');
  });

  it('the partner the gifts are for does not see them, or their claimed wishes (F3)', async () => {
    // Ada (the viewer) is the partner Bo is buying for.
    db.seed('relationship_profile', [{ id: 'p1', family_id: FAMILY, partner_name: 'Ada', partner_member_id: ME, interests: [], love_languages: [], gift_budget_cents: null }]);
    db.seed('relationship_gift_ideas', [
      { id: 'g-bo', family_id: FAMILY, created_by: 'user-of-bo', title: 'Surprise spa day', status: 'purchased', source: 'manual', for_name: 'Ada', price_cents: 15000, wishlist_item_id: null },
      { id: 'g-ada', family_id: FAMILY, created_by: h.app.userId, title: 'Concert tickets for Bo', status: 'idea', source: 'manual', for_name: 'Bo', price_cents: null, wishlist_item_id: null },
    ]);
    db.seed('wishlist_items', [
      { id: 'w1', family_id: FAMILY, member_id: ME, title: 'Telescope', price: 200, priority: 'high', is_purchased: false, claimed_by: null },
    ]);
    const tree = screen();

    expect(has(tree, 'Surprise spa day')).toBe(false);
    expect(has(tree, 'Concert tickets for Bo')).toBe(true);
    expect(() => byName(tree, `${t('relationship.fromWishlist')}`)).toThrow();
  });

  it('the partner who plans the gifts still sees all of them (F3)', async () => {
    db.seed('relationship_profile', [{ id: 'p1', family_id: FAMILY, partner_name: 'Bo', partner_member_id: 'member-2', interests: [], love_languages: [], gift_budget_cents: null }]);
    db.seed('relationship_gift_ideas', [
      { id: 'g-other', family_id: FAMILY, created_by: 'user-of-someone', title: 'Surprise spa day', status: 'idea', source: 'manual', for_name: 'Bo', price_cents: 15000, wishlist_item_id: null },
    ]);
    expect(has(screen(), 'Surprise spa day')).toBe(true);
  });
});

describe('group voting', () => {
  const screen = () => render(h.hooks, createElement(VotingModule));
  const poll = (over: Record<string, unknown>) => ({
    id: 'poll-1', family_id: FAMILY, question: 'Pizza or tacos?', description: null, kind: 'single', status: 'open', closes_at: null,
    vacation_id: null, decision_category: 'general', budget_cents: null, required_tags: [], created_by: h.app.userId, created_at: '2026-10-10T00:00:00Z', ...over,
  });

  it('a tap after the deadline on a page opened before it is not a vote (F7)', async () => {
    db.seed('family_polls', [poll({ closes_at: '2026-10-12T15:05:00.000Z' })]);
    db.seed('family_poll_options', [{ id: 'opt-pizza', family_id: FAMILY, poll_id: 'poll-1', label: 'Pizza', sort: 0 }]);
    const opened = screen(); // 15:00 — five minutes before it closes
    const option = nodes(opened).find((n) => n.type === 'button' && text(n).includes('Pizza'))!;
    expect(option.props.disabled).toBe(false);

    vi.setSystemTime(new Date('2026-10-12T15:10:00Z'));
    await click(option);

    expect(db.table('family_poll_votes')).toEqual([]);
    expect(h.toasts.error).toEqual([t('votingModule.thisPollIsClosed')]);
  });

  it('options that fail to save take their poll back with them (F15/F35)', async () => {
    h.fault = (table, calls) => (table === 'family_poll_options' && calls.includes('insert')
      ? { code: '22003', message: 'value "3000000000" is out of range for type integer' } : null);
    await click(byName(screen(), t('voting.newPoll')));
    change(fieldBy(screen(), (n) => n.props.placeholder === t('voting.whereShouldWeGoThisSummer')), 'Where to eat?');
    change(fieldBy(screen(), (n) => n.props.placeholder === t('voting.optionN', { n: 1 })), 'Pizza');
    change(fieldBy(screen(), (n) => n.props.placeholder === t('voting.optionN', { n: 2 })), 'Tacos');
    change(fieldBy(screen(), (n) => n.props['aria-label'] === t('voting.optionNTravel', { n: 1 })), '3000000000');
    await submit(form(screen()));

    expect(db.table('family_polls')).toEqual([]);
    expect(h.toasts.error).toHaveLength(1);
  });

  it('Reopen on a poll closed by its deadline opens it (F16)', async () => {
    db.seed('family_polls', [poll({ closes_at: '2026-10-11T00:00:00.000Z' })]);
    db.seed('family_poll_options', [{ id: 'opt-pizza', family_id: FAMILY, poll_id: 'poll-1', label: 'Pizza', sort: 0 }]);
    await click(nodes(screen()).find((n) => n.type === 'button' && text(n) === 'Reopen')!);

    expect(db.table('family_polls')[0]).toMatchObject({ status: 'open', closes_at: null });
    expect(h.toasts.error).toEqual([]);
    const option = nodes(screen()).find((n) => n.type === 'button' && text(n).includes('Pizza'))!;
    expect(option.props.disabled).toBe(false);
  });
});

describe('wish lists', () => {
  it('my own list is not sorted bought-last, so its order does not give the presents away (F2/F5)', () => {
    db.seed('wishlist_items', [
      { id: 'w1', family_id: FAMILY, member_id: ME, title: 'Bike', priority: 'medium', is_purchased: true, claimed_by: 'member-2', url: null, price: null, notes: null },
      { id: 'w2', family_id: FAMILY, member_id: ME, title: 'Zither', priority: 'medium', is_purchased: false, claimed_by: null, url: null, price: null, notes: null },
    ]);
    const tree = render(h.hooks, createElement(WishlistsModule));
    const titles = nodes(tree).filter((n) => n.type === 'div' && n.props.className === 'mt-2 font-semibold text-fg').map((n) => text(n));
    expect(titles).toEqual(['Bike', 'Zither']);
  });
});

describe('celebrations', () => {
  it('counts Today from the family\'s day, not the device\'s (F22)', () => {
    // 10:30 at Greenwich: still the 12th in UTC, Los Angeles and Tokyo, and
    // already the 13th on Kiritimati, where this family lives.
    vi.setSystemTime(new Date('2026-10-12T10:30:00Z'));
    h.timeZone = 'Pacific/Kiritimati';
    db.seed('family_dates', [{ id: 'd1', family_id: FAMILY, title: 'Gran\'s birthday', kind: 'birthday', event_date: '1950-10-13', member_id: null }]);
    const tree = render(h.hooks, createElement(CelebrationsModule));
    expect(has(tree, 'Today')).toBe(true);
    expect(has(tree, 'Tomorrow')).toBe(false);
  });
});

afterEach(async () => { await settle(); });
