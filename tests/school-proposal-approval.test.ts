import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown, role: 'parent' }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({
  user: { id: 'requester-user' },
  active: { familyId: 'family-1', role: holder.role, member: { id: 'requester' }, family: { timezone: 'UTC' } },
}) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: vi.fn() }));

import { proposeFrontDeskAction } from '@/app/(app)/dashboard/school/actions';
import { decide, editAndApprove } from '@/lib/services/approvals';
import { gateAiAction } from '@/lib/trust/ai-gate';

let db: InMemorySupabase & SupabaseClient<Database>;
const scope = (): ServiceScope => ({ db, familyId: 'family-1', userId: 'approver-user', memberId: 'approver', role: 'parent', actorKind: 'member', tz: 'UTC' });
const source = () => db.table('family_inbox_messages')[0];

function policy(effect: string, extra = {}) {
  db.seed('trust_policies', [{ id: 'policy', family_id: 'family-1', domain: 'scheduling', capability: 'automate', subject_kind: 'ai', effect, enabled: true, priority: 100, conditions: {}, ...extra }]);
}

async function propose() {
  const result = await proposeFrontDeskAction('message-1');
  expect(result).toMatchObject({ ok: true, outcome: 'pending_approval', approvalId: expect.any(String) });
  if (!result.ok || result.outcome !== 'pending_approval' || !result.approvalId) throw new Error('No approval filed');
  return result.approvalId;
}

/** Inject real PostgREST failures without simulating successful household writes. */
function breakQuery(table: string, operation: 'insert' | 'update' | 'select', throws = false, columns?: string) {
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation(((name: string) => {
    const builder = from(name);
    if (name !== table) return builder;
    const original = builder[operation].bind(builder);
    builder[operation] = ((...args: unknown[]) => {
      if (columns && args[0] !== columns) return (original as (...input: unknown[]) => unknown)(...args);
      if (throws) throw new Error('Connection lost');
      const failure = { data: null, error: { code: '42501', message: 'Write rejected' }, count: null };
      const failed = { select: () => failed, eq: () => failed, order: () => failed,
        maybeSingle: async () => failure, single: async () => failure,
        then: (resolve: (value: unknown) => unknown) => resolve(failure) };
      return failed;
    }) as never;
    return builder;
  }) as typeof db.from);
}

beforeEach(() => {
  vi.restoreAllMocks();
  holder.role = 'parent';
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      approval_requests: { approvals: [], expires_at: null, run_id: null, plan_step_id: null, plan_step_ids: [], payload_kind: null, request_id: null },
      grocery_items: { is_checked: false },
    },
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
  });
  holder.db = db;
  db.seed('family_ai_settings', [{ family_id: 'family-1', enabled: true, behavior: 'execute' }]);
  db.seed('family_members', [
    { id: 'requester', family_id: 'family-1', user_id: 'requester-user', role: 'parent', display_name: 'Alex', is_active: true },
    { id: 'approver', family_id: 'family-1', user_id: 'approver-user', role: 'parent', display_name: 'Sam', is_active: true },
  ]);
  db.seed('family_inbox_messages', [{ id: 'message-1', family_id: 'family-1', subject: 'School permission slip', body: 'Please sign and return the school permission slip by September 15, 2026.', ai_handled: false, status: 'new' }]);
});

describe('school proposals always wait for review', () => {
  it('holds an explicit allow behind one persisted approval, retaining source and requester', async () => {
    policy('allow');
    const id = await propose();
    expect(await propose()).toBe(id);
    expect(db.table('approval_requests')).toHaveLength(1);
    expect(db.table('approval_requests')[0]).toMatchObject({
      status: 'pending', requested_by_member_id: 'requester', agent: 'School & Sports desk',
      payload: { name: 'create_reminder', source: { kind: 'school_front_desk', message_id: 'message-1' } },
    });
    expect(db.table('family_reminders')).toHaveLength(0);
    expect(db.table('ai_tool_calls')).toHaveLength(0);
    expect(source()).toMatchObject({ ai_handled: false, status: 'new' });
  });

  it('keeps automatic execution available to other surfaces without the explicit review option', async () => {
    policy('allow');
    expect(await gateAiAction(db, 'family-1', { toolName: 'create_reminder', domain: 'scheduling', actorId: 'other', actorRole: 'parent', agent: 'Other', title: 'Reminder', payload: { name: 'create_reminder', args: { title: 'A' } } })).toEqual({ effect: 'allow' });
    expect(db.table('approval_requests')).toHaveLength(0);
  });

  it.each(['switch_off', 'deny', 'child'] as const)('preserves the %s refusal', async (reason) => {
    if (reason === 'switch_off') db.table('family_ai_settings')[0].enabled = false;
    if (reason === 'deny') policy('deny');
    if (reason === 'child') holder.role = 'child';
    expect(await proposeFrontDeskAction('message-1')).toMatchObject({ ok: false, code: 'denied' });
    expect(db.table('approval_requests')).toHaveLength(0);
    expect(db.table('family_reminders')).toHaveLength(0);
  });

  it('reports an approval insert failure without running or marking anything', async () => {
    policy('allow');
    breakQuery('approval_requests', 'insert');
    expect(await proposeFrontDeskAction('message-1')).toMatchObject({ ok: false, code: 'approval_failed', error: 'schoolDesk.approvalNotRecorded' });
    expect(db.table('family_reminders')).toHaveLength(0);
    expect(source().ai_handled).toBe(false);
  });

  it('refuses another family’s message before proposing', async () => {
    source().family_id = 'other-family';
    expect(await proposeFrontDeskAction('message-1')).toMatchObject({ ok: false });
    expect(db.table('approval_requests')).toHaveLength(0);
  });
});

describe('approved school source completion uses persisted execution', () => {
  it.each([false, true])('repairs a failed handled stamp on Propose without another action (edited: %s)', async (edited) => {
    const id = await propose();
    breakQuery('family_inbox_messages', 'update');
    const result = edited
      ? await editAndApprove(scope(), id, { title: 'Return the corrected form' })
      : await decide(scope(), id, 'approved');
    expect(result.ok).toBe(true);
    expect(source().ai_handled).toBe(false);
    expect(db.table('family_reminders')).toHaveLength(1);

    // A retry while bookkeeping is still unavailable cannot offer another approval.
    expect(await proposeFrontDeskAction('message-1')).toMatchObject({ ok: false, code: 'previous_proposal' });
    expect(db.table('approval_requests')).toHaveLength(1);
    vi.restoreAllMocks();
    expect(await proposeFrontDeskAction('message-1')).toEqual({ ok: true, outcome: 'handled' });
    expect(source()).toMatchObject({ ai_handled: true, status: 'archived' });
    expect(db.table('approval_requests')).toHaveLength(1);
    expect(db.table('ai_tool_calls')).toHaveLength(1);
    expect(db.table('family_reminders')).toHaveLength(1);
    if (edited) expect(db.table('family_reminders')[0].title).toBe('Return the corrected form');
  });

  it('fails closed if earlier proposals cannot be read', async () => {
    breakQuery('approval_requests', 'select');
    expect(await proposeFrontDeskAction('message-1')).toMatchObject({ ok: false, code: 'previous_proposal' });
    expect(db.table('approval_requests')).toHaveLength(0);
  });

  it.each([
    ['gear', 'Soccer equipment', 'Soccer practice: please bring cleats, shin guards and a water bottle.', 'groceries.addItems', 'grocery_items'],
    ['schedule', 'School schedule change', 'The school field trip is rescheduled to September 16, 2026 at 4pm.', 'calendar.createEvent', 'calendar_events'],
  ])('keeps %s proposals pending until their real tool succeeds', async (_kind, subject, body, toolName, table) => {
    Object.assign(source(), { subject, body });
    const id = await propose();
    expect(db.table(table)).toHaveLength(0);
    expect(source().ai_handled).toBe(false);
    expect(await decide(scope(), id, 'approved')).toMatchObject({ ok: true, data: { executed: true } });
    expect(db.table(table).length).toBeGreaterThan(0);
    expect(db.table('ai_tool_calls')[0]).toMatchObject({ state: 'succeeded', tool_name: toolName });
    expect(source()).toMatchObject({ ai_handled: true, status: 'archived' });
  });

  it('runs the real tool after approval, then archives and marks only its source', async () => {
    policy('allow');
    const id = await propose();
    db.seed('family_inbox_messages', [{ id: 'other', family_id: 'family-1', ai_handled: false, status: 'new' }]);
    expect(await decide(scope(), id, 'approved')).toMatchObject({ ok: true, data: { executed: true } });
    expect(db.table('family_reminders')).toHaveLength(1);
    expect(db.table('family_reminders')[0]).toMatchObject({ created_by: 'requester-user', ai_suggested: true });
    expect(db.table('ai_tool_calls')[0]).toMatchObject({ state: 'succeeded', family_id: 'family-1' });
    expect(source()).toMatchObject({ ai_handled: true, status: 'archived' });
    expect(db.table('family_inbox_messages')[1].ai_handled).toBe(false);
    expect(await decide(scope(), id, 'approved')).toMatchObject({ ok: false });
    expect(db.table('family_reminders')).toHaveLength(1);
  });

  it('retains source attribution when the parent edits the proposed reminder', async () => {
    const id = await propose();
    expect(await editAndApprove(scope(), id, { title: 'Return the signed school form' })).toMatchObject({ ok: true });
    expect(db.table('family_reminders')[0].title).toBe('Return the signed school form');
    expect(source()).toMatchObject({ ai_handled: true, status: 'archived' });
  });

  it('waits for the existing two-parent threshold and retains the requester on the engine approval', async () => {
    policy('require_approval', { approval_model: 'two_parent', required_approvals: 2 });
    const id = await propose();
    expect(db.table('approval_requests')[0].requested_by_member_id).toBe('requester');
    expect(await decide(scope(), id, 'approved')).toMatchObject({ ok: true, data: { status: 'pending', executed: false } });
    expect(source().ai_handled).toBe(false);
    expect(db.table('family_reminders')).toHaveLength(0);
    expect(await decide({ ...scope(), memberId: 'requester', userId: 'requester-user' }, id, 'approved')).toMatchObject({ ok: true, data: { executed: true } });
    expect(source().ai_handled).toBe(true);
  });

  it('leaves rejected work unhandled', async () => {
    const id = await propose();
    expect(await decide(scope(), id, 'rejected')).toMatchObject({ ok: true, data: { executed: false } });
    expect(source().ai_handled).toBe(false);
    expect(db.table('family_reminders')).toHaveLength(0);
    expect(await propose()).not.toBe(id);
  });

  it('leaves a failed tool write unhandled', async () => {
    const id = await propose();
    breakQuery('family_reminders', 'insert');
    expect(await decide(scope(), id, 'approved')).toMatchObject({ ok: false });
    expect(source().ai_handled).toBe(false);
    expect(db.table('family_reminders')).toHaveLength(0);
    vi.restoreAllMocks();
    expect(await proposeFrontDeskAction('message-1')).toMatchObject({ ok: false, code: 'previous_proposal' });
    expect(db.table('approval_requests')).toHaveLength(1);
  });

  it.each(['receipt_write', 'receipt_read', 'source_write', 'source_throw', 'verification'] as const)('does not claim handled after %s fails', async (failure) => {
    const id = await propose();
    if (failure === 'receipt_write') breakQuery('ai_tool_calls', 'update');
    if (failure === 'receipt_read') breakQuery('ai_tool_calls', 'select', false, 'id, tool_name');
    if (failure === 'verification') breakQuery('family_reminders', 'select', false, 'id, remind_at, status');
    if (failure === 'source_write' || failure === 'source_throw') breakQuery('family_inbox_messages', 'update', failure === 'source_throw');
    expect(await decide(scope(), id, 'approved')).toMatchObject({ ok: true, data: { executed: true } });
    expect(db.table('family_reminders')).toHaveLength(1);
    expect(source()).toMatchObject({ ai_handled: false, status: 'new' });
    expect(db.table('trust_audit_logs').some((r) => (r.context as Record<string, unknown>)?.inbox_source_handled === false)).toBe(true);
    expect(await decide(scope(), id, 'approved')).toMatchObject({ ok: false });
    expect(db.table('family_reminders')).toHaveLength(1);
  });

  it.each(['member', 'foreign_source', 'other_agent'] as const)('does not trust %s provenance for source bookkeeping', async (kind) => {
    const id = await propose();
    const row = db.table('approval_requests')[0];
    if (kind === 'member') row.requested_by_kind = 'member';
    if (kind === 'foreign_source') source().family_id = 'other-family';
    if (kind === 'other_agent') row.agent = 'Other';
    await decide(scope(), id, 'approved');
    expect(source().ai_handled).toBe(false);
  });
});
