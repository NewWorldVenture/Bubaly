// Anyone in the family could schedule the household's recurring maintenance.
//
// The Home page shows "Add task" to a parent or adult only. The Maintenance
// page's "Schedule recommended maintenance" button showed to every member, and
// `scheduleRecommendedTasksAction` (app/(app)/dashboard/home/actions.ts)
// checked no role, while `maintenance_tasks` takes any member's insert (0004).
// So a child, a teen, a caregiver or a guest could add a year of recurring
// tasks to the family's list. The action now refuses whoever "Add task" is
// hidden from, before it reads or writes anything.
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { getMessages, SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { DEFAULT_CADENCES } from '@/lib/home/maintenance';

const boundary = vi.hoisted(() => ({ auth: vi.fn(), client: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: () => boundary.auth() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: () => boundary.client() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params) };
});
const { scheduleRecommendedTasksAction } = await import('@/app/(app)/dashboard/home/actions');

type DB = SupabaseClient<Database>;
const KEY = 'actions.onlyAParentOrAdultCanScheduleMaintenance';

function household(role: string): { db: InMemorySupabase; reads: string[] } {
  const db = createInMemorySupabase<DB>();
  db.seed('home_assets', [{ id: 'furnace', family_id: 'fam-1', name: 'Furnace', category: 'furnace', last_serviced_on: '2026-01-10' }]);
  const reads: string[] = [];
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation((table: string) => { reads.push(table); return from(table); });
  boundary.client.mockResolvedValue(db);
  boundary.auth.mockResolvedValue({ user: { id: `auth-${role}` }, active: { familyId: 'fam-1', role, family: { timezone: 'America/New_York' } } });
  return { db, reads };
}

describe('Schedule recommended maintenance', () => {
  for (const role of ['child', 'teen', 'caregiver', 'guest']) {
    it(`is refused to a ${role}, with nothing read or written`, async () => {
      const { db, reads } = household(role);

      const res = await scheduleRecommendedTasksAction('furnace');

      expect(res).toEqual({ ok: false, created: 0, error: (SOURCE_MESSAGES as Record<string, string>)[KEY] });
      expect(reads).toEqual([]);
      expect(db.table('maintenance_tasks')).toHaveLength(0);
    });
  }

  for (const role of ['parent', 'adult']) {
    it(`schedules for a ${role}`, async () => {
      const { db } = household(role);

      const res = await scheduleRecommendedTasksAction('furnace');

      expect(res).toEqual({ ok: true, created: DEFAULT_CADENCES.furnace.length });
      expect(db.table('maintenance_tasks')).toHaveLength(DEFAULT_CADENCES.furnace.length);
    });
  }

  it('says so in every base language', () => {
    const english = (SOURCE_MESSAGES as Record<string, string>)[KEY];
    expect(english).toBe('Only a parent or adult can schedule home maintenance.');
    for (const locale of ['de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const) {
      const text = (getMessages(locale) as Record<string, string>)[KEY];
      expect(text, locale).toBeTruthy();
      expect(text, locale).not.toBe(english);
    }
  });
});
