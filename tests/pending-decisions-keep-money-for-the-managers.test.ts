// The assistant toolbox's `list_pending_decisions` read `parent_approvals` for
// whoever was talking, and it is not a trust-gated tool (reads pass the chat
// wrapper untouched). So a child asking "what needs me?" was handed every
// pending wallet approval in the family as "Card purchase to approve · $45",
// and the count of chores waiting on a parent's sign-off — both of which Home,
// Needs-you and the dashboard show only to a parent or adult.
//
// Driven as POST /api/ai/chat builds it: the real toolbox, wrapped by the real
// trust wrapper, over an in-memory household.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

import { buildAssistantTools } from '@/lib/assistant/tools';
import { wrapToolsWithTrust } from '@/lib/assistant/trust-wrapper';

const FAMILY = 'fam-1';
type DB = InMemorySupabase & SupabaseClient<Database>;
let db: DB;

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

async function pendingDecisionsAs(role: string): Promise<string[]> {
  const ctx = { familyId: FAMILY, userId: 'user-1', memberId: 'mem-1', role, members: [{ id: 'mem-1', display_name: 'Sam' }], tz: 'UTC' };
  const tools = wrapToolsWithTrust(buildAssistantTools(db, ctx), db, FAMILY, role, 'mem-1');
  const tool = tools.find((t) => t.name === 'list_pending_decisions');
  if (!tool) throw new Error('list_pending_decisions is not in the toolbox');
  const result = await tool.execute({}) as { ok: boolean; items?: { title: string }[]; error?: string };
  expect(result.ok, result.error).toBe(true);
  return (result.items ?? []).map((i) => i.title);
}

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>() as DB;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('parent_approvals', [
    { id: 'pa-1', family_id: FAMILY, kind: 'card_spend', amount_cents: 4500, status: 'pending', created_at: inDays(-1) },
    { id: 'pa-2', family_id: FAMILY, kind: 'withdrawal', amount_cents: 12000, status: 'pending', created_at: inDays(-1) },
  ]);
  db.seed('chore_assignments', [{ id: 'ca-1', family_id: FAMILY, status: 'submitted' }]);
  db.seed('renewals', [{ id: 'r-1', family_id: FAMILY, title: 'Car registration', expires_at: inDays(5), reminder_days: 14, status: 'active' }]);
});

describe('list_pending_decisions keeps money decisions for the people who make them', () => {
  it.each(['child', 'teen', 'caregiver', 'guest'])('a %s is not handed the money approvals or the sign-off count', async (role) => {
    const titles = await pendingDecisionsAs(role);
    expect(titles.join('\n')).not.toMatch(/\$45\b|\$120\b/);
    expect(titles.join('\n')).not.toMatch(/to approve/i);
    expect(titles.join('\n')).not.toMatch(/awaiting approval/i);
    // Nothing was even asked of the table.
    expect(db.log.some((c) => c.table === 'parent_approvals'), 'parent_approvals was read for a non-manager').toBe(false);
  });

  it('a child still sees what the dashboard shows every member, such as a renewal coming due', async () => {
    const titles = await pendingDecisionsAs('child');
    expect(titles.some((t) => t.startsWith('Renew Car registration'))).toBe(true);
  });

  it('an unknown role is not a manager', async () => {
    const titles = await pendingDecisionsAs('owner');
    expect(titles.join('\n')).not.toMatch(/to approve|\$45\b/i);
  });

  it.each(['parent', 'adult'])('a %s still gets every money approval, with its amount, and the sign-off count', async (role) => {
    const titles = await pendingDecisionsAs(role);
    // The exact titles the cases above prove a non-manager is never handed.
    expect(titles).toContain('Card purchase to approve · $45');
    expect(titles).toContain('Withdrawal to approve · $120');
    expect(titles).toContain('1 chore awaiting approval');
  });
});
