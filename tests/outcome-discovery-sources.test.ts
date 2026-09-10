import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ReactNode, isValidElement } from 'react';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import type { DiscoverySnapshot } from '@/lib/outcomes/discovery';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/supabase/auth', () => {
  const ctx = { user: { id: 'me' }, active: { familyId: 'ours', role: 'child', member: { id: 'member', role: 'child', display_name: 'Sam' }, family: { timezone: 'America/New_York' } } };
  return { requireUserContext: async () => ctx, requireFeature: async () => ctx };
});
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/home/completed', () => ({ loadCompletedByBubaly: async () => ({ ok: true, data: [] }) }));
vi.mock('@/lib/services/approvals', () => ({ listPending: async () => ({ ok: true, data: [] }) }));
vi.mock('@/lib/schedule/intelligence-server', () => ({ loadScheduleIntelligence: async () => ({ ok: true, data: { byEvent: {} } }) }));
vi.mock('@/lib/metric/time-saved-server', () => ({ loadTimeSaved: async () => ({ show: false }) }));
vi.mock('@/lib/operating-index/server', () => ({ loadOperatingIndex: async () => ({ change: null }) }));
const { default: Home } = await import('@/app/(app)/home/page');
const { default: Command } = await import('@/app/(app)/dashboard/command-center/page');
const { OutcomesStrip } = await import('@/components/outcomes/outcomes-strip');
let db: InMemorySupabase;
function snapshot(node: ReactNode): DiscoverySnapshot | null {
  if (Array.isArray(node)) return node.map(snapshot).find(Boolean) ?? null;
  if (!isValidElement<{ snapshot?: DiscoverySnapshot; children?: ReactNode }>(node)) return null;
  if (node.type === OutcomesStrip) return node.props.snapshot ?? null;
  return snapshot(node.props.children);
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-09T16:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase(); holder.db = db;
  db.seed('family_members', [{ id: 'member', family_id: 'ours', display_name: 'Sam', role: 'child', is_active: true, birthday: '2010-09-10', user_id: 'me' }]);
  db.seed('activation_events', [{ id: 'activated', family_id: 'ours', user_id: 'me', milestone: 'first_outcome_viewed' }]);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('page snapshots use actual family-scoped records', () => {
  it('counts the full Home day beyond its eight visible event rows and excludes another family', async () => {
    db.seed('calendar_events', Array.from({ length: 10 }, (_, i) => ({ id: `event-${i}`, family_id: 'ours', title: 'Class', starts_at: '2026-09-09T17:00:00Z', ends_at: '2026-09-09T18:00:00Z' })));
    db.seed('calendar_events', [{ id: 'foreign', family_id: 'theirs', title: 'Private', starts_at: '2026-09-09T17:00:00Z' }]);
    db.seed('todo_items', [{ id: 'todo', family_id: 'ours', title: 'Form', is_done: false, due_date: '2026-09-08' }]);
    db.seed('grocery_items', [{ id: 'milk', family_id: 'ours', is_checked: false }, { id: 'foreign', family_id: 'theirs', is_checked: false }]);
    expect(snapshot(await Home())).toEqual({ eventsToday: 10, overdueTasks: 1, openGrocery: 1, birthdaysSoon: 1 });
  });

  it('treats a capped roster as unknown instead of claiming it counted all birthdays', async () => {
    db.seed('family_members', Array.from({ length: 12 }, (_, i) => ({ id: `member-${i}`, family_id: 'ours', display_name: 'Member', role: 'adult', is_active: true, birthday: '2000-09-10' })));
    expect(snapshot(await Home())?.birthdaysSoon).toBeNull();
    expect(console.error).toHaveBeenCalledWith('[home] outcome discovery read failed or incomplete', expect.any(Object));
  });

  it('uses Command Center chores, unplanned dinners and expiring documents as separate evidence', async () => {
    db.seed('chore_assignments', [{ id: 'overdue', family_id: 'ours', status: 'todo', due_at: '2026-09-08T10:00:00Z' }]);
    db.seed('meal_plans', [{ family_id: 'ours', meal_type: 'dinner', plan_date: '2026-09-09' }]);
    db.seed('documents', [{ id: 'passport', family_id: 'ours', title: 'Passport', expires_at: '2026-09-15T10:00:00Z' }]);
    db.seed('calendar_events', [{ id: 'later', family_id: 'ours', title: 'Class', starts_at: '2026-09-09T23:00:00Z', all_day: false }]);
    expect(snapshot(await Command())).toEqual({ eventsRemaining: 1, overdueChores: 1, unplannedDinners: 6, expiringDocuments: 1 });
  });

  it('keeps tonight’s dinner and remaining events inside the family day after UTC midnight', async () => {
    vi.setSystemTime(new Date('2026-09-10T02:00:00Z'));
    db.seed('meal_plans', [{ family_id: 'ours', meal_type: 'dinner', plan_date: '2026-09-09' }]);
    db.seed('calendar_events', [{ id: 'tonight', family_id: 'ours', title: 'Late event', starts_at: '2026-09-10T03:00:00Z', all_day: false }]);
    expect(snapshot(await Command())).toMatchObject({ eventsRemaining: 1, unplannedDinners: 6 });
  });
});
