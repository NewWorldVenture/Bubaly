// "Export my family's data" says when a section is a date window (N8).
//
// The calendar, school and sports sections are read between a year before and
// a year after today. A weekly series started fourteen months ago (stored once,
// at its first week), and every event older than a year, were simply not in
// the file — and the section said `truncated: false`, on a file the Privacy
// Center tells a family they may delete their account on the strength of.
//
// Driven through the real export builder and the real services against an
// in-memory database.
import { describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import type { ServiceScope } from '@/lib/services/types';

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => null }));
const { buildFamilyExport } = await import('@/lib/privacy/export');

const FAMILY = 'fam-1';
const NOW = new Date('2026-10-14T12:00:00.000Z');

function household(): InMemorySupabase {
  const db = createInMemorySupabase({ userId: 'user-parent' });
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' }]);
  db.seed('family_members', [
    { id: 'mem-parent', family_id: FAMILY, user_id: 'user-parent', display_name: 'Jordan', role: 'parent', is_active: true, birthday: null, color: 'teal', avatar_url: null },
  ]);
  return db;
}
const scopeFor = (db: InMemorySupabase): ServiceScope => ({
  db: db as unknown as ServiceScope['db'], familyId: FAMILY, userId: 'user-parent', memberId: 'mem-parent',
  role: 'parent', actorKind: 'member', tz: 'America/New_York', now: NOW,
});
const calendar = (id: string, starts_at: string, extra: Record<string, unknown> = {}) => ({
  id, family_id: FAMILY, title: id, description: null, location: null, category: 'general', starts_at,
  ends_at: null, all_day: false, recurrence: 'none', recurrence_until: null, assignee_id: null,
  feed_id: null, external_uid: null, created_at: starts_at, updated_at: starts_at, ...extra,
});
async function section(db: InMemorySupabase, key: string) {
  const built = await buildFamilyExport(scopeFor(db));
  expect(built.ok, built.ok ? '' : JSON.stringify(built.failed)).toBe(true);
  if (!built.ok) throw new Error('export failed');
  const found = built.data.sections.find((s) => s.key === key);
  expect(found).toBeDefined();
  return found!;
}

describe('a dated export section is honest about its window', () => {
  it('calendar: a series started fourteen months ago marks the section truncated and names the window', async () => {
    const db = household();
    db.seed('calendar_events', [
      calendar('this-week', '2026-10-15T19:00:00.000Z'),
      calendar('weekly-since-august-2025', '2025-08-05T22:00:00.000Z', { recurrence: 'weekly' }),
    ]);
    const s = await section(db, 'calendar');
    expect(s.count).toBe(1);
    expect(s.truncated).toBe(true);
    expect(s.window).toEqual({ from: '2025-10-14', to: '2027-10-14' });
  });

  it('calendar: everything inside the window is complete and says so', async () => {
    const db = household();
    db.seed('calendar_events', [calendar('this-week', '2026-10-15T19:00:00.000Z'), calendar('last-spring', '2026-04-01T15:00:00.000Z')]);
    const s = await section(db, 'calendar');
    expect(s).toMatchObject({ count: 2, truncated: false, window: { from: '2025-10-14', to: '2027-10-14' } });
  });

  it('school: an event older than a year marks the section truncated', async () => {
    const db = household();
    db.seed('school_events', [
      { id: 'sch-now', family_id: FAMILY, member_id: null, title: 'Conference', starts_at: '2026-10-20T22:00:00.000Z', ends_at: null },
      { id: 'sch-old', family_id: FAMILY, member_id: null, title: 'Old play', starts_at: '2025-03-01T22:00:00.000Z', ends_at: null },
    ]);
    const s = await section(db, 'school');
    expect(s.truncated).toBe(true);
    expect(s.window).toEqual({ from: '2025-10-14', to: '2027-10-14' });
  });

  it('sports: a one-off older than a year marks the section truncated; a running series does not', async () => {
    const db = household();
    db.seed('sports_events', [
      { id: 'sp-series', family_id: FAMILY, member_id: null, title: 'Practice', event_type: 'practice', starts_at: '2025-01-07T22:00:00.000Z', ends_at: null, recurrence: 'weekly', recurrence_until: null },
    ]);
    expect((await section(db, 'sports')).truncated).toBe(false);
    db.seed('sports_events', [
      { id: 'sp-old', family_id: FAMILY, member_id: null, title: 'Old game', event_type: 'game', starts_at: '2025-05-01T22:00:00.000Z', ends_at: null, recurrence: 'none', recurrence_until: null },
    ]);
    expect((await section(db, 'sports')).truncated).toBe(true);
  });
});
