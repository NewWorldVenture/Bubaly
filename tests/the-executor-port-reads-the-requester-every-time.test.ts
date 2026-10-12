// The production executor port answers "who is this run acting for?" from the
// database every time it is asked.
//
// `createExecutorPort` kept the first answer per run in a map, so the graph's
// re-read before each later batch (lib/ai/runs/executor.ts) would have been
// served the requester as they were when the run was claimed. Review on #1028
// reproduced a removed and a demoted requester having a dependent step run.
// Driven through the real port and loadRunActor over an in-memory database.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const hoisted = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => hoisted.db }));

const { createExecutorPort } = await import('@/lib/ai/runs/executor');
type RunSnapshot = import('@/lib/ai/runs/executor').RunSnapshot;

const FAMILY = '00000000-0000-4000-8000-0000000b0b01';
const MEMBER = '00000000-0000-4000-8000-0000000b1b01';
const USER = '00000000-0000-4000-8000-0000000b2b01';
const REQUEST = '00000000-0000-4000-8000-0000000b4b01';
const PLAN = '00000000-0000-4000-8000-0000000b4b02';
const RUN = '00000000-0000-4000-8000-0000000b4b03';

let db: InMemorySupabase;

const run = {
  id: RUN, family_id: FAMILY, plan_id: PLAN, request_id: REQUEST, state: 'executing', cancel_requested_at: null, paused_at: null,
  requested_by_member_id: MEMBER, attempt: 1, max_attempts: 5, lease_owner: 'worker-1',
} as unknown as RunSnapshot;

const member = () => db.table('family_members').find((row) => row.id === MEMBER)!;

beforeEach(() => {
  db = createInMemorySupabase();
  hoisted.db = db;
  db.seed('families', [{ id: FAMILY, name: 'The Okafors', timezone: 'Europe/London' }]);
  db.seed('family_members', [{ id: MEMBER, family_id: FAMILY, user_id: USER, role: 'parent', is_active: true, display_name: 'Ada' }]);
  db.seed('ai_requests', [{ id: REQUEST, family_id: FAMILY, requested_by: USER, requested_by_member_id: MEMBER, kind: 'concierge', request_text: 'Plan the week', status: 'ready' }]);
  db.seed('ai_plans', [{ id: PLAN, family_id: FAMILY, request_id: REQUEST, version: 1, status: 'approved', risk_level: 'low' }]);
});

describe('the executor port reads the requester every time it is asked', () => {
  it('answers with the role the member holds now', async () => {
    const port = createExecutorPort(db as unknown as SupabaseClient<Database>);
    const first = await port.scopeFor(run);
    expect(first.ok && first.data.role).toBe('parent');

    member().role = 'teen';
    const second = await port.scopeFor(run);
    expect(second.ok && second.data.role).toBe('teen');
  });

  it('refuses once the member is no longer active', async () => {
    const port = createExecutorPort(db as unknown as SupabaseClient<Database>);
    expect((await port.scopeFor(run)).ok).toBe(true);

    member().is_active = false;
    const after = await port.scopeFor(run);
    expect(after.ok).toBe(false);
    expect(!after.ok && after.error).toMatch(/no longer an active member/);
  });

  it('answers the same for a requester nothing happened to (control)', async () => {
    const port = createExecutorPort(db as unknown as SupabaseClient<Database>);
    const first = await port.scopeFor(run);
    const second = await port.scopeFor(run);
    expect(first.ok && second.ok).toBe(true);
    expect(second.ok && second.data).toMatchObject({ familyId: FAMILY, memberId: MEMBER, userId: USER, role: 'parent', tz: 'Europe/London', actorKind: 'ai' });
  });
});
