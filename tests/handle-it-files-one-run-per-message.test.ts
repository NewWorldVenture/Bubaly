// N12 — "Handle it" read `ai_handled` before filing and wrote it after.
//
// A teen's or child's tap filed the request, the plan, the run and its held
// approval cards, and only then did `markInboxMessageHandled` refuse them
// ("Only a parent or adult can file a family message"): the row stayed
// unhandled and every reload filed another run. Two managers tapping at once
// both read "not handled" and both filed.
//
// The action now refuses a non-manager before anything is filed, and claims the
// message (false → true in one conditional write) before it files, giving the
// claim back if the intake fails. Driven through the real server action and
// the real inbox service over the in-memory database; the intake is recorded
// (and held, for the race) rather than run.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent' as string,
  submitted: [] as Record<string, unknown>[],
  gate: null as Promise<void> | null,
  answer: { ok: true, data: { requestId: 'req-1', runId: 'run-1', planId: 'plan-1', outcome: 'plan', summary: 'ok', redirect: null } } as Record<string, unknown>,
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, createServer: async () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${h.role}` },
    active: { familyId: FAMILY, role: h.role, member: { id: `member-${h.role}` }, family: { timezone: 'America/New_York' } },
  }),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/ai-access', () => ({ assertAIAccess: async () => ({ ok: true }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/provider', async (original) => ({ ...await original<typeof import('@/lib/ai/provider')>(), isAIConfigured: async () => true }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/ai/runs/intake', async (original) => ({
  ...await original<typeof import('@/lib/ai/runs/intake')>(),
  submitRequest: async (_scope: unknown, input: Record<string, unknown>) => {
    h.submitted.push(input);
    if (h.gate) await h.gate;
    return h.answer;
  },
}));

const { handleInboxMessageAction } = await import('@/app/(app)/dashboard/inbox/actions');

const FAMILY = '00000000-0000-4000-8000-0000000b1201';
const MESSAGE = '00000000-0000-4000-8000-0000000b1211';

let db: InMemorySupabase;

beforeEach(() => {
  db = createInMemorySupabase();
  h.db = db;
  h.role = 'parent';
  h.submitted = [];
  h.gate = null;
  h.answer = { ok: true, data: { requestId: 'req-1', runId: 'run-1', planId: 'plan-1', outcome: 'plan', summary: 'ok', redirect: null } };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('family_inbox_messages', [{
    id: MESSAGE, family_id: FAMILY, channel: 'email', direction: 'inbound', from_addr: 'school@example.com',
    subject: 'Picture day', body: 'Picture day is Thursday. Forms are due Wednesday.', ai_handled: false, status: 'new',
  }]);
});

const row = () => db.table('family_inbox_messages').find((r) => r.id === MESSAGE) as Row;

describe('Handle it', () => {
  it.each(['teen', 'child', 'caregiver'])('refuses a %s before anything is filed', async (role) => {
    h.role = role;

    const result = await handleInboxMessageAction(MESSAGE, 'submission-1');

    expect(result).toMatchObject({ ok: false, code: 'denied' });
    expect(h.submitted).toEqual([]);
    expect(row()).toMatchObject({ ai_handled: false, status: 'new' });
  });

  it('files one run when two managers tap at the same moment', async () => {
    let letGo!: () => void;
    h.gate = new Promise<void>((resolve) => { letGo = resolve; });

    const first = handleInboxMessageAction(MESSAGE, 'submission-a');
    const second = handleInboxMessageAction(MESSAGE, 'submission-b');
    await vi.waitFor(() => { if (!h.submitted.length) throw new Error('not yet'); });
    letGo();
    const results = await Promise.all([first, second]);

    expect(h.submitted).toHaveLength(1);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(row()).toMatchObject({ ai_handled: true, status: 'read' });
  });

  it('gives the claim back when the intake fails, so the message can be handed over again', async () => {
    h.answer = { ok: false, error: 'Bubaly is taking longer than expected on that one.', code: 'planner_timeout' };

    expect(await handleInboxMessageAction(MESSAGE, 'submission-1')).toMatchObject({ ok: false, code: 'planner_timeout' });
    expect(row()).toMatchObject({ ai_handled: false, status: 'new' });

    h.answer = { ok: true, data: { requestId: 'req-2', runId: 'run-2', planId: 'plan-2', outcome: 'plan', summary: 'ok', redirect: null } };
    expect(await handleInboxMessageAction(MESSAGE, 'submission-2')).toMatchObject({ ok: true, handled: true });
    expect(h.submitted).toHaveLength(2);
    expect(row()).toMatchObject({ ai_handled: true });
  });
});
