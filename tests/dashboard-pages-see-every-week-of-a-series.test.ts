import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ReactNode, isValidElement } from 'react';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * THE DASHBOARD PAGES SEE EVERY WEEK OF A SERIES.
 *
 * Eight server pages read `calendar_events` by `starts_at` — a series' FIRST
 * start — over their window: the agents' week, the command center's week and
 * its "events remaining today", the conflicts resolver's fortnight, the
 * memories page's next three things, the moments page's next holiday, the
 * outcomes page's count of today, the planning hub's next four and their
 * count, and the profile's "events this week". A weekly lesson created in
 * August was on none of them from September. All eight read through
 * `readCalendarOccurrences` now (lib/calendar/occurrences.ts).
 *
 * Three are rendered here over the in-memory Supabase and inspected by the
 * props they hand their client components; the rest are pinned to the read.
 */

const ROOT = join(__dirname, '..');
const FAMILY = '00000000-0000-4000-8000-00000000fa04';
const PARENT = '00000000-0000-4000-8000-00000000ad04';
const PARENT_USER = '00000000-0000-4000-8000-00000000aa04';
const KID = '00000000-0000-4000-8000-00000000c1d4';
const PIANO = '00000000-0000-4000-8000-0000000000a1';
const TEAM_PHOTO = '00000000-0000-4000-8000-0000000000a2';
const TZ = 'America/New_York';
/** Tuesday 22 September 2026, 12:00 in New York — the lesson is this afternoon. */
const NOW = new Date('2026-09-22T16:00:00.000Z');

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/supabase/auth', () => {
  const ctx = {
    user: { id: '00000000-0000-4000-8000-00000000aa04', email: 'dana@example.test' },
    active: {
      familyId: '00000000-0000-4000-8000-00000000fa04', role: 'parent',
      member: { id: '00000000-0000-4000-8000-00000000ad04', role: 'parent', display_name: 'Dana' },
      family: { id: '00000000-0000-4000-8000-00000000fa04', timezone: 'America/New_York' },
    },
  };
  return { requireUserContext: async () => ctx, requireFeature: async () => ctx, effectivePlanLevel: async () => 2 };
});
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate, getMessages } = await import('@/lib/i18n/messages');
  const { DEFAULT_LOCALE, localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
    getLocaleContext: async () => ({ locale: localeOrDefault(DEFAULT_LOCALE), source: 'default', messages: getMessages(DEFAULT_LOCALE) }),
  };
});
vi.mock('@/lib/home/completed', () => ({ loadCompletedByBubaly: async () => ({ ok: true, data: [] }) }));
vi.mock('@/lib/services/approvals', () => ({ listPending: async () => ({ ok: true, data: [] }) }));
vi.mock('@/lib/schedule/intelligence-server', () => ({ loadScheduleIntelligence: async () => ({ ok: true, data: { byEvent: {} } }) }));
vi.mock('@/lib/metric/time-saved-server', () => ({ loadTimeSaved: async () => ({ show: false }) }));
vi.mock('@/lib/operating-index/server', () => ({ loadOperatingIndex: async () => ({ change: null }) }));

const { default: CommandCenter } = await import('@/app/(app)/dashboard/command-center/page');
const { default: Conflicts } = await import('@/app/(app)/dashboard/conflicts/page');
const { default: Profile } = await import('@/app/(app)/dashboard/profile/page');
const { OutcomesStrip } = await import('@/components/outcomes/outcomes-strip');
const { ConflictResolver } = await import('@/components/family/conflict-resolver');
const { ProfileModule } = await import('@/components/modules/profile-module');

/** The props of the first element of `type` in a rendered tree. */
function propsOf<P>(node: ReactNode, type: unknown): P | null {
  if (Array.isArray(node)) return node.map((child) => propsOf<P>(child, type)).find(Boolean) ?? null;
  if (!isValidElement<P & { children?: ReactNode }>(node)) return null;
  if (node.type === type) return node.props;
  return propsOf<P>(node.props.children, type);
}

const event = (row: Record<string, unknown>) => ({
  family_id: FAMILY, description: null, location: null, category: 'general', all_day: false,
  recurrence: 'none', recurrence_until: null, assignee_id: KID, feed_id: null, external_uid: null,
  created_by: PARENT_USER, onboarding_key: null, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
  ...row,
});

let db: InMemorySupabase;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  holder.db = db;
  db.seed('families', [{ id: FAMILY, timezone: TZ }]);
  db.seed('family_members', [
    { id: PARENT, family_id: FAMILY, user_id: PARENT_USER, display_name: 'Dana', role: 'parent', is_active: true, color: null, birthday: null },
    { id: KID, family_id: FAMILY, user_id: null, display_name: 'Sam', role: 'child', is_active: true, color: null, birthday: null },
  ]);
  // Tuesday 25 August, 16:00–17:00 EDT, weekly, open-ended: four weeks before today.
  db.seed('calendar_events', [
    event({ id: PIANO, title: 'Piano', starts_at: '2026-08-25T20:00:00.000Z', ends_at: '2026-08-25T21:00:00.000Z', recurrence: 'weekly' }),
    // Today 16:30–17:30 EDT: booked over the lesson.
    event({ id: TEAM_PHOTO, title: 'Team photo', starts_at: '2026-09-22T20:30:00.000Z', ends_at: '2026-09-22T21:30:00.000Z' }),
  ]);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('the conflicts resolver', () => {
  it('shows the photo booked over this week\'s lesson, four weeks into the series', async () => {
    const props = propsOf<{ conflicts: { a: { title: string; id: string }; b: { title: string; id: string } }[] }>(await Conflicts(), ConflictResolver);
    expect(props).toBeTruthy();
    expect(props!.conflicts.map((c) => [c.a.id, c.b.id].sort())).toEqual([[PIANO, TEAM_PHOTO].sort()]);
  });

  it('control: without the series there is nothing to resolve', async () => {
    db.replace('calendar_events', db.table('calendar_events').filter((row) => row.id !== PIANO));
    const props = propsOf<{ conflicts: unknown[] }>(await Conflicts(), ConflictResolver);
    expect(props?.conflicts ?? []).toEqual([]);
  });
});

describe('the command center', () => {
  it('counts the lesson among today\'s remaining events', async () => {
    const snapshot = propsOf<{ snapshot: { eventsRemaining: number | null } }>(await CommandCenter(), OutcomesStrip)?.snapshot;
    // The lesson at 16:00 and the photo at 16:30 are both still ahead at noon.
    expect(snapshot?.eventsRemaining).toBe(2);
  });
});

describe('the profile', () => {
  it('counts the lesson in the child\'s week', async () => {
    // The acting member is Dana; give her the lesson and the photo.
    db.replace('calendar_events', db.table('calendar_events').map((row) => ({ ...row, assignee_id: PARENT })));
    const stats = propsOf<{ stats: { upcoming7d: number } }>(await Profile(), ProfileModule)?.stats;
    expect(stats?.upcoming7d).toBe(2);
  });
});

describe('every page reads through the shared read (source pins)', () => {
  const PAGES = ['agents', 'command-center', 'conflicts', 'memories', 'moments', 'outcomes', 'planning', 'profile'];
  it.each(PAGES)('app/(app)/dashboard/%s/page.tsx', (page) => {
    const src = readFileSync(join(ROOT, `app/(app)/dashboard/${page}/page.tsx`), 'utf8');
    expect(src).toContain('readCalendarOccurrences(');
    expect(src).not.toContain(".from('calendar_events')");
  });
});
