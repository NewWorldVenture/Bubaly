import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// The independence ladder's Start button (`startMilestoneAction`) wrote its
// rung with an UPSERT on (family_id, member_id, domain, title) that set
// `status: 'in_progress'` whatever the row already said. The page only offers
// Start for rungs it believes are not on the ladder, but a page is a snapshot:
// a second parent's tab opened before the child earned the badge, or a repeated
// tap that lands after "Achieved!", started the rung again and quietly took the
// child's achievement away — badge, level and progress ring with it.
//
// Now a new rung is inserted, a rung already on the ladder (skipped, or
// started elsewhere) is put back to work, and an achieved rung is left alone
// with an answer that says so instead of "Added to the ladder".

const FAMILY = 'family-one';
const AVA = 'member-ava';
const TITLE = 'Packs their school bag';

const h = vi.hoisted(() => ({ db: null as unknown, role: 'parent', audits: [] as unknown[] }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-parent' }, active: { familyId: FAMILY, role: h.role } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async (_db: unknown, payload: unknown) => { h.audits.push(payload); } }));

import { startMilestoneAction } from '@/app/(app)/dashboard/independence/actions';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
const milestone = () => db.table('independence_milestones').filter((r) => r.member_id === AVA && r.title === TITLE);

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({
    uniques: { independence_milestones: [['family_id', 'member_id', 'domain', 'title']] },
  });
  h.db = db;
  h.role = 'parent';
  h.audits = [];
  db.seed('family_members', [{ id: AVA, family_id: FAMILY, display_name: 'Ava', role: 'child', is_active: true }]);
});

const seedRung = (status: string, extra: Record<string, unknown> = {}) => db.seed('independence_milestones', [{
  id: 'rung-1', family_id: FAMILY, member_id: AVA, domain: 'school', title: TITLE, age_band: '4-6', points: 5, status, ...extra,
}]);

describe('a restarted milestone keeps its achievement', () => {
  it('an achieved rung started again from a stale page stays achieved, and the parent is told so', async () => {
    seedRung('achieved', { achieved_at: '2026-10-01T18:00:00Z', evidence: 'Did it all week' });

    const result = await startMilestoneAction(AVA, TITLE);

    expect(result).toEqual({ ok: false, error: 'actions.milestoneAlreadyAchieved' });
    expect(milestone()).toHaveLength(1);
    expect(milestone()[0]).toMatchObject({ status: 'achieved', achieved_at: '2026-10-01T18:00:00Z', evidence: 'Did it all week' });
    expect(h.audits).toEqual([]);
  });

  it('a new rung is added to the ladder in progress', async () => {
    expect(await startMilestoneAction(AVA, TITLE)).toEqual({ ok: true });
    expect(milestone()).toHaveLength(1);
    expect(milestone()[0]).toMatchObject({ family_id: FAMILY, domain: 'school', status: 'in_progress', created_by: 'user-parent' });
    expect(h.audits).toHaveLength(1);
  });

  it('a skipped rung started again is back in progress', async () => {
    seedRung('skipped');
    expect(await startMilestoneAction(AVA, TITLE)).toEqual({ ok: true });
    expect(milestone()).toHaveLength(1);
    expect(milestone()[0].status).toBe('in_progress');
  });

  it('a repeated start of a rung in progress is still one rung in progress', async () => {
    expect(await startMilestoneAction(AVA, TITLE)).toEqual({ ok: true });
    expect(await startMilestoneAction(AVA, TITLE)).toEqual({ ok: true });
    expect(milestone()).toHaveLength(1);
    expect(milestone()[0].status).toBe('in_progress');
  });

  it('an achievement made between two starts survives the second one', async () => {
    expect(await startMilestoneAction(AVA, TITLE)).toEqual({ ok: true });
    Object.assign(milestone()[0], { status: 'achieved', achieved_at: '2026-10-02T18:00:00Z' });

    expect((await startMilestoneAction(AVA, TITLE)).ok).toBe(false);
    expect(milestone()[0]).toMatchObject({ status: 'achieved', achieved_at: '2026-10-02T18:00:00Z' });
  });
});
