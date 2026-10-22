// S2 / S15 — prep-plan generation published Secure Vault and sensitive
// document titles to every member.
//
// runPrepGeneration read every document expiring in the next 60 days — on the
// SERVICE client in the model-refresh cron, and on a manager's session (which
// documents_select lets see the Vault) from "Generate plans" — and wrote each
// one's title into `prep_plans.title` as "Renew: <title>". `prep_plans` reads
// with is_family_member (0131) for every role, guests included, and
// /dashboard/prep-plans prints the title. So a child read "Renew: Dad's green
// card" and "Renew: Custody order" — titles documents_select (0266/0312) hides
// from them, and lib/services/documents keeps off every family-readable feed.
//
// Driven through the real "Generate plans" action and the cron's own call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAM = 'family-1';
const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'parent-user' },
    active: { familyId: 'family-1', role: 'parent', member: { id: 'm-dad' }, family: { timezone: 'America/Chicago' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));

const { generatePrepPlansAction } = await import('@/app/(app)/dashboard/prep-plans/prep-actions');
const { runPrepGeneration } = await import('@/lib/planning/prep-server');

// The family's today in Chicago is 2026-10-13 at this instant.
const NOW = new Date('2026-10-13T15:00:00Z');

function household(): InMemorySupabase {
  const db = createInMemorySupabase({
    uniques: { prep_plans: [['family_id', 'signal_kind', 'signal_id']], prep_plan_steps: [['family_id', 'plan_id', 'label']] },
    defaults: { prep_plans: { status: 'active' } },
  });
  db.seed('documents', [
    // The Secure Vault, whatever its folder.
    { id: 'd-green', family_id: FAM, title: "Dad's green card", category: 'Kids Activities', is_secure: true, expires_at: '2026-11-01' },
    // A sensitive category, not flagged secure.
    { id: 'd-custody', family_id: FAM, title: 'Custody order', category: 'Legal', is_secure: false, expires_at: '2026-11-20' },
    // An ordinary document, which keeps its name.
    { id: 'd-library', family_id: FAM, title: 'Library card', category: 'Kids Activities', is_secure: false, expires_at: '2026-10-30' },
  ]);
  return db;
}

/** Every title a member reads off /dashboard/prep-plans (and over REST, dismissed or not). */
const titles = (db: InMemorySupabase) => db.table('prep_plans').map((row) => String(row.title));

let db: InMemorySupabase;
beforeEach(() => {
  db = household();
  h.db = db;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a sensitive document is planned without its title', () => {
  it('"Generate plans" names the vault and the legal document generically, and the library card by name', async () => {
    const res = await generatePrepPlansAction();
    expect(res.ok, res.error).toBe(true);

    const all = titles(db).join('\n');
    expect(all).not.toContain('green card');
    expect(all).not.toContain('Custody');
    expect(titles(db)).toContain('Renew: Library card');
    expect(titles(db).filter((title) => title === 'Renew: Private document')).toHaveLength(2);
    // The plan is still made: the family is still told something expires, and when.
    expect(db.table('prep_plans').find((row) => row.signal_id === 'd-custody')?.target_date).toBe('2026-11-20');
  });

  it('the cron renames a plan an earlier run titled after a sensitive document, even one the family dismissed', async () => {
    db.seed('prep_plans', [
      { id: 'p-green', family_id: FAM, signal_kind: 'doc_expiry', signal_id: 'd-green', title: "Renew: Dad's green card", target_date: '2026-11-01', urgency: 'soon', status: 'active' },
      { id: 'p-custody', family_id: FAM, signal_kind: 'doc_expiry', signal_id: 'd-custody', title: 'Renew: Custody order', target_date: '2026-11-20', urgency: 'later', status: 'dismissed' },
    ]);

    const res = await runPrepGeneration(db as unknown as SupabaseClient<Database>, FAM, null, 'America/Chicago', NOW);
    expect(res.ok, res.error).toBe(true);

    const all = titles(db).join('\n');
    expect(all).not.toContain('green card');
    expect(all).not.toContain('Custody');
    // The family's decision is not undone by the rename.
    expect(db.table('prep_plans').find((row) => row.id === 'p-custody')?.status).toBe('dismissed');
  });
});
