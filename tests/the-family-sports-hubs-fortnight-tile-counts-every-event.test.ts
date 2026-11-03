// The Family Sports Hub's "Upcoming (14d)" tile counts every practice and game
// in the next fortnight.
//
// THE DEFECT. `app/(app)/dashboard/family-sports/page.tsx` printed
// `events.length` on the tile, and `events` is the read that fills the
// "Practices & games · Next 14 days" preview, which stops at eight rows
// (`.limit(8)`). A family with three children in sports has a dozen practices
// and games in a fortnight, and the tile said 8.
//
// WHAT IS ASSERTED, on the page as rendered against an in-memory database: the
// tile counts every event in the window (and none before it or after it), and
// the preview below it still lists eight.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'fam';

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/supabase/auth', () => ({
  requireFeature: async () => ({
    user: { id: 'user-parent' },
    memberships: [],
    active: {
      familyId: 'fam', role: 'parent',
      member: { id: 'member-parent', family_id: 'fam' },
      family: { id: 'fam', timezone: 'America/Los_Angeles' },
    },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/utils/format-server', () => ({ getFormat: async () => ({ fmtDate: (value: string) => value, fmtDateTime: (value: string) => value }) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard/family-sports', useRouter: () => ({ refresh: () => {} }) }));

const FamilySportsPage = (await import('@/app/(app)/dashboard/family-sports/page')).default;
const { LocaleProvider } = await import('@/components/i18n/locale-provider');
const { getMessages } = await import('@/lib/i18n/messages');
const { localeOrDefault } = await import('@/lib/i18n/locales');

const DAY = 86_400_000;
let db: InMemorySupabase;

const event = (id: string, title: string, at: number) => ({
  id, family_id: FAMILY, member_id: null, sport: 'Soccer', team: 'Thunder FC', title,
  event_type: 'practice', location: 'Riverside Park', starts_at: new Date(at).toISOString(), ends_at: null,
  recurrence: 'none', recurrence_until: null, created_by: 'user-parent',
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T01:00:00Z'));
  db = createInMemorySupabase();
  harness.db = db;
  db.seed('family_members', [{ id: 'member-parent', family_id: FAMILY, display_name: 'Ada', is_active: true }]);
});
afterEach(() => { vi.useRealTimers(); });

/** The page as text, the way a phone paints it. */
async function openTheSportsHub(): Promise<string> {
  const tree = await FamilySportsPage();
  return renderToStaticMarkup(createElement(
    LocaleProvider,
    { locale: localeOrDefault('en-US'), source: 'cookie', messages: getMessages('en-US') } as Parameters<typeof LocaleProvider>[0],
    tree as React.ReactElement,
  )).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

/** The number on the Upcoming (14d) tile (the tile prints its value, then its label). */
function fortnightTile(text: string): string | undefined {
  return text.match(/(\d+) dashboardFamilySports\.upcoming14d /)?.[1];
}

describe("the Family Sports Hub's Upcoming (14d) tile", () => {
  it('counts all twelve events in the next fortnight, while the preview lists eight', async () => {
    const now = Date.now();
    db.seed('sports_events', [
      event('past', 'Last week practice', now - 6 * DAY),
      ...Array.from({ length: 12 }, (_, i) => event(`soon-${i + 1}`, `Practice ${String(i + 1).padStart(2, '0')}`, now + DAY + i * DAY)),
      event('later', 'Winter tournament', now + 20 * DAY),
    ]);
    const page = await openTheSportsHub();
    expect(fortnightTile(page)).toBe('12');
    // The preview is still the next eight, soonest first.
    expect(page).toContain('Practice 08');
    expect(page).not.toContain('Practice 09');
    expect(page).not.toContain('Last week practice');
    expect(page).not.toContain('Winter tournament');
  });

  it('counts three when there are three', async () => {
    const now = Date.now();
    db.seed('sports_events', [
      ...Array.from({ length: 3 }, (_, i) => event(`soon-${i + 1}`, `Practice ${i + 1}`, now + DAY + i * DAY)),
      event('later', 'Winter tournament', now + 20 * DAY),
    ]);
    expect(fortnightTile(await openTheSportsHub())).toBe('3');
  });
});
