// Magic Import phase 2 asks the shared AI gate before writing each confirmed
// item. It named the agent and the caller's role but not the member Bubaly was
// importing FOR, so an item held for approval was filed with no requester:
// identical imports from two members merged into one card, and the approved
// write was attributed to the parent who approved it rather than the child
// who imported it. Chat and the school desk already passed the member.
//
// Driven through the real route, the real gate and the real approval replay.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const hoisted = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => hoisted.db, createServer: async () => hoisted.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: CHILD.user },
    active: { familyId: FAMILY, role: 'child', member: { id: CHILD.member }, family: { name: 'The Riveras', timezone: 'America/New_York' } },
  }),
}));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/provider', async (original) => ({ ...await original<typeof import('@/lib/ai/provider')>(), isAIConfigured: async () => true }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: () => {}, continueRun: async () => ({ claimed: false }) }));

const FAMILY = '00000000-0000-4000-8000-0000000c0c01';
const PARENT = { member: '00000000-0000-4000-8000-0000000c1c01', user: '00000000-0000-4000-8000-0000000c2c01' };
const CHILD = { member: '00000000-0000-4000-8000-0000000c1c02', user: '00000000-0000-4000-8000-0000000c2c02' };

let db: InMemorySupabase;

beforeEach(() => {
  db = createInMemorySupabase({
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
    defaults: {
      approval_requests: { status: 'pending', approvals: [], edited_payload: null, plan_step_ids: [], run_id: null, request_id: null, plan_step_id: null, payload_kind: null },
      ai_tool_calls: { state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null },
      family_reminders: { is_done: false, snoozed_until: null, notes: null, recurrence: 'none' },
    },
  });
  hoisted.db = db;
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' }]);
  db.seed('family_members', [
    { id: PARENT.member, family_id: FAMILY, user_id: PARENT.user, role: 'parent', is_active: true, display_name: 'Dana' },
    { id: CHILD.member, family_id: FAMILY, user_id: CHILD.user, role: 'child', is_active: true, display_name: 'Maya' },
  ]);
  // "Prepare" for scheduling: an imported reminder waits for a yes.
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'execute', category_behavior: { scheduling: 'prepare' } }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

async function confirmImport() {
  const { POST } = await import('@/app/api/ai/import/route');
  return POST(new NextRequest('https://bubaly.example/api/ai/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: [{ name: 'create_reminder', args: { title: 'Return the library books', remind_at: '2026-09-10T15:00:00Z' }, summary: 'Return the library books' }] }),
  }));
}

describe('a Magic Import item held for approval says who imported it', () => {
  it('files the approval for the member who imported, and the approved reminder is theirs', async () => {
    const res = await confirmImport();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: 0, queued: 1 });

    const [row] = db.table('approval_requests');
    expect(row).toMatchObject({ requested_by_kind: 'ai', requested_by_member_id: CHILD.member, agent: 'Magic Import' });
    expect(db.table('family_reminders')).toEqual([]);

    const { decide } = await import('@/lib/services/approvals');
    const parent: ServiceScope = {
      db: db as unknown as SupabaseClient<Database>, familyId: FAMILY, userId: PARENT.user, memberId: PARENT.member,
      role: 'parent', actorKind: 'member', tz: 'America/New_York',
    };
    const decided = await decide(parent, String(row.id), 'approved');
    expect(decided.ok, decided.ok ? '' : decided.error).toBe(true);

    const [reminder] = db.table('family_reminders');
    expect(reminder).toMatchObject({ family_id: FAMILY, title: 'Return the library books' });
    // The child who imported it, not the parent who said yes.
    expect(reminder.created_by).toBe(CHILD.user);
  });
});
