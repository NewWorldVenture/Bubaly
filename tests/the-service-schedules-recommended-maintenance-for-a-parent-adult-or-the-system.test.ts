// The service version of "Schedule recommended maintenance" checked no role.
//
// `scheduleRecommendedTasks` (lib/services/home) is the service twin of the
// Maintenance page's action, written so the assistant and the button produce
// identical rows. The action refuses anyone but a parent or adult (the Home
// page's "Add task" rule); the service refused nobody, and `maintenance_tasks`
// takes any member's insert (0004). No tool calls it yet, so the first one
// wired to it would have let a child, teen, caregiver or guest add a year of
// recurring tasks. It now answers `denied` to them before reading anything,
// and still serves a parent, an adult and the system.
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { SERVICE_CODES } from '@/lib/services/types';
import { scheduleRecommendedTasks } from '@/lib/services/home';
import { DEFAULT_CADENCES } from '@/lib/home/maintenance';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

type DB = SupabaseClient<Database>;

function household(): { db: InMemorySupabase; reads: string[] } {
  const db = createInMemorySupabase<DB>();
  db.seed('home_assets', [{ id: 'furnace', family_id: 'fam-1', name: 'Furnace', category: 'furnace', last_serviced_on: '2026-01-10' }]);
  const reads: string[] = [];
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation((table: string) => { reads.push(table); return from(table); });
  return { db, reads };
}

function scope(db: InMemorySupabase, role: ServiceScope['role']): ServiceScope {
  return {
    db: db as unknown as DB, familyId: 'fam-1', userId: 'auth-1', memberId: role === 'system' ? null : 'member-1',
    role, actorKind: role === 'system' ? 'system' : 'member', tz: 'America/New_York', now: new Date('2026-10-26T12:00:00Z'),
  } as ServiceScope;
}

describe('scheduleRecommendedTasks', () => {
  for (const role of ['child', 'teen', 'caregiver', 'guest'] as const) {
    it(`refuses a ${role}, with nothing read or written`, async () => {
      const { db, reads } = household();

      const res = await scheduleRecommendedTasks(scope(db, role), 'furnace');

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe(SERVICE_CODES.denied);
      expect(res.error).toBe('Only a parent or adult can schedule home maintenance.');
      expect(reads).toEqual([]);
      expect(db.table('maintenance_tasks')).toHaveLength(0);
    });
  }

  for (const role of ['parent', 'adult', 'system'] as const) {
    it(`schedules for a ${role}`, async () => {
      const { db } = household();

      const res = await scheduleRecommendedTasks(scope(db, role), 'furnace');

      expect(res.ok).toBe(true);
      expect(db.table('maintenance_tasks')).toHaveLength(DEFAULT_CADENCES.furnace.length);
    });
  }
});
