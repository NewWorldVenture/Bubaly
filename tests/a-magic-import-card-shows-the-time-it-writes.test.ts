// Magic Import's summary is two things at once: the line the family reads in
// the confirm list, and — sent back in phase 2 — the title of any approval card
// the import files. It must therefore name the time the import WRITES.
//
// The model writes a time the way the family said it, with no offset
// ("2026-10-16T17:00:00" for "Friday at 5"). The write reads that on the
// family's clock (tasks.createChore and reminders.create resolve a zone-less
// reading through `familyInstant`), but the summary read it with `new Date()`,
// on the HOST's clock: on a UTC host a Los Angeles family confirmed "10:00 AM"
// and got 5 PM. The prompt also never named the family's zone, so the model was
// left to guess which clock "5pm" was on.
//
// Driven through the real route, both phases, with only the model replaced.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = '00000000-0000-4000-8000-0000000d1001';
const PARENT = { user: '00000000-0000-4000-8000-0000000d1002', member: '00000000-0000-4000-8000-0000000d1003' };
const LA = 'America/Los_Angeles';

const hoisted = vi.hoisted(() => ({
  db: null as unknown,
  seen: [] as { system: string }[],
  toolCalls: [] as { name: string; args: Record<string, unknown> }[],
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => hoisted.db, createServer: async () => hoisted.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: PARENT.user },
    active: { familyId: FAMILY, role: 'parent', member: { id: PARENT.member }, family: { name: 'The Hughens', timezone: LA } },
  }),
}));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: () => {}, continueRun: async () => ({ claimed: false }) }));
vi.mock('@/lib/ai/provider', async (original) => ({
  ...await original<typeof import('@/lib/ai/provider')>(),
  isAIConfigured: async () => true,
  resolveProvider: async () => ({
    id: 'fake', model: 'fake-model',
    complete: async (input: { system: string }) => {
      hoisted.seen.push({ system: input.system });
      return { text: '', toolCalls: hoisted.toolCalls, model: 'fake-model', usage: null };
    },
  }),
}));

let db: InMemorySupabase;

beforeEach(() => {
  db = createInMemorySupabase({
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
    defaults: {
      approval_requests: { status: 'pending', approvals: [], edited_payload: null, plan_step_ids: [], run_id: null, request_id: null, plan_step_id: null, payload_kind: null },
      ai_tool_calls: { state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null },
      family_reminders: { status: 'active', snoozed_until: null, member_id: null, idempotency_key: null, priority: 'medium', recurrence: 'none', kind: 'time' },
      chores: { description: null, points: 10, priority: 'medium', recurrence: 'none', due_at: null, requires_approval: true, icon: null, is_active: true },
      chore_assignments: { status: 'todo', due_at: null, idempotency_key: null },
    },
  });
  hoisted.db = db;
  hoisted.seen = [];
  // "Friday at 5" as the model writes it: the family's wall clock, no offset.
  hoisted.toolCalls = [
    { name: 'create_chore', args: { title: 'Bins out', due_at: '2026-10-16T17:00:00' } },
    { name: 'create_reminder', args: { title: 'Call the plumber', remind_at: '2026-10-16T17:00:00' } },
  ];
  db.seed('families', [{ id: FAMILY, name: 'The Hughens', timezone: LA }]);
  db.seed('family_members', [{ id: PARENT.member, family_id: FAMILY, user_id: PARENT.user, role: 'parent', is_active: true, display_name: 'Dana' }]);
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'execute', category_behavior: {}, risk_overrides: {}, child_channels: {}, memory_enabled: true }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

async function post(body: unknown): Promise<Response> {
  const { POST } = await import('@/app/api/ai/import/route');
  return POST(new NextRequest('https://bubaly.example/api/ai/import', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
}

type Item = { name: string; args: Record<string, unknown>; summary: string };

describe('the Magic Import card names the time the import writes', () => {
  it('shows 5:00 PM for a Los Angeles "Friday at 5", and stores 5 PM there (00:00Z on the 17th)', async () => {
    const extracted = await post({ text: 'Put the bins out and call the plumber, Friday at 5.' });
    expect(extracted.status).toBe(200);
    const { items } = await extracted.json() as { items: Item[] };
    const proposed = items.filter((item) => item.name === 'create_chore' || item.name === 'create_reminder');
    expect(proposed.map((item) => item.summary)).toEqual([
      '✅ Chore: “Bins out” (Oct 16, 5:00 PM)',
      '⏰ Reminder: “Call the plumber” (Oct 16, 5:00 PM)',
    ]);

    // Phase 2 is the confirm list sent back as the family saw it.
    const confirmed = await post({ confirm: proposed });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ created: 2, queued: 0 });
    expect(db.table('chores').map((c) => [c.title, c.due_at])).toEqual([['Bins out', '2026-10-17T00:00:00.000Z']]);
    expect(db.table('family_reminders').map((r) => [r.title, r.remind_at])).toEqual([['Call the plumber', '2026-10-17T00:00:00.000Z']]);
  });

  it('keeps a bare date the date it says', async () => {
    hoisted.toolCalls = [{ name: 'create_chore', args: { title: 'Bins out', due_at: '2026-10-16' } }];
    const extracted = await post({ text: 'Bins out on the 16th.' });
    const { items } = await extracted.json() as { items: Item[] };
    expect(items.filter((item) => item.name === 'create_chore').map((item) => item.summary)).toEqual(['✅ Chore: “Bins out” (Oct 16)']);
  });

  it('tells the model which clock the family’s times are on, and to write them without an offset', async () => {
    await post({ text: 'Bins out Friday at 5.' });
    expect(hoisted.seen).toHaveLength(1);
    expect(hoisted.seen[0].system).toContain(`Times are the family's local time in ${LA}, written without an offset`);
  });
});
