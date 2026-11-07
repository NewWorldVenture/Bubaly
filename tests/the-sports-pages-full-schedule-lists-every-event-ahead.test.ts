import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, has, nodes, render, settle, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// The Sports page (components/modules/sports-module.tsx), driven as a parent
// drives it: the real component, its own reads and writes, against an
// in-memory database (tests/helpers/module-harness.tsx).
//
// `upcoming` was every event still ahead cut to five, and the Overview table
// and the Schedule tab both rendered that one list. "View full schedule"
// switched to the Schedule tab and showed the same five rows, so a family with
// more than five practices and games ahead never saw the sixth anywhere on the
// page, and could not delete it either: the delete button is on the row. The
// "Upcoming Events" tile says "Next 14 days" and showed the length of that same
// capped list: 5 for eight events this fortnight, and 5 for two this fortnight
// with more in December.

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

const { SportsModule } = await import('@/components/modules/sports-module');

const FAMILY = h.app.familyId;
const DAY = 86_400_000;
// 18:00 on Monday 12 October in Los Angeles.
const NOW = Date.parse('2026-10-13T01:00:00Z');
let db: ReturnType<typeof createInMemorySupabase>;

const event = (id: string, title: string, startsAt: number) => ({
  id, family_id: FAMILY, member_id: null, sport: 'Soccer', team: 'Thunder FC', title,
  event_type: 'practice', location: 'Riverside Park', starts_at: new Date(startsAt).toISOString(), ends_at: null,
  recurrence: 'none', recurrence_until: null, created_by: 'user-1',
});
const lastWeek = event('past', 'Last week\'s game', NOW - 6 * DAY);
// Eight practices over the next fortnight, one every day and a half.
const fortnight = Array.from({ length: 8 }, (_, i) => event(`soon-${i + 1}`, `Practice ${i + 1}`, NOW + DAY + i * 1.5 * DAY));
const december = [
  event('dec-1', 'Winter tournament', Date.parse('2026-12-05T17:00:00Z')),
  event('dec-2', 'Holiday scrimmage', Date.parse('2026-12-12T17:00:00Z')),
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true;
  h.timeZone = 'America/Los_Angeles';
  h.app.members = [{ id: 'member-1', display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: null }];
  h.app.family = { id: FAMILY, name: 'Fixture family', timezone: 'America/Los_Angeles' };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => { await settle(); vi.useRealTimers(); vi.restoreAllMocks(); });

const screen = () => render(h.hooks, createElement(SportsModule));
/** The number on the stat tile whose label is `label`. */
function tile(tree: ReactNode, label: string): string {
  const card = nodes(tree).find((n) => typeof n.props.className === 'string'
    && (n.props.className as string).includes('stat-card') && has(n, label));
  if (!card) throw new Error(`no tile labelled ${label}`);
  const paragraphs = nodes(card.props.children as ReactNode).filter((n) => n.type === 'p');
  return text(paragraphs[0]);
}

describe("the Sports page's schedule", () => {
  it('the Overview previews the next five events', () => {
    db.seed('sports_events', [lastWeek, ...fortnight, ...december]);
    const tree = screen();
    for (let i = 1; i <= 5; i++) expect(has(tree, `Practice ${i}`)).toBe(true);
    expect(has(tree, 'Practice 6')).toBe(false);
    expect(has(tree, 'Last week\'s game')).toBe(false);
  });

  it('"View full schedule" lists every event still ahead, not the same five', async () => {
    db.seed('sports_events', [lastWeek, ...fortnight, ...december]);
    await click(byName(screen(), 'View full schedule'));
    const tree = screen();
    for (let i = 1; i <= 8; i++) expect(has(tree, `Practice ${i}`)).toBe(true);
    expect(has(tree, 'Winter tournament')).toBe(true);
    expect(has(tree, 'Holiday scrimmage')).toBe(true);
    expect(has(tree, 'Last week\'s game')).toBe(false);
  });

  it('the sixth event ahead can be removed from the full schedule', async () => {
    db.seed('sports_events', [lastWeek, ...fortnight, ...december]);
    await click(byName(screen(), 'View full schedule'));
    await click(byName(screen(), 'Delete “Practice 6”?'));
    expect(db.table('sports_events').map((row) => row.id)).not.toContain('soon-6');
    const tree = screen();
    expect(has(tree, 'Practice 6')).toBe(false);
    expect(has(tree, 'Practice 7')).toBe(true);
    expect(h.toasts.success).toContain('Event deleted');
  });
});

describe('the "Upcoming Events · Next 14 days" tile', () => {
  it('counts all eight events in the next fortnight, not five', () => {
    db.seed('sports_events', [lastWeek, ...fortnight, ...december]);
    expect(tile(screen(), 'Upcoming Events')).toBe('8');
  });

  it('counts the two events in the next fortnight, not the ones in December', () => {
    db.seed('sports_events', [lastWeek, ...fortnight.slice(0, 2), ...december, event('dec-3', 'New Year cup', Date.parse('2027-01-02T17:00:00Z'))]);
    expect(tile(screen(), 'Upcoming Events')).toBe('2');
  });
});
