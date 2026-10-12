import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// FL-R4-R1-1. The assistant finds a reminder by part of its title — "mark the
// renew thing done", "push the e one" — in four places: reminders.complete and
// reminders.snooze (lib/ai/tools/reminders.ts findReminder), and the legacy
// complete_reminder and snooze_reminder (lib/assistant/tools.ts). Each took
// the soonest title match in the family. reminders.listDue already keeps an
// accepted Autopilot card's reminder within the card's readers
// (lib/autopilot/reminder-cards.ts), but a lookup by title did not: asked by
// Kit, a child Ava's dental policy does not name, "renew" completed the
// managers' "Renew dental insurance (Smile Co)" and left Kit's own "Renew
// library books" open, and "e" read the policy's title back to him.
//
// Each lookup now matches only what the reader may be shown. Driven through
// the real scan, the real resolution service and the real tools over the
// in-memory database.

vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn() }));
vi.mock('@/lib/services/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/notifications')>()),
  notify: vi.fn(async () => ({ ok: true, data: { created: 1 } })),
}));
const { runAutopilotScan } = await import('@/lib/autopilot/scan');
const { resolveSuggestion } = await import('@/lib/services/autopilot');
const { reminderTools } = await import('@/lib/ai/tools/reminders');
const { buildAssistantTools } = await import('@/lib/assistant/tools');

type DB = SupabaseClient<Database>;
type Memory = ReturnType<typeof createInMemorySupabase<DB>>;
const FAMILY = 'f1';
const POLICY = 'Renew dental insurance (Smile Co)';
const LIBRARY = 'Renew library books';
const NOW = '2026-09-30T08:00:00Z';
const echo = (key: string, params?: Record<string, string | number>) => `${key} ${JSON.stringify(params ?? {})}`;
const ROSTER = [
  { id: 'mum', role: 'parent' }, { id: 'gran', role: 'adult' }, { id: 'ava', role: 'child' }, { id: 'kit', role: 'child' }, { id: 'neighbour', role: 'guest' },
];
const role = (id: string) => ROSTER.find((m) => m.id === id)!.role;

/**
 * Mum accepts the scan's card for Ava's dental policy: an unassigned
 * reminder, due on the 1st, the managers' and Ava's. Kit has his own, due on
 * the 5th — later, so a lookup by title alone meets the policy's first.
 */
async function household(): Promise<Memory> {
  const db = createInMemorySupabase<DB>({
    uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']], family_reminders: [['family_id', 'idempotency_key']] },
    defaults: { reminders: { is_done: false, notes: null, recurrence: 'none' } },
    rpc: { ensure_default_grocery_list: () => 'list-1' },
  });
  db.seed('families', [{ id: FAMILY, timezone: 'UTC', name: 'Family' }]);
  db.seed('family_members', ROSTER.map((m) => ({ ...m, family_id: FAMILY, user_id: `u-${m.id}`, display_name: m.id, is_active: true, birthday: null })));
  db.seed('family_insurance_policies', [{ id: 'pol-ava', family_id: FAMILY, policy_type: 'dental', insurer: 'Smile Co', renewal_date: '2026-10-01', member_id: 'ava', is_active: true }]);
  vi.setSystemTime(new Date('2026-09-21T06:30:00Z'));
  await runAutopilotScan(db, FAMILY, null, 'UTC', 'en-US', echo, new Date('2026-09-21T06:30:00Z'));
  const card = db.table('autopilot_suggestions').find((s) => s.source_id === 'pol-ava')!;
  vi.setSystemTime(new Date('2026-09-21T08:00:00Z'));
  const scope = { db, familyId: FAMILY, userId: 'u-mum', memberId: 'mum', role: 'parent', actorKind: 'member', tz: 'UTC', now: new Date('2026-09-21T08:00:00Z') } as ServiceScope;
  expect(await resolveSuggestion(scope, { suggestionId: card.id as string, updatedAt: card.updated_at as string, action: 'reminder' }))
    .toMatchObject({ ok: true, status: 'executed' });
  db.seed('family_reminders', [{
    id: 'library', family_id: FAMILY, title: LIBRARY, remind_at: '2026-10-05T16:00:00.000Z', status: 'active', member_id: 'kit',
    tags: [], idempotency_key: null, kind: 'time', priority: 'medium', recurrence: 'none', snoozed_until: null, notes: null, location_name: null,
  }]);
  const policy = db.table('family_reminders').find((r) => r.title === POLICY)!;
  expect(policy).toMatchObject({ member_id: null, status: 'active' });
  expect(Date.parse(String(policy.remind_at))).toBeLessThan(Date.parse('2026-10-05T16:00:00.000Z'));
  vi.setSystemTime(new Date(NOW));
  return db;
}

const reminderRow = (db: Memory, title: string) => db.table('family_reminders').find((r) => r.title === title)!;

/** One of reminders.complete / reminders.snooze, as `memberId`. */
async function aiTool(db: Memory, memberId: string, name: string, input: Record<string, unknown>) {
  const tool = reminderTools.find((t) => t.name === name)!;
  const scope = { db, familyId: FAMILY, userId: `u-${memberId}`, memberId, role: role(memberId), actorKind: 'member', tz: 'UTC', now: new Date(NOW) } as ServiceScope;
  return await tool.execute(scope, input) as { ok: true; data: { id: string; title: string } } | { ok: false; error: string };
}

/** One of the legacy complete_reminder / snooze_reminder, as `memberId`. */
async function legacyTool(db: Memory, memberId: string, name: string, input: Record<string, unknown>) {
  const tools = buildAssistantTools(db, {
    familyId: FAMILY, userId: `u-${memberId}`, memberId, role: role(memberId), tz: 'UTC',
    members: ROSTER.map((m) => ({ id: m.id, display_name: m.id })),
  });
  return await tools.find((t) => t.name === name)!.execute(input) as { ok: boolean; summary?: string; error?: string };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('reminders.complete and reminders.snooze find only a reminder the reader may see', () => {
  it("Kit's \"renew\" completes his library books and leaves the policy's reminder open", async () => {
    const db = await household();
    const res = await aiTool(db, 'kit', 'reminders.complete', { title: 'renew' });
    expect(res).toMatchObject({ ok: true, data: { title: LIBRARY } });
    expect(JSON.stringify(res)).not.toContain('Smile Co');
    expect(reminderRow(db, LIBRARY).status).toBe('completed');
    expect(reminderRow(db, POLICY).status).toBe('active');
    expect(reminderRow(db, POLICY).completed_at ?? null).toBeNull();
  });

  it('Kit\'s "e" never moves the policy\'s reminder or reads its title back', async () => {
    const db = await household();
    const res = await aiTool(db, 'kit', 'reminders.snooze', { title: 'e', minutes: 60 });
    expect(res).toMatchObject({ ok: true, data: { title: LIBRARY } });
    expect(JSON.stringify(res)).not.toContain(POLICY);
    expect(reminderRow(db, POLICY).status).toBe('active');
    expect(reminderRow(db, POLICY).snoozed_until ?? null).toBeNull();
    expect(reminderRow(db, LIBRARY).status).toBe('snoozed');
  });

  it("with only the policy's reminder matching, Kit is told there is none — not its title", async () => {
    const db = await household();
    const res = await aiTool(db, 'kit', 'reminders.complete', { title: 'smile' });
    expect(res).toMatchObject({ ok: false });
    expect(JSON.stringify(res)).not.toContain(POLICY);
    expect(reminderRow(db, POLICY).status).toBe('active');
  });

  it("the managers and Ava, the policy's readers, still reach the soonest match: the policy's", async () => {
    for (const reader of ['mum', 'ava']) {
      const db = await household();
      expect(await aiTool(db, reader, 'reminders.complete', { title: 'renew' }), reader).toMatchObject({ ok: true, data: { title: POLICY } });
      expect(reminderRow(db, LIBRARY).status, reader).toBe('active');
    }
  });
});

describe('the legacy complete_reminder and snooze_reminder find only a reminder the reader may see', () => {
  it("Kit's \"renew\" completes his library books and leaves the policy's reminder open", async () => {
    const db = await household();
    const res = await legacyTool(db, 'kit', 'complete_reminder', { title: 'renew' });
    expect(res).toEqual({ ok: true, summary: `Completed “${LIBRARY}”.` });
    expect(reminderRow(db, LIBRARY).status).toBe('completed');
    expect(reminderRow(db, POLICY).status).toBe('active');
  });

  it('Kit\'s "e" never moves the policy\'s reminder or reads its title back', async () => {
    const db = await household();
    const before = reminderRow(db, POLICY).remind_at;
    const res = await legacyTool(db, 'kit', 'snooze_reminder', { title: 'e', remind_at: '2026-10-20T09:00:00' });
    expect(res).toEqual({ ok: true, summary: `Moved “${LIBRARY}” to a new time.` });
    expect(reminderRow(db, POLICY).remind_at).toBe(before);
    expect(reminderRow(db, LIBRARY).remind_at).toBe('2026-10-20T09:00:00.000Z');
  });

  it('a manager still reaches the soonest match: the policy\'s', async () => {
    const db = await household();
    expect(await legacyTool(db, 'mum', 'complete_reminder', { title: 'renew' })).toEqual({ ok: true, summary: `Completed “${POLICY}”.` });
    expect(reminderRow(db, LIBRARY).status).toBe('active');
  });
});
