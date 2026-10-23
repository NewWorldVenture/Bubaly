import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// A guest (the extended-family invite: a grandparent kept in the loop) views
// the household and does not write it (roles.ts, 0464). The Paperwork Inbox
// already says so where paperwork comes IN: addPaperworkAction, the capture
// route and the link route each refuse a guest with `actionRefusal.notAllowed`.
//
// The three actions that SETTLE paperwork did not. A guest could mark a
// parent's permission slip done or archive it (it leaves the needs-action
// inbox with its deadline), put its actions on the family calendar or the
// reminders, or spend the family's AI allowance drafting a reply that is then
// written onto the row. The database refuses none of it until the held 0484.
//
// Driven through the real actions against an in-memory household.

const FAMILY = 'family-1';
const ITEM = 'item-1';
const state = vi.hoisted(() => ({ db: null as unknown, role: 'guest', rateLimited: [] as string[], reminders: [] as string[] }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));
vi.mock('@/lib/auth/require-aal2', () => ({ aal2Verdict: async () => ({ action: 'allow' }) }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1', email: 'grandma@example.com' },
    memberships: [],
    active: {
      familyId: FAMILY, role: state.role,
      member: { id: 'member-1', family_id: FAMILY, user_id: 'user-1' },
      family: { id: FAMILY, name: 'Test household', timezone: 'UTC' },
    },
  }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return {
    getTranslations: async () => (key: string) => translate(SOURCE_MESSAGES, key),
    getLocaleContext: async () => ({ locale: { code: 'en-US' }, messages: SOURCE_MESSAGES }),
  };
});
vi.mock('@/lib/services/reminders', () => ({
  createReminder: async () => { state.reminders.push('made'); return { ok: true, data: { id: `reminder-${state.reminders.length}` } }; },
}));
vi.mock('@/lib/server/ai-rate-limit', () => ({
  enforceAIRateLimit: async (_db: unknown, key: string) => { state.rateLimited.push(key); return { ok: true }; },
}));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ model: 'fixture', complete: async () => ({ text: 'Yes, she can come.', usage: {} }) }),
  describeAIError: (error: unknown) => ({ message: String(error) }),
}));
vi.mock('@/lib/server/ai-access', () => ({ assertAIAllowance: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: async (_scope: unknown, _meta: unknown, run: (obs: unknown) => Promise<string>) => run({ used() {}, failed() {} }) }));

const { setPaperworkStatusAction, materializePaperworkActionAction, draftPaperworkReplyAction } = await import('@/app/(app)/dashboard/paperwork/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const notAllowed = translate(SOURCE_MESSAGES, 'actionRefusal.notAllowed');

type DB = SupabaseClient<Database>;
let db: ReturnType<typeof createInMemorySupabase<DB>>;

const item = () => db.table('paperwork_items').find((row) => row.id === ITEM)!;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.role = 'guest'; state.rateLimited = []; state.reminders = [];
  db = createInMemorySupabase<DB>({
    rpc: {
      paperwork_stamp_action: (args, inner) => {
        const row = (inner.table('paperwork_items') as Record<string, unknown>[]).find((r) => r.id === args.p_item_id);
        const target = (row?.actions as Record<string, unknown>[] | undefined)?.[args.p_index as number];
        if (!target || target.materialized_id) return false;
        target.materialized_id = args.p_id; target.materialized_as = args.p_as;
        return true;
      },
    },
  });
  state.db = db;
  db.seed('families', [{ id: FAMILY, name: 'Test household', timezone: 'UTC' }]);
  db.seed('paperwork_items', [{
    id: ITEM, family_id: FAMILY, title: 'Field trip', kind: 'permission_slip', created_by: 'parent-user',
    status: 'needs_action', urgency: 'soon', due_on: '2026-10-01', raw_text: 'Please sign and return by Oct 1.',
    actions: [
      { kind: 'rsvp', label: 'RSVP to the trip', materialized_as: null, materialized_id: null },
      { kind: 'sign', label: 'Sign the slip', materialized_as: null, materialized_id: null },
    ],
    meta: {}, summary: '', sender: 'School',
  }]);
});

describe('a guest does not settle the family’s paperwork', () => {
  it.each(['done', 'archived', 'in_progress'] as const)('a guest cannot mark a slip %s', async (status) => {
    await expect(setPaperworkStatusAction({ itemId: ITEM, status })).resolves.toEqual({ ok: false, error: notAllowed });
    expect(item().status).toBe('needs_action');
  });

  it.each([0, 1])('a guest cannot turn action %i into a calendar event or a reminder', async (actionIndex) => {
    await expect(materializePaperworkActionAction({ itemId: ITEM, actionIndex })).resolves.toEqual({ ok: false, error: notAllowed });
    expect(db.table('calendar_events')).toEqual([]);
    expect(state.reminders).toEqual([]);
    expect((item().actions as { materialized_id: string | null }[]).map((a) => a.materialized_id)).toEqual([null, null]);
  });

  it('a guest cannot draft a reply: no AI budget spent, nothing written to the slip', async () => {
    await expect(draftPaperworkReplyAction(ITEM)).resolves.toEqual({ ok: false, error: notAllowed });
    expect(state.rateLimited).toEqual([]);
    expect(item().meta).toEqual({});
  });

  // The refusal is the guest's alone: everyone else who may settle a slip still can.
  it.each(['parent', 'teen'])('a %s still settles it', async (role) => {
    state.role = role;
    await expect(setPaperworkStatusAction({ itemId: ITEM, status: 'done' })).resolves.toEqual({ ok: true });
    expect(item().status).toBe('done');
    await expect(materializePaperworkActionAction({ itemId: ITEM, actionIndex: 1 })).resolves.toEqual({ ok: true });
    expect(state.reminders).toHaveLength(1);
    const drafted = await draftPaperworkReplyAction(ITEM);
    expect(drafted).toEqual({ ok: true, draft: 'Yes, she can come.' });
  });
});
