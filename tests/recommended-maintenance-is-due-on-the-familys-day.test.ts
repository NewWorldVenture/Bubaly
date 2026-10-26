// "Schedule recommended maintenance" dated every task a day early west of Greenwich.
//
// `scheduleRecommendedTasksAction` (app/(app)/dashboard/home/actions.ts) based
// each due date on `new Date(asset.last_serviced_on)`: a DATE read as UTC
// midnight. A furnace filter changed on 10 January with a 90-day cadence was
// due 2026-04-10T00:00Z, which is the evening of 9 April in Los Angeles, so
// the task showed and went overdue a day early. The service version the
// assistant uses (`scheduleRecommendedTasks`, lib/services/home) bases the
// date on noon UTC, and promises the button and the assistant produce
// identical rows. Now they do.
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { addDaysToDayKey } from '@/lib/services/scope';
import { dayKeyIn } from '@/lib/time/zoned';
import { DEFAULT_CADENCES } from '@/lib/home/maintenance';

const boundary = vi.hoisted(() => ({ auth: vi.fn(), client: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: () => boundary.auth() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: () => boundary.client() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
const { scheduleRecommendedTasksAction } = await import('@/app/(app)/dashboard/home/actions');
const { scheduleRecommendedTasks } = await import('@/lib/services/home');

type DB = SupabaseClient<Database>;
const FAMILY = 'fam-1';
const SERVICED = '2026-01-10';

function household(): InMemorySupabase {
  const db = createInMemorySupabase<DB>();
  db.seed('home_assets', [{ id: 'furnace', family_id: FAMILY, name: 'Furnace', category: 'furnace', last_serviced_on: SERVICED }]);
  return db;
}

function signedIn(db: InMemorySupabase, timezone: string) {
  boundary.client.mockResolvedValue(db);
  boundary.auth.mockResolvedValue({
    user: { id: 'auth-parent' },
    active: { familyId: FAMILY, role: 'parent', family: { timezone } },
  });
}

const rows = (db: InMemorySupabase) => db.table('maintenance_tasks')
  .map((t) => ({ title: String(t.title), interval_days: Number(t.interval_days), due_at: String(t.due_at) }))
  .sort((a, b) => a.title.localeCompare(b.title));

describe('recommended maintenance from the Maintenance page', () => {
  for (const timezone of ['America/Los_Angeles', 'America/New_York', 'Europe/Berlin']) {
    it(`falls due on the family's day, interval days after the last service (${timezone})`, async () => {
      const db = household();
      signedIn(db, timezone);

      const res = await scheduleRecommendedTasksAction('furnace');

      expect(res).toEqual({ ok: true, created: DEFAULT_CADENCES.furnace.length });
      const created = rows(db);
      expect(created).toHaveLength(DEFAULT_CADENCES.furnace.length);
      for (const task of created) {
        expect(dayKeyIn(new Date(task.due_at), timezone)).toBe(addDaysToDayKey(SERVICED, task.interval_days));
      }
    });
  }

  it('writes the rows the assistant writes for the same asset', async () => {
    const fromButton = household();
    signedIn(fromButton, 'America/Los_Angeles');
    await scheduleRecommendedTasksAction('furnace');

    const fromAssistant = household();
    const res = await scheduleRecommendedTasks({
      db: fromAssistant as unknown as DB, familyId: FAMILY, userId: 'auth-parent', memberId: 'm-parent',
      role: 'parent', actorKind: 'member', tz: 'America/Los_Angeles', now: new Date('2026-10-26T12:00:00Z'),
    }, 'furnace');

    expect(res.ok).toBe(true);
    expect(rows(fromButton)).toEqual(rows(fromAssistant));
  });
});
