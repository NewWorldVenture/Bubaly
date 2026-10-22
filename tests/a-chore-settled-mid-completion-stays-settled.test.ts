// `completeChoreAssignment` checks a child's or teen's right to finish a chore
// — it is theirs, and a parent has not approved it yet — on its FIRST read of
// the assignment, then writes the new status filtered by id and family only.
// A parent approving the chore, or handing it to a sibling, in between was
// overwritten: the approved chore and its points went back to "submitted", or
// the sibling's chore was marked done by someone it no longer belonged to. The
// run executor writes on the service client, where 0374's settled-row trigger
// steps aside (`auth.uid() is null`), so nothing below the service stopped it.
//
// For anyone but a parent, adult or the system, the write now carries both
// checks itself — `member_id` and "not approved" — and a write they stopped is
// reported as the refusal it is. Driven through the real service and, for the
// executor, through the real run executor and `executeTool`; the other
// writer's change lands between the service's read and its write.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const hoisted = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => hoisted.db }));

const { completeChoreAssignment } = await import('@/lib/services/tasks');
const { createExecutorPort, runGraphWith } = await import('@/lib/ai/runs/executor');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');

const FAMILY = '00000000-0000-4000-8000-0000000ae001';
const TEEN = { member: '00000000-0000-4000-8000-0000000ae011', user: '00000000-0000-4000-8000-0000000ae021' };
const SIBLING = { member: '00000000-0000-4000-8000-0000000ae012', user: '00000000-0000-4000-8000-0000000ae022' };
const PARENT = { member: '00000000-0000-4000-8000-0000000ae013', user: '00000000-0000-4000-8000-0000000ae023' };
const CHORE = '00000000-0000-4000-8000-0000000ae031';
const ASSIGNMENT = '00000000-0000-4000-8000-0000000ae041';
const REQUEST = '00000000-0000-4000-8000-0000000ae051';
const PLAN = '00000000-0000-4000-8000-0000000ae052';
const RUN = '00000000-0000-4000-8000-0000000ae053';

const SETTLED = translate(SOURCE_MESSAGES, 'chores.approvedIsSettled');
const NOT_YOURS = translate(SOURCE_MESSAGES, 'chores.notYourAssignment');

let store: InMemorySupabase;

/** A parent's approval of the teen's chore — what 0223's trigger lets a manager write. */
const PARENT_APPROVES = { status: 'approved', approved_at: '2026-09-05T12:00:00Z', approved_by: PARENT.member };
/** A parent handing the chore to the teen's sibling. */
const PARENT_REASSIGNS = { member_id: SIBLING.member };

/**
 * The store, with another writer's change to the assignment landing once,
 * between the service's read of it and its write: on the service's read of the
 * chore itself, which sits between the two.
 */
function anotherWriterLandsMidway(patch: Record<string, unknown>): SupabaseClient<Database> {
  let landed = false;
  return new Proxy(store as object, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (table: string) => {
        if (table === 'chores' && !landed) {
          landed = true;
          Object.assign(store.table('chore_assignments').find((r) => r.id === ASSIGNMENT)!, patch);
        }
        return store.from(table);
      };
    },
  }) as unknown as SupabaseClient<Database>;
}

const scopeFor = (db: SupabaseClient<Database>, who: typeof TEEN, role: ServiceScope['role']): ServiceScope => ({
  db, familyId: FAMILY, userId: who.user, memberId: who.member, role, actorKind: 'ai', tz: 'America/New_York',
});

const assignment = () => store.table('chore_assignments').find((r) => r.id === ASSIGNMENT)!;

beforeEach(() => {
  store = createInMemorySupabase({
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
    defaults: { ai_tool_calls: { state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null } },
  });
  hoisted.db = store;
  store.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' }]);
  store.seed('family_members', [
    { id: TEEN.member, family_id: FAMILY, user_id: TEEN.user, role: 'teen', is_active: true, display_name: 'Sam' },
    { id: SIBLING.member, family_id: FAMILY, user_id: SIBLING.user, role: 'child', is_active: true, display_name: 'Lily' },
    { id: PARENT.member, family_id: FAMILY, user_id: PARENT.user, role: 'parent', is_active: true, display_name: 'Dana' },
  ]);
  store.seed('chores', [{ id: CHORE, family_id: FAMILY, title: 'Dishes', requires_approval: true, recurrence: null }]);
  store.seed('chore_assignments', [{
    id: ASSIGNMENT, family_id: FAMILY, chore_id: CHORE, member_id: TEEN.member, status: 'todo', due_at: '2026-09-06T00:00:00Z',
    submitted_at: null, approved_at: null, approved_by: null,
  }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a teen finishing their chore does not undo a parent’s decision made meanwhile', () => {
  it('leaves a chore a parent approved in between approved — its points stay settled', async () => {
    const res = await completeChoreAssignment(scopeFor(anotherWriterLandsMidway(PARENT_APPROVES), TEEN, 'teen'), ASSIGNMENT);

    expect(res).toMatchObject({ ok: false, code: 'denied', error: SETTLED });
    expect(assignment()).toMatchObject({ status: 'approved', approved_by: PARENT.member, submitted_at: null, member_id: TEEN.member });
  });

  it('leaves a chore a parent handed to a sibling in between as the sibling’s, untouched', async () => {
    const res = await completeChoreAssignment(scopeFor(anotherWriterLandsMidway(PARENT_REASSIGNS), TEEN, 'teen'), ASSIGNMENT);

    expect(res).toMatchObject({ ok: false, code: 'denied', error: NOT_YOURS });
    expect(assignment()).toMatchObject({ member_id: SIBLING.member, status: 'todo', submitted_at: null });
  });

  it('holds on the run executor’s service client too', async () => {
    store.seed('ai_requests', [{ id: REQUEST, family_id: FAMILY, requested_by: TEEN.user, requested_by_member_id: TEEN.member, kind: 'concierge', request_text: 'Mark the dishes done', status: 'ready' }]);
    store.seed('ai_plans', [{ id: PLAN, family_id: FAMILY, request_id: REQUEST, version: 1, status: 'approved', risk_level: 'low' }]);
    store.seed('ai_plan_steps', [{
      id: 'step-done', family_id: FAMILY, plan_id: PLAN, sequence: 0, step_type: 'act', tool_name: 'tasks.completeChore', description: 'Mark the dishes done',
      input_json: { assignment_id: ASSIGNMENT }, dependency_ids: [], condition: null, status: 'queued', approval_required: false,
      approval_id: null, risk_level: 'low', retry_count: 0, max_retries: 0, result_json: null, error: null,
    }]);
    store.seed('family_automation_runs', [{
      id: RUN, family_id: FAMILY, plan_id: PLAN, request_id: REQUEST, run_type: 'concierge', state: 'ready', status: 'pending',
      requested_by_member_id: TEEN.member, attempt: 1, max_attempts: 5, lease_owner: 'worker-1', lease_expires_at: '2099-01-01T00:00:00Z',
      cancel_requested_at: null, paused_at: null, progress: {}, created_by: TEEN.user,
    }]);
    const serviceClient = anotherWriterLandsMidway(PARENT_APPROVES);
    hoisted.db = serviceClient;

    await runGraphWith(createExecutorPort(serviceClient), RUN, { budgetMs: 60_000 });

    expect(assignment()).toMatchObject({ status: 'approved', approved_by: PARENT.member, submitted_at: null });
    expect(store.table('ai_plan_steps')[0]).toMatchObject({ status: 'failed' });
  });

  it('still lets the teen finish it when nothing changed in between', async () => {
    const res = await completeChoreAssignment(scopeFor(store as unknown as SupabaseClient<Database>, TEEN, 'teen'), ASSIGNMENT);

    expect(res).toMatchObject({ ok: true, data: { id: ASSIGNMENT, status: 'submitted' } });
    expect(assignment()).toMatchObject({ status: 'submitted', member_id: TEEN.member });
  });

  it('still lets a parent settle it, as a parent may whoever holds it', async () => {
    const res = await completeChoreAssignment(scopeFor(anotherWriterLandsMidway(PARENT_REASSIGNS), PARENT, 'parent'), ASSIGNMENT);

    expect(res).toMatchObject({ ok: true, data: { status: 'submitted' } });
    expect(assignment()).toMatchObject({ status: 'submitted', member_id: SIBLING.member });
  });
});
