import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemorySupabase } from './helpers/in-memory-supabase';
import type { ServiceScope } from '@/lib/services/types';
import { resolveSuggestion, suggestionReminderKey } from '@/lib/services/autopilot';
import { resolveAutopilotSuggestionAction } from '@/app/(app)/dashboard/autopilot/actions';

const mocks = vi.hoisted(() => ({ context: vi.fn(), server: vi.fn(), revalidate: vi.fn(), superAdmin: vi.fn(), plan: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireFeature: mocks.context, isSuperAdmin: mocks.superAdmin }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: mocks.plan }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.server }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn() }));

const FAMILY = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const USER = '20000000-0000-4000-8000-000000000001';
const MEMBER = '30000000-0000-4000-8000-000000000001';
const ID = '40000000-0000-4000-8000-000000000001';
const AT = '2026-09-09T10:00:00.000Z';
const input = { suggestionId: ID, updatedAt: AT, action: 'reminder' as const };
const request = { ...input, expectedFamilyId: FAMILY, expectedUserId: USER };
let db: InMemorySupabase;
let scope: ServiceScope;
let failure: { table: string; op: 'select' | 'insert' | 'update'; thrown?: boolean; empty?: boolean } | null;
let calls: { table: string; op: string }[];
let beforeReminderInsert: (() => void) | null;
let beforeStamp: (() => void) | null;

function source() { return db.table('autopilot_suggestions')[0]; }
function reminders() { return db.table('family_reminders'); }

beforeEach(() => {
  vi.restoreAllMocks(); mocks.context.mockReset(); mocks.server.mockReset(); mocks.revalidate.mockReset();
  mocks.superAdmin.mockResolvedValue(false); mocks.plan.mockResolvedValue(2);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  failure = null; calls = []; beforeReminderInsert = null; beforeStamp = null;
  db = new InMemorySupabase({ userId: USER, uniques: { family_reminders: [['family_id', 'idempotency_key']] } });
  db.seed('autopilot_suggestions', [{
    id: ID, family_id: FAMILY, kind: 'document', action_type: 'create_reminder', status: 'open',
    title: 'Renew passport', detail: 'Bring the existing documents', payload: { title: 'Passport renewal', at: '2026-09-12T09:00:00Z', memberId: OTHER, family_id: OTHER },
    member_id: MEMBER, urgency: 3, updated_at: AT, expires_at: null,
  }]);
  db.seed('family_members', [{ id: MEMBER, family_id: FAMILY, user_id: USER, role: 'parent', is_active: true }]);
  db.seed('user_preferences', [{ user_id: USER, active_family_id: FAMILY }]);
  const original = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation((table: string) => {
    const query = original(table);
    let op: 'select' | 'insert' | 'update' = 'select';
    const insert = query.insert.bind(query); query.insert = (rows) => {
      op = 'insert'; if (table === 'family_reminders') { const before = beforeReminderInsert; beforeReminderInsert = null; before?.(); } return insert(rows);
    };
    const update = query.update.bind(query); query.update = (patch) => {
      op = 'update'; if (table === 'autopilot_suggestions') { const before = beforeStamp; beforeStamp = null; before?.(); } return update(patch);
    };
    const run = (next: () => ReturnType<typeof query.single>): ReturnType<typeof query.single> => {
      calls.push({ table, op });
      if (failure?.table === table && failure.op === op) {
        if (failure.thrown) return Promise.reject(new Error('transport failed'));
        return Promise.resolve({ data: null, error: failure.empty ? null : { code: 'XX000', message: 'unavailable', details: null, hint: null }, count: null, status: 503, statusText: 'unavailable' });
      }
      return next();
    };
    const single = query.single.bind(query); query.single = () => run(single);
    const maybeSingle = query.maybeSingle.bind(query); query.maybeSingle = () => run(maybeSingle);
    return query;
  });
  scope = { db: db as unknown as ServiceScope['db'], userId: USER, memberId: MEMBER, familyId: FAMILY, role: 'parent', actorKind: 'member', tz: 'UTC', now: new Date(AT) };
  mocks.server.mockResolvedValue(db);
  mocks.context.mockResolvedValue({ user: { id: USER }, memberships: [{ familyId: FAMILY }], active: { familyId: FAMILY, role: 'parent', member: { id: MEMBER }, family: { timezone: 'UTC' } } });
});

describe('source-bound Autopilot reminder acceptance', () => {
  it('persists legal canonical columns from the source, then records execution', async () => {
    expect(await resolveSuggestion(scope, input)).toMatchObject({ ok: true, status: 'executed' });
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0]).toMatchObject({ family_id: FAMILY, member_id: MEMBER, assigned_to_id: null, created_by: USER,
      title: 'Passport renewal', notes: 'Bring the existing documents', remind_at: '2026-09-12T09:00:00.000Z',
      status: 'active', priority: 'high', kind: 'time', ai_suggested: true, idempotency_key: suggestionReminderKey(FAMILY, ID) });
    expect(source()).toMatchObject({ status: 'executed', resolved_by: USER });
    expect(calls.findIndex((call) => call.table === 'family_reminders' && call.op === 'insert'))
      .toBeLessThan(calls.findIndex((call) => call.table === 'autopilot_suggestions' && call.op === 'update'));
  });
  it.each([false, true])('failed create (transport=%s) leaves the suggestion open', async (thrown) => {
    failure = { table: 'family_reminders', op: 'insert', thrown };
    expect(await resolveSuggestion(scope, input)).toEqual({ ok: false, code: 'unavailable' });
    expect(reminders()).toHaveLength(0); expect(source().status).toBe('open');
    expect(calls.some((call) => call.table === 'autopilot_suggestions' && call.op === 'update')).toBe(false);
  });
  it.each(['error', 'throw', 'empty'] as const)('repairs a failed %s stamp after a fresh page/request without another reminder', async (mode) => {
    failure = { table: 'autopilot_suggestions', op: 'update', thrown: mode === 'throw', empty: mode === 'empty' };
    const initial = await resolveAutopilotSuggestionAction(request);
    expect(initial).toMatchObject({ ok: false, saved: true, code: 'resolutionPending' });
    expect(source().status).toBe('open'); expect(reminders()).toHaveLength(1);
    const id = reminders()[0].id;
    reminders()[0].title = 'Edited by the family';
    failure = null;
    // No retained component state, submission ID or operation key is sent.
    expect(await resolveAutopilotSuggestionAction({ ...request })).toEqual({ ok: true, status: 'executed', reminderId: id });
    expect(reminders()).toHaveLength(1); expect(reminders()[0].title).toBe('Edited by the family');
    expect(calls.filter((call) => call.table === 'family_reminders' && call.op === 'insert')).toHaveLength(1);
  });
  it('concurrent accepts share one persisted reminder and both observe its resolution', async () => {
    const results = await Promise.all([resolveSuggestion(scope, input), resolveSuggestion({ ...scope }, { ...input })]);
    expect(results.every((result) => result.ok)).toBe(true); expect(reminders()).toHaveLength(1);
    expect(results[0]).toEqual(results[1]);
  });
  it('a changed source prevents creating work from a stale displayed suggestion', async () => {
    source().updated_at = '2026-09-09T11:00:00Z'; source().payload = { title: 'Changed', at: AT };
    expect(await resolveSuggestion(scope, input)).toEqual({ ok: false, code: 'changed' }); expect(reminders()).toHaveLength(0);
  });
  it('never stamps a revised proposal using an earlier reminder, even after refresh', async () => {
    failure = { table: 'autopilot_suggestions', op: 'update' };
    await resolveSuggestion(scope, input);
    source().updated_at = '2026-09-09T11:00:00Z'; source().payload = { title: 'New content', at: 'invalid' }; source().expires_at = '2026-01-01';
    failure = null;
    expect(await resolveSuggestion(scope, input)).toMatchObject({ ok: false, saved: true });
    expect(await resolveSuggestion(scope, { ...input, updatedAt: String(source().updated_at) })).toMatchObject({ ok: false, code: 'sourceChanged', saved: true });
    expect(source().status).toBe('open');
    expect(reminders()).toHaveLength(1); expect(reminders()[0].title).toBe('Passport renewal');
  });
  it('can refresh and repair the same proposal after an unrelated timestamp/expiry change', async () => {
    failure = { table: 'autopilot_suggestions', op: 'update' }; await resolveSuggestion(scope, input); failure = null;
    source().updated_at = '2026-09-09T11:00:00Z'; source().expires_at = '2026-01-01';
    expect(await resolveSuggestion(scope, input)).toMatchObject({ ok: false, code: 'sourceChanged', saved: true });
    expect(await resolveSuggestion(scope, { ...input, updatedAt: String(source().updated_at) })).toMatchObject({ ok: true });
    expect(reminders()).toHaveLength(1);
  });
  it('does not invent capture provenance when an existing receipt has lost its source tag', async () => {
    failure = { table: 'autopilot_suggestions', op: 'update' }; await resolveSuggestion(scope, input); failure = null;
    reminders()[0].tags = ['user-tag'];
    expect(await resolveSuggestion(scope, input)).toMatchObject({ ok: false, code: 'sourceChanged', saved: true });
    expect(reminders()).toHaveLength(1); expect(source().status).toBe('open');
  });
  it('does not stamp a revised proposal when an old receipt wins the reminder insert race', async () => {
    failure = { table: 'autopilot_suggestions', op: 'update' }; await resolveSuggestion(scope, input);
    const earlier = { ...reminders()[0] }; reminders().length = 0; failure = null;
    source().payload = { title: 'Revised proposal', at: '2026-09-14T09:00:00Z' }; source().updated_at = '2026-09-09T11:00:00Z';
    beforeReminderInsert = () => { db.seed('family_reminders', [earlier]); };
    expect(await resolveSuggestion(scope, { ...input, updatedAt: String(source().updated_at) })).toEqual({ ok: false, code: 'sourceChanged', saved: true, reminderId: earlier.id });
    expect(reminders()).toHaveLength(1); expect(reminders()[0].title).toBe('Passport renewal'); expect(source().status).toBe('open');
  });
  it('keeps a changed source open when its payload changes after reminder creation but before resolution', async () => {
    beforeStamp = () => { source().payload = { title: 'Revised', at: AT }; source().updated_at = '2026-09-09T11:00:00Z'; };
    expect(await resolveSuggestion(scope, input)).toMatchObject({ ok: false, code: 'sourceChanged', saved: true });
    expect(reminders()).toHaveLength(1); expect(source().status).toBe('open');
  });
  it.each(['approved', 'executed', 'auto_executed', 'dismissed', 'snoozed'])('does not recreate uncertain legacy %s work', async (status) => {
    source().status = status;
    expect(await resolveSuggestion(scope, input)).toEqual({ ok: false, code: 'changed' }); expect(reminders()).toHaveLength(0);
  });
  it.each(['nudge', 'plan_meals', 'review_conflict', 'keep_grocery', 'unknown'])('refuses direct execution of %s', async (action) => {
    source().action_type = action;
    expect(await resolveSuggestion(scope, input)).toEqual({ ok: false, code: 'unsupported' });
    expect(reminders()).toHaveLength(0); expect(source().status).toBe('open');
  });
  it('keeps standing policy acceptance outside reminder execution', async () => {
    source().kind = 'policy'; expect(await resolveSuggestion(scope, input)).toEqual({ ok: false, code: 'unsupported' });
  });
  it.each(['autopilot_suggestions', 'family_reminders', 'family_members'])('fails closed on required %s reads', async (table) => {
    failure = { table, op: 'select' }; expect(await resolveSuggestion(scope, input)).toEqual({ ok: false, code: 'unavailable' });
    expect(reminders()).toHaveLength(0); expect(source().status).toBe('open');
  });
  it('rejects a foreign source without returning its contents', async () => {
    source().family_id = OTHER;
    expect(await resolveSuggestion(scope, input)).toEqual({ ok: false, code: 'notFound' }); expect(reminders()).toHaveLength(0);
  });
  it('rejects a foreign recipient and never uses payload recipient fields', async () => {
    db.table('family_members')[0].family_id = OTHER;
    expect(await resolveSuggestion(scope, input)).toEqual({ ok: false, code: 'invalid' }); expect(reminders()).toHaveLength(0);
  });
  it('dismissing is a decision, not execution', async () => {
    source().action_type = 'nudge';
    expect(await resolveSuggestion(scope, { ...input, action: 'dismiss' })).toEqual({ ok: true, status: 'dismissed' });
    expect(source().status).toBe('dismissed'); expect(reminders()).toHaveLength(0);
  });
});

describe('Autopilot action authorization', () => {
  it.each([false, true])('fails closed on a feature override read failure (transport=%s)', async (thrown) => {
    failure = { table: 'app_settings', op: 'select', thrown };
    expect(await resolveAutopilotSuggestionAction(request)).toEqual({ ok: false, code: 'unavailable' });
    expect(calls.some((call) => call.table === 'autopilot_suggestions')).toBe(false);
  });
  it.each(['off', 'malformed'])('honors a fresh %s feature override before any source work', async (tier) => {
    db.seed('app_settings', [{ key: 'feature_tiers', value: { autopilot: tier } }]);
    expect(await resolveAutopilotSuggestionAction(request)).toEqual({ ok: false, code: tier === 'off' ? 'accessDenied' : 'unavailable' });
    expect(calls.some((call) => call.table === 'autopilot_suggestions')).toBe(false);
  });
  it('honors the current plan and preserves legitimate super-admin preview bypass', async () => {
    mocks.plan.mockResolvedValue(0);
    expect(await resolveAutopilotSuggestionAction(request)).toEqual({ ok: false, code: 'accessDenied' });
    mocks.superAdmin.mockResolvedValue(true); failure = { table: 'app_settings', op: 'select' };
    expect(await resolveAutopilotSuggestionAction(request)).toMatchObject({ ok: true });
  });
  it('preserves confirmed save outcomes when cache invalidation fails', async () => {
    mocks.revalidate.mockImplementation(() => { throw new Error('cache unavailable'); });
    expect(await resolveAutopilotSuggestionAction(request)).toMatchObject({ ok: true, status: 'executed' }); expect(reminders()).toHaveLength(1);
  });
  it('enforces the same feature guard as the page before accessing the source', async () => {
    mocks.context.mockRejectedValue(new Error('NEXT_REDIRECT'));
    await expect(resolveAutopilotSuggestionAction(request)).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.context).toHaveBeenCalledWith('/dashboard/autopilot'); expect(mocks.server).not.toHaveBeenCalled();
  });
  it.each(['expectedFamilyId', 'expectedUserId'] as const)('rejects changed %s before reads', async (field) => {
    expect(await resolveAutopilotSuggestionAction({ ...request, [field]: OTHER })).toEqual({ ok: false, code: 'contextChanged' }); expect(calls).toHaveLength(0);
  });
  it.each(['user_preferences', 'family_members'])('does not authorize through a failed %s read', async (table) => {
    failure = { table, op: 'select' };
    expect(await resolveAutopilotSuggestionAction(request)).toEqual({ ok: false, code: 'unavailable' });
    expect(calls.some((call) => call.table === 'autopilot_suggestions')).toBe(false);
  });
  it.each(['role', 'user_id', 'family_id', 'is_active'])('rejects changed current membership %s', async (field) => {
    db.table('family_members')[0][field] = field === 'is_active' ? false : field === 'role' ? 'guest' : OTHER;
    expect(await resolveAutopilotSuggestionAction(request)).toEqual({ ok: false, code: 'contextChanged' }); expect(reminders()).toHaveLength(0);
  });
  it('rejects a household switched after context resolution', async () => {
    mocks.context.mockResolvedValue({ user: { id: USER }, memberships: [{ familyId: FAMILY }, { familyId: OTHER }], active: { familyId: FAMILY, role: 'parent', member: { id: MEMBER }, family: { timezone: 'UTC' } } });
    db.table('user_preferences')[0].active_family_id = OTHER;
    expect(await resolveAutopilotSuggestionAction(request)).toEqual({ ok: false, code: 'contextChanged' }); expect(reminders()).toHaveLength(0);
  });
  it('rejects a newly joined active household missing from the earlier context snapshot', async () => {
    db.table('user_preferences')[0].active_family_id = OTHER;
    expect(await resolveAutopilotSuggestionAction(request)).toEqual({ ok: false, code: 'contextChanged' });
    expect(calls.some((call) => call.table === 'autopilot_suggestions')).toBe(false);
  });
  it('does not accept caller payload, recipient, action type or operation key', async () => {
    expect(await resolveAutopilotSuggestionAction({ ...request, idempotencyKey: 'fake', payload: {}, familyId: OTHER } as typeof request)).toEqual({ ok: false, code: 'invalid' }); expect(reminders()).toHaveLength(0);
  });
});
