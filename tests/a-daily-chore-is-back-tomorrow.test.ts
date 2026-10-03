import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { at, bodyOf } from './helpers/source-order';

/**
 * A DAILY CHORE WAS DONE ONCE, EVER.
 *
 * A chore carries a `recurrence`, and the board groups its tabs by it (Daily,
 * Weekly). But an assignment is one row: approving it — from the missions
 * screen (`finalizeApproval`, app/(app)/missions/actions.ts) or the chores
 * board (`approve`, components/modules/chores-module.tsx) — flipped it to
 * `approved`, and nothing created the next one. "Make your bed, daily, 10
 * points" was assigned once; the morning after it was approved the Daily tab
 * was empty and the child had nothing to do.
 *
 * The fix is one service function, `respawnChoreAssignment`: once an
 * assignment of a recurring chore is approved, the child's next one is
 * created, due per `nextChoreDueAt` (stepped from the approved one's due time
 * until it is after now), unless they already have an open one. It is keyed
 * through 0256's unique index so the two approval screens — or two approvals
 * arriving together — create one. The server finalizer calls it after the
 * payout; the board calls a manager-only action after its one direct write.
 */

type DB = SupabaseClient<Database>;
const FAMILY = 'fam-ch';
const KID = 'kid-1';
const PARENT = 'parent-1';
const NOW = '2026-10-03T19:00:00.000Z';
const DUE = '2026-10-03T18:00:00.000Z';
const DAY_MS = 86_400_000;
const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const state = vi.hoisted(() => ({ db: null as unknown, ctx: null as unknown }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => state.ctx }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));

const { choreRepeats, nextChoreDueAt } = await import('@/lib/chores/respawn');
const { nextRemindAt } = await import('@/lib/reminders/details');
const { completeChoreAssignment, respawnChoreAssignment } = await import('@/lib/services/tasks');
const { makeKey } = await import('@/lib/services/idempotency');
const { approveSubmissionAction } = await import('@/app/(app)/missions/actions');
const { respawnChoreAssignmentAction } = await import('@/app/(app)/dashboard/chores/actions');

let db: ReturnType<typeof createInMemorySupabase<DB>>;
const parentCtx = () => ({ user: { id: 'u-parent' }, active: { familyId: FAMILY, role: 'parent', member: { id: PARENT }, family: { timezone: 'UTC' } } });
const childCtx = () => ({ user: { id: 'u-kid' }, active: { familyId: FAMILY, role: 'child', member: { id: KID }, family: { timezone: 'UTC' } } });
const scope = (): ServiceScope => ({ db: db as unknown as DB, familyId: FAMILY, userId: 'u-parent', memberId: PARENT, role: 'parent', actorKind: 'member', tz: 'UTC', now: new Date(NOW) });
const assignmentsOf = (chore: string) => db.table('chore_assignments').filter((a) => a.chore_id === chore);
const openOf = (chore: string) => assignmentsOf(chore).filter((a) => ['todo', 'in_progress'].includes(a.status as string));
const TOMORROW = nextRemindAt(DUE, 'daily')!;
const KEY = makeKey(['tasks.respawnChore', FAMILY, 'chore-daily', KID, TOMORROW]);

function assignment(id: string, chore: string, extra: Record<string, unknown> = {}) {
  return {
    id, family_id: FAMILY, chore_id: chore, member_id: KID, status: 'submitted', due_at: DUE, submitted_at: DUE,
    approved_at: null, approved_by: null, points_awarded: null, cash_awarded_cents: null, ai_score: null, disputed: false,
    idempotency_key: `seed-${id}`, ...extra,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase<DB>({
    uniques: { chore_assignments: [['family_id', 'idempotency_key']] },
    rpc: {
      kid_progress_apply_completion: () => ({
        ok: true, xp: 30, level: 1, current_streak: 1, longest_streak: 1, last_activity: '2026-10-03',
        previous_level: 1, previous_streak: 0, previous_longest_streak: 0, previous_last_activity: null,
      }),
    },
  });
  db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
  db.seed('family_members', [
    { id: KID, family_id: FAMILY, role: 'child', is_active: true, user_id: 'u-kid', display_name: 'Kid' },
    { id: PARENT, family_id: FAMILY, role: 'parent', is_active: true, user_id: 'u-parent', display_name: 'Parent' },
  ]);
  db.seed('chores', [
    { id: 'chore-daily', family_id: FAMILY, title: 'Make your bed', recurrence: 'daily', points: 10, difficulty: 'easy', reward_mode: 'fixed_points', proof_required: 'none', requires_approval: true, due_at: DUE, is_active: true },
    { id: 'chore-once', family_id: FAMILY, title: 'Wash the car', recurrence: 'none', points: 20, difficulty: 'medium', reward_mode: 'fixed_points', proof_required: 'none', requires_approval: true, due_at: DUE, is_active: true },
  ]);
  db.seed('chore_assignments', [assignment('asg-daily', 'chore-daily'), assignment('asg-once', 'chore-once')]);
  db.seed('chore_submissions', [
    { id: 'sub-daily', family_id: FAMILY, assignment_id: 'asg-daily', chore_id: 'chore-daily', member_id: KID, status: 'pending' },
    { id: 'sub-once', family_id: FAMILY, assignment_id: 'asg-once', chore_id: 'chore-once', member_id: KID, status: 'pending' },
  ]);
  db.seed('kid_progress', [{ id: 'kp-1', family_id: FAMILY, member_id: KID, xp: 20, level: 1, current_streak: 1, longest_streak: 1, last_activity: null }]);
  state.db = db;
  state.ctx = parentCtx();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('nextChoreDueAt', () => {
  it('repeats for any cadence but none', () => {
    expect(choreRepeats('daily')).toBe(true);
    expect(choreRepeats('none')).toBe(false);
    expect(choreRepeats(null)).toBe(false);
    expect(choreRepeats(undefined)).toBe(false);
  });
  it('a chore approved on the day is next due at the same time tomorrow', () => {
    expect(nextChoreDueAt(DUE, 'daily', NOW)).toBe(TOMORROW);
    expect(Date.parse(TOMORROW) - Date.parse(DUE)).toBe(DAY_MS);
  });
  it('a chore approved late is next due after now, not on dates already past', () => {
    const next = nextChoreDueAt('2026-09-28T18:00:00.000Z', 'daily', NOW)!;
    expect(Date.parse(next)).toBeGreaterThan(Date.parse(NOW));
    expect(Date.parse(next) - Date.parse(NOW)).toBeLessThanOrEqual(DAY_MS);
    expect(next).toBe(TOMORROW);
    expect(nextChoreDueAt('2026-09-05T18:00:00.000Z', 'weekly', NOW)).toBe('2026-10-10T18:00:00.000Z');
  });
  it('an assignment with no due time steps from now', () => {
    expect(nextChoreDueAt(null, 'daily', NOW)).toBe(nextRemindAt(NOW, 'daily'));
  });
  it('a one-off, an unknown cadence, or an unreadable now gives nothing', () => {
    expect(nextChoreDueAt(DUE, 'none', NOW)).toBeNull();
    expect(nextChoreDueAt(DUE, 'sometimes', NOW)).toBeNull();
    expect(nextChoreDueAt(DUE, 'daily', 'now')).toBeNull();
  });
});

describe('respawnChoreAssignment', () => {
  const approved = () => ({ chore_id: 'chore-daily', member_id: KID, due_at: DUE });
  it('creates the next assignment, open, due tomorrow, keyed', async () => {
    const res = await respawnChoreAssignment(scope(), { assignment: approved(), recurrence: 'daily' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.respawned).toBe(true);
    expect(res.data.assignment).toMatchObject({ family_id: FAMILY, chore_id: 'chore-daily', member_id: KID, status: 'todo', due_at: TOMORROW, idempotency_key: KEY });
    expect(openOf('chore-daily')).toHaveLength(1);
  });
  it('does not create a second while the child already has an open one', async () => {
    await respawnChoreAssignment(scope(), { assignment: approved(), recurrence: 'daily' });
    const again = await respawnChoreAssignment(scope(), { assignment: approved(), recurrence: 'daily' });
    expect(again).toEqual({ ok: true, data: { assignment: null, respawned: false } });
    expect(openOf('chore-daily')).toHaveLength(1);
  });
  it('a key already written — by the other approval screen — is not a failure and not a duplicate', async () => {
    // No open assignment, but the next one was already created and even approved.
    db.seed('chore_assignments', [assignment('asg-next', 'chore-daily', { status: 'approved', due_at: TOMORROW, idempotency_key: KEY })]);
    const res = await respawnChoreAssignment(scope(), { assignment: approved(), recurrence: 'daily' });
    expect(res).toEqual({ ok: true, data: { assignment: null, respawned: false } });
    expect(assignmentsOf('chore-daily')).toHaveLength(2);
  });
  it('a chore that does not repeat creates nothing', async () => {
    const res = await respawnChoreAssignment(scope(), { assignment: { chore_id: 'chore-once', member_id: KID, due_at: DUE }, recurrence: 'none' });
    expect(res).toEqual({ ok: true, data: { assignment: null, respawned: false } });
    expect(assignmentsOf('chore-once')).toHaveLength(1);
  });
  it('refuses a member who is not in this family', async () => {
    db.seed('family_members', [{ id: 'kid-elsewhere', family_id: 'fam-other', role: 'child', is_active: true }]);
    const res = await respawnChoreAssignment(scope(), { assignment: { chore_id: 'chore-daily', member_id: 'kid-elsewhere', due_at: DUE }, recurrence: 'daily' });
    expect(res.ok).toBe(false);
    expect(db.table('chore_assignments').some((a) => a.member_id === 'kid-elsewhere')).toBe(false);
  });
});

describe('approving from the missions screen', () => {
  const approve = (submission: string) => { const form = new FormData(); form.set('submission_id', submission); return approveSubmissionAction(form); };
  it('a daily chore is back tomorrow', async () => {
    expect(await approve('sub-daily')).toEqual({ ok: true });
    expect(db.table('chore_assignments').find((a) => a.id === 'asg-daily')).toMatchObject({ status: 'approved', points_awarded: 10 });
    const [next] = openOf('chore-daily');
    expect(next).toMatchObject({ member_id: KID, status: 'todo', due_at: TOMORROW, idempotency_key: KEY });
  });
  it('a one-off is simply done', async () => {
    expect(await approve('sub-once')).toEqual({ ok: true });
    expect(openOf('chore-once')).toHaveLength(0);
  });
  it('approving the same submission again does not create a second', async () => {
    await approve('sub-daily');
    await approve('sub-daily');
    expect(openOf('chore-daily')).toHaveLength(1);
    expect(assignmentsOf('chore-daily')).toHaveLength(2);
  });
});

describe('a chore that needs no approval comes back when the child finishes it', () => {
  // Such a chore settles as `done` in `completeChoreAssignment`, never reaching
  // an approval — so the respawn has to live there too.
  const kidScope = (): ServiceScope => ({ ...scope(), userId: 'u-kid', memberId: KID, role: 'child' });
  it('a daily chore finished today is assigned again for tomorrow', async () => {
    Object.assign(db.table('chores').find((c) => c.id === 'chore-daily')!, { requires_approval: false });
    Object.assign(db.table('chore_assignments').find((a) => a.id === 'asg-daily')!, { status: 'in_progress' });
    const done = await completeChoreAssignment(kidScope(), 'asg-daily');
    expect(done.ok).toBe(true);
    if (done.ok) expect(done.data.status).toBe('done');
    const [next] = openOf('chore-daily');
    expect(next).toMatchObject({ member_id: KID, status: 'todo', due_at: TOMORROW, idempotency_key: KEY });
    // Finishing it again (a double tap) does not create a second.
    await completeChoreAssignment(kidScope(), 'asg-daily');
    expect(openOf('chore-daily')).toHaveLength(1);
  });
  it('a chore that needs approval is only submitted here — the approval respawns it', async () => {
    Object.assign(db.table('chore_assignments').find((a) => a.id === 'asg-daily')!, { status: 'in_progress' });
    const done = await completeChoreAssignment(kidScope(), 'asg-daily');
    if (done.ok) expect(done.data.status).toBe('submitted');
    expect(openOf('chore-daily')).toHaveLength(0);
  });
  it('a one-off that needs no approval is simply done', async () => {
    Object.assign(db.table('chores').find((c) => c.id === 'chore-once')!, { requires_approval: false });
    Object.assign(db.table('chore_assignments').find((a) => a.id === 'asg-once')!, { status: 'in_progress' });
    await completeChoreAssignment(kidScope(), 'asg-once');
    expect(openOf('chore-once')).toHaveLength(0);
    expect(assignmentsOf('chore-once')).toHaveLength(1);
  });
});

describe('the chores board asks the service after its own approval', () => {
  it('a manager gets the next assignment created, once', async () => {
    Object.assign(db.table('chore_assignments').find((a) => a.id === 'asg-daily')!, { status: 'approved', approved_at: NOW, approved_by: PARENT });
    const first = await respawnChoreAssignmentAction('asg-daily');
    expect(first.ok).toBe(true);
    expect(openOf('chore-daily')).toHaveLength(1);
    const second = await respawnChoreAssignmentAction('asg-daily');
    expect(second.ok).toBe(true);
    expect(openOf('chore-daily')).toHaveLength(1);
  });
  it('a child cannot mint assignments by naming one', async () => {
    Object.assign(db.table('chore_assignments').find((a) => a.id === 'asg-daily')!, { status: 'approved', approved_at: NOW });
    state.ctx = childCtx();
    const res = await respawnChoreAssignmentAction('asg-daily');
    expect(res.ok).toBe(false);
    expect(openOf('chore-daily')).toHaveLength(0);
  });
  it('an assignment that is not approved creates nothing', async () => {
    const res = await respawnChoreAssignmentAction('asg-daily');
    expect(res).toEqual({ ok: false, error: 'actions.thatChoreCouldNotBe' });
    expect(openOf('chore-daily')).toHaveLength(0);
  });
});

describe('both approval paths reach the service', () => {
  it('the finalizer, after the payout and the event', () => {
    const src = read('app/(app)/missions/actions.ts');
    const body = bodyOf(src, 'async function finalizeApproval(', "'[chore approval] next assignment of a recurring chore was not created'");
    expect(body).toContain('respawnChoreAssignment(args.scope, {');
    expect(at(body, 'await logChoreEvent({')).toBeLessThan(at(body, 'respawnChoreAssignment(args.scope'));
    expect(src).toContain('auto: true, scope: scopeFromUserContext(ctx, service) });');
    expect(src).toContain('auto: false, scope: scopeFromUserContext(ctx, supabase),');
  });
  it('the board, after its one direct write', () => {
    const src = read('components/modules/chores-module.tsx');
    const body = bodyOf(src, 'async function approve(a: Assignment) {', "success(tr('choresModule.approvedPlusPoints'");
    expect(body).toContain("if (a.chore && a.chore.recurrence !== 'none')");
    expect(body).toContain('await respawnChoreAssignmentAction(a.id)');
    expect(at(body, 'if (wroteNoRows(approved))')).toBeLessThan(at(body, 'respawnChoreAssignmentAction(a.id)'));
  });
});
