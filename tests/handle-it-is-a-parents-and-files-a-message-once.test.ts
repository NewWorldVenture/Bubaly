// N8 / N17 — "Handle it" on the household inbox.
//
// The queue offered it to every member, and the action filed first and asked
// later: submitRequest created a handle_it request and planned a run, and only
// THEN did markInboxMessageHandled refuse a teen, child or caregiver ("Only a
// parent or adult can file a family message"). The member was told it failed,
// the row still said "not handled", and the parent who pressed next filed the
// same message again. Two parents pressing together both read ai_handled =
// false and both filed, too.
//
// Driven through the REAL action, inbox service and queue loader against an
// in-memory database; only the intake itself is replaced, by a recorder, so
// the test can count filings.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = '00000000-0000-4000-8000-00000000fb01';
const MESSAGE = '00000000-0000-4000-8000-00000000cb04';
const RUN = '00000000-0000-4000-8000-00000000cb03';
const t = (key: string) => translate(SOURCE_MESSAGES, key);

const hoisted = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent' as string,
  submitted: [] as { input: Record<string, unknown> }[],
  intake: 'ok' as 'ok' | 'fail' | 'throw',
}));

vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages } = await import('@/lib/i18n/messages');
  const { translate: tr } = await import('@/lib/i18n/translate');
  return { getTranslations: async () => (key: string) => tr(messages, key) };
});
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => hoisted.db,
  createServer: async () => hoisted.db,
}));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${hoisted.role}` },
    active: { familyId: FAMILY, role: hoisted.role, member: { id: `member-${hoisted.role}` }, family: { timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/server/ai-access', () => ({ assertAIAccess: async () => ({ ok: true }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/provider', async (original) => ({ ...await original<typeof import('@/lib/ai/provider')>(), isAIConfigured: async () => true }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/ai/runs/intake', async (original) => ({
  ...await original<typeof import('@/lib/ai/runs/intake')>(),
  submitRequest: async (_scope: unknown, input: Record<string, unknown>) => {
    hoisted.submitted.push({ input });
    // Filing takes a moment (classification, planning): long enough for a
    // second press to arrive while the first is still in here.
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (hoisted.intake === 'throw') throw new Error('planner transport lost');
    if (hoisted.intake === 'fail') return { ok: false, error: 'Bubaly could not plan that request.', code: 'planner' };
    return { ok: true, data: { requestId: `request-${hoisted.submitted.length}`, runId: RUN, planId: 'plan-1', outcome: 'plan', summary: 'ok', redirect: null } };
  },
}));

const { handleInboxMessageAction } = await import('@/app/(app)/dashboard/inbox/actions');
const { loadInboxQueue } = await import('@/lib/inbox/server');

let db: InMemorySupabase;
const row = () => db.table('family_inbox_messages').find((r) => r.id === MESSAGE)!;

beforeEach(() => {
  hoisted.role = 'parent';
  hoisted.submitted = [];
  hoisted.intake = 'ok';
  db = createInMemorySupabase();
  hoisted.db = db;
  db.seed('family_inbox_messages', [{
    id: MESSAGE, family_id: FAMILY, channel: 'email', direction: 'inbound', from_addr: 'school@example.com',
    subject: 'Dentist', body: 'Emma has a dentist appointment on Thursday at 3pm.', ai_summary: null, ai_intent: 'appointment',
    ai_handled: false, status: 'new', occurred_at: '2026-10-13T09:00:00Z',
  }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('Handle it is a parent\'s or adult\'s, and is refused before anything is filed', () => {
  it.each(['teen', 'child', 'caregiver'])('a %s is refused with nothing filed and the message untouched', async (role) => {
    hoisted.role = role;

    const result = await handleInboxMessageAction(MESSAGE, 'press-1');

    expect(result).toEqual({ ok: false, error: t('inboxActions.onlyAParentOrAdultCanHandle'), code: 'denied' });
    expect(hoisted.submitted).toHaveLength(0);
    expect(row()).toMatchObject({ ai_handled: false, status: 'new' });
  });

  it('so the parent who presses next files it once, and the row says so', async () => {
    hoisted.role = 'teen';
    await handleInboxMessageAction(MESSAGE, 'teen-press');
    hoisted.role = 'parent';

    const result = await handleInboxMessageAction(MESSAGE, 'parent-press');

    expect(result).toMatchObject({ ok: true, handled: true });
    expect(hoisted.submitted).toHaveLength(1);
    expect(row()).toMatchObject({ ai_handled: true, status: 'read' });
  });

  it('the queue does not offer Handle it to a member who cannot file, and does to a parent or adult', async () => {
    const reader = { locale: 'en-US' as const, t };
    for (const [role, offered] of [['teen', false], ['child', false], ['caregiver', false], ['parent', true], ['adult', true]] as const) {
      const queue = await loadInboxQueue(db as unknown as SupabaseClient<Database>, FAMILY, reader, { role, userId: `user-${role}` });
      const item = queue.items.find((i) => i.rowId === MESSAGE);
      expect(item?.canHandle, role).toBe(offered);
    }
  });
});

describe('a message is filed once, however many presses arrive together', () => {
  it('two parents pressing at the same moment file ONE request', async () => {
    const [first, second] = await Promise.all([
      handleInboxMessageAction(MESSAGE, 'parent-a'),
      handleInboxMessageAction(MESSAGE, 'parent-b'),
    ]);

    expect(hoisted.submitted).toHaveLength(1);
    expect(first).toMatchObject({ ok: true, handled: true });
    expect(second).toMatchObject({ ok: true, handled: true });
    expect(row()).toMatchObject({ ai_handled: true });
  });

  it.each(['fail', 'throw'] as const)('an intake that %ss gives the message back, unhandled, for the next press', async (mode) => {
    hoisted.intake = mode;
    if (mode === 'throw') await expect(handleInboxMessageAction(MESSAGE, 'press-1')).rejects.toThrow('planner transport lost');
    else expect(await handleInboxMessageAction(MESSAGE, 'press-1')).toMatchObject({ ok: false, code: 'planner' });
    expect(row()).toMatchObject({ ai_handled: false, status: 'new' });

    hoisted.intake = 'ok';
    expect(await handleInboxMessageAction(MESSAGE, 'press-2')).toMatchObject({ ok: true, handled: true });
    expect(hoisted.submitted).toHaveLength(2);
    expect(row()).toMatchObject({ ai_handled: true, status: 'read' });
  });
});
