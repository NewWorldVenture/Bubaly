// The kitchen display's members, birthdays and notes tiles say when their read
// failed (U1).
//
// The members read feeds the members tile AND the birthdays tile, the notes
// read the notes tile. Neither was reported in `loadStatus`, so a failed read
// rendered "No birthdays this week" and "No pinned notes" all day — the
// AutoRefresh re-ran the same failed read every two minutes — with the
// "some data is unavailable" banner hidden, because it reads only the tracked
// keys. The reminders, chores, meals and grocery tiles already failed closed.
//
// Driven through the real display page (the load) and the real DisplayShell
// (the render) against an in-memory database.
import { createElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderTranslated } from './helpers/render-translated';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/auth', () => ({ requireFeature: async () => ({ user: { id: 'user-1' }, active: { familyId: 'family-1', role: 'parent', member: { id: 'member-1' }, family: { name: 'Fixture family', timezone: 'UTC' } } }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key, getLocaleContext: async () => ({ locale: { code: 'en-US' }, source: 'default' }) }));
vi.mock('next/navigation', () => ({
  unstable_rethrow: () => {},
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/display',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/display/auto-refresh', () => ({ AutoRefresh: () => null }));
vi.mock('@/components/display/display-shell-client', () => ({ DisplayShellClient: () => null }));

const Page = (await import('@/app/(app)/display/page')).default;
const { DisplayShell, resolveDisplaySettings } = await import('@/components/display/display-grid');
const { resolveTiles } = await import('@/lib/display/tiles');
const { ToastProvider } = await import('@/components/ui/toast');
type DisplayData = import('@/components/display/display-grid').DisplayData;

const t = (key: string) => translate(SOURCE_MESSAGES, key);
let db: InMemorySupabase;

/** The page's data as it hands it to the shell. */
async function load(): Promise<DisplayData> {
  const node = await Page();
  function find(input: ReactNode): DisplayData | undefined {
    if (Array.isArray(input)) return input.map(find).find(Boolean);
    if (!input || typeof input !== 'object' || !('props' in input)) return undefined;
    const props = (input as ReactElement<{ data?: DisplayData; children?: ReactNode }>).props;
    return props.data ?? find(props.children);
  }
  const data = find(node);
  if (!data) throw new Error('Page did not return DisplayShellClient data');
  return data;
}
/** One table's reads fail; everything else answers from the database. */
function failing(...tables: string[]) {
  state.db = withFaults(db, (table) => (tables.includes(table) ? { code: '57014', message: 'canceling statement due to statement timeout' } : null));
}

const TILES = resolveTiles([
  { id: 'a', widget: 'members', size: 'wide' }, { id: 'b', widget: 'birthdays', size: 'sm' }, { id: 'c', widget: 'notes', size: 'sm' },
]);
function shell(data: DisplayData): string {
  return renderTranslated(createElement(ToastProvider, null,
    createElement(DisplayShell, { initialTiles: TILES, initialSettings: resolveDisplaySettings(null), data, familyId: 'family-1', userId: 'user-1' })));
}
function base(loadStatus: DisplayData['loadStatus']): DisplayData {
  return {
    familyName: 'Fixture family', timezone: 'UTC', dayKey: '2026-10-14', timezoneFallback: false, loadStatus,
    members: [], events: [], upcoming: [], chores: [], meals: [], grocery: { items: [], count: 0 }, reminders: [], birthdays: [],
    notes: [], featured: [], photos: [], calendar: { year: 2026, month: 9, today: 14, eventDays: [] },
  };
}
const ALL_OK = { events: 'ok', upcoming: 'ok', monthEvents: 'ok', reminders: 'ok', meals: 'ok', grocery: 'ok', chores: 'ok', members: 'ok', notes: 'ok' } as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T12:00:00.000Z'));
  db = createInMemorySupabase<SupabaseClient<Database>>();
  state.db = db;
  db.seed('family_members', [{ id: 'member-1', family_id: 'family-1', display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: '2010-10-20', created_at: '2026-01-01T00:00:00Z' }]);
  db.seed('notes', [{ id: 'note-1', family_id: 'family-1', title: 'Pinned', body: 'Buy candles', is_pinned: true, updated_at: '2026-10-01T00:00:00Z' }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the display page reports the members and notes reads', () => {
  it('a healthy load says both were read, with the birthday and the note', async () => {
    const data = await load();
    expect(data.loadStatus).toMatchObject({ members: 'ok', notes: 'ok' });
    expect(data.birthdays).toEqual([{ name: 'Ada', date: 'Oct 20' }]);
    expect(data.notes).toEqual([{ id: 'note-1', title: 'Pinned', body: 'Buy candles' }]);
  });

  it('a failed members read is reported, not an empty family with no birthdays', async () => {
    failing('family_members');
    const data = await load();
    expect(data.loadStatus?.members).toBe('error');
    expect(data.loadStatus?.notes).toBe('ok');
    expect(data.members).toEqual([]);
    expect(data.birthdays).toEqual([]);
  });

  it('a failed notes read is reported', async () => {
    failing('notes');
    const data = await load();
    expect(data.loadStatus?.notes).toBe('error');
    expect(data.loadStatus?.members).toBe('ok');
  });
});

describe('the tiles render the report', () => {
  it('members unread: the members and birthdays tiles say so, and the banner shows', () => {
    const html = shell(base({ ...ALL_OK, members: 'error' }));
    expect(html).toContain(t('displayGrid.membersUnavailable'));
    expect(html).toContain(t('displayGrid.birthdaysUnavailable'));
    expect(html).not.toContain(t('displayGrid.noBirthdaysThisWeek'));
    expect(html).toContain(t('displayGrid.dataUnavailable'));
  });

  it('notes unread: the notes tile says so instead of "No pinned notes"', () => {
    const html = shell(base({ ...ALL_OK, notes: 'error' }));
    expect(html).toContain(t('displayGrid.notesUnavailable'));
    expect(html).not.toContain(t('displayGrid.noPinnedNotes'));
    expect(html).toContain(t('displayGrid.dataUnavailable'));
  });

  it('everything read and empty: the empty states, and no banner', () => {
    const html = shell(base({ ...ALL_OK }));
    expect(html).toContain(t('displayGrid.noBirthdaysThisWeek'));
    expect(html).toContain(t('displayGrid.noPinnedNotes'));
    expect(html).not.toContain(t('displayGrid.dataUnavailable'));
  });
});
