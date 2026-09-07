// M22 — "one view of what Bubaly believes, with a reset".
//
// The two writes this view adds are the ones a family has never had: forget a
// routine Bubaly detected, and reset the traits the autopilot learned about one
// person. Both take something away, so what matters is exactly what they reach:
//
//   * only a parent or adult may run either (the routines panel on the calendar
//     deletes the same `routine_templates` row straight from the browser with no
//     role rule at all — this path adds one);
//   * every filter carries `family_id`, and the trait reset also carries
//     `member_id`, so a reset for one person can never clear another's row and
//     never another household's;
//   * the reset clears ONLY `metadata.autopilot_traits`. The preferences,
//     responsibilities and notes on the same profile row are what a person
//     typed, and a button that says "reset what Bubaly worked out" must not take
//     them.
//
// The actions are exercised through the REAL service against a recording fake
// client, not against a mocked service: a boundary proved with the service
// stubbed out proves only that the stub was called.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { forgetRoutine, resetMemberTraits } from '@/lib/services/memory';
import type { ServiceScope } from '@/lib/services/types';

const ctx = vi.hoisted(() => ({
  user: { id: 'auth-user-1', email: 'parent@example.com' },
  memberships: [],
  active: {
    familyId: 'fam-1',
    family: { id: 'fam-1', name: 'The Riveras', timezone: 'America/New_York' },
    role: 'parent' as string,
    member: { id: 'member-1', family_id: 'fam-1', user_id: 'auth-user-1' },
  },
}));

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));

// The actions run the REAL service against the recording fake below, so what
// these tests pin is the filter that actually reaches PostgREST.
const { forgetRoutineAction, resetMemberTraitsAction } = await import('@/app/(app)/dashboard/settings/ai-actions');

type Call = {
  table: string;
  kind: 'select' | 'insert' | 'update' | 'delete';
  filters: Record<string, unknown>;
  payload?: unknown;
};
type Reply = { data: unknown; error: unknown };

function makeDb(respond: (call: Call) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    Object.assign(b, {
      select: chain, order: chain, limit: chain,
      eq: filter, is: filter,
      in: (c: string, v: unknown) => filter(`in:${c}`, v),
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      delete: () => { call.kind = 'delete'; return b; },
      single: () => Promise.resolve(respond(call)),
      maybeSingle: () => Promise.resolve(respond(call)),
      then: (resolve: (value: Reply) => void) => resolve(respond(call)),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

const NOW = new Date('2026-09-07T09:00:00Z');

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return {
    db, familyId: 'fam-1', userId: 'auth-user-1', memberId: 'member-1', role: 'parent',
    actorKind: 'member', tz: 'America/New_York', now: NOW, ...extra,
  };
}

/** A twin profile whose metadata holds BOTH a learned trait and what a person entered. */
const PROFILE = (metadata: Record<string, unknown>) => ({ id: 'profile-1', metadata });
const LEARNED = { memberId: 'member-2', choreCompletionRate: 0.4, reliabilityScore: 40, sampleSize: 12 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ctx.active.role = 'parent';
});

describe('forgetRoutine', () => {
  it('deletes the routine under the caller’s own family id', async () => {
    const { db, calls } = makeDb((call) => (call.table === 'routine_templates'
      ? { data: { id: 'routine-1', name: 'School mornings' }, error: null }
      : { data: null, error: null }));
    const res = await forgetRoutine(scopeWith(db), 'routine-1');
    expect(res.ok && res.data).toEqual({ id: 'routine-1', name: 'School mornings' });

    const del = calls.find((c) => c.table === 'routine_templates' && c.kind === 'delete');
    expect(del?.filters).toEqual({ family_id: 'fam-1', id: 'routine-1' });
  });

  it.each(['child', 'teen'] as const)('refuses a %s and touches no table', async (role) => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await forgetRoutine(scopeWith(db, { role }), 'routine-1');
    expect(res).toMatchObject({ ok: false, code: 'denied' });
    expect(calls).toHaveLength(0);
  });

  it('refuses an empty id before it reaches the database', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await forgetRoutine(scopeWith(db), '  ');
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('says not-found rather than success when the id belongs to another family', async () => {
    // RLS answers a cross-family delete with zero rows, not an error.
    const { db } = makeDb(() => ({ data: null, error: null }));
    const res = await forgetRoutine(scopeWith(db), 'routine-elsewhere');
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('fails closed and logs when the delete errors', async () => {
    const { db } = makeDb(() => ({ data: null, error: { code: '42501', message: 'permission denied' } }));
    const res = await forgetRoutine(scopeWith(db), 'routine-1');
    expect(res.ok).toBe(false);
    expect(console.error).toHaveBeenCalledWith('[service:memory] routine delete failed', expect.anything());
  });
});

describe('resetMemberTraits', () => {
  it('clears only what Bubaly learned and leaves what a person entered', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'family_digital_twin_profiles' && call.kind === 'select') {
        return { data: PROFILE({ autopilot_traits: LEARNED, notes_from_parent: 'Prefers mornings', focus: 'homework' }), error: null };
      }
      return { data: null, error: null };
    });
    const res = await resetMemberTraits(scopeWith(db), 'member-2');
    expect(res.ok && res.data).toEqual({ cleared: true });

    const update = calls.find((c) => c.table === 'family_digital_twin_profiles' && c.kind === 'update');
    expect(update?.payload).toMatchObject({ metadata: { notes_from_parent: 'Prefers mornings', focus: 'homework' } });
    expect((update?.payload as { metadata: Record<string, unknown> }).metadata).not.toHaveProperty('autopilot_traits');
  });

  it('scopes both the read and the write to this family AND this member', async () => {
    const { db, calls } = makeDb((call) => (call.table === 'family_digital_twin_profiles' && call.kind === 'select'
      ? { data: PROFILE({ autopilot_traits: LEARNED }), error: null }
      : { data: null, error: null }));
    await resetMemberTraits(scopeWith(db), 'member-2');

    const profileCalls = calls.filter((c) => c.table === 'family_digital_twin_profiles');
    expect(profileCalls).toHaveLength(2);
    for (const call of profileCalls) {
      expect(call.filters).toMatchObject({ family_id: 'fam-1', member_id: 'member-2' });
    }
  });

  it.each(['child', 'teen'] as const)('refuses a %s and touches no table', async (role) => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await resetMemberTraits(scopeWith(db, { role }), 'member-2');
    expect(res).toMatchObject({ ok: false, code: 'denied' });
    expect(calls).toHaveLength(0);
  });

  it('writes nothing when there is no learned trait to clear', async () => {
    const { db, calls } = makeDb((call) => (call.table === 'family_digital_twin_profiles'
      ? { data: PROFILE({ focus: 'homework' }), error: null }
      : { data: null, error: null }));
    const res = await resetMemberTraits(scopeWith(db), 'member-2');
    expect(res.ok && res.data).toEqual({ cleared: false });
    expect(calls.filter((c) => c.kind === 'update')).toHaveLength(0);
  });

  it('says not-found rather than success when that member has no profile row', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await resetMemberTraits(scopeWith(db), 'member-9');
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(calls.filter((c) => c.kind === 'update')).toHaveLength(0);
  });

  it('fails closed and logs when the read errors — it does not report a reset that did not happen', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: { code: '08006', message: 'connection failure' } }));
    const res = await resetMemberTraits(scopeWith(db), 'member-2');
    expect(res.ok).toBe(false);
    expect(calls.filter((c) => c.kind === 'update')).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith('[service:memory] twin profile read failed', expect.anything());
  });

  it('fails closed and logs when the update errors', async () => {
    const { db } = makeDb((call) => (call.kind === 'select'
      ? { data: PROFILE({ autopilot_traits: LEARNED }), error: null }
      : { data: null, error: { code: '42501', message: 'permission denied' } }));
    const res = await resetMemberTraits(scopeWith(db), 'member-2');
    expect(res.ok).toBe(false);
    expect(console.error).toHaveBeenCalledWith('[service:memory] twin trait reset failed', expect.anything());
  });
});

// ─── The action skins ───────────────────────────────────────────────────────
//
// A server action that reimplemented the manager check would be the one place
// a child could widen what this panel does, so these prove the actions add no
// rule of their own: the refusal a child gets is the service's own sentence,
// and nothing is revalidated when nothing changed.

function wire(respond: (call: Call) => Reply) {
  const { db, calls } = makeDb(respond);
  mocks.requireUserContext.mockResolvedValue(ctx);
  mocks.createServer.mockResolvedValue(db);
  return calls;
}

describe('forgetRoutineAction', () => {
  it('deletes under the caller’s family and revalidates both surfaces that show routines', async () => {
    const calls = wire((call) => (call.table === 'routine_templates'
      ? { data: { id: 'routine-1', name: 'School mornings' }, error: null }
      : { data: null, error: null }));
    const res = await forgetRoutineAction({ id: 'routine-1' });
    expect(res).toEqual({ ok: true });
    expect(calls.find((c) => c.table === 'routine_templates')?.filters).toEqual({ family_id: 'fam-1', id: 'routine-1' });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/settings');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/calendar');
  });

  it('relays the service’s refusal to a child verbatim and revalidates nothing', async () => {
    ctx.active.role = 'child';
    const calls = wire(() => ({ data: null, error: null }));
    const res = await forgetRoutineAction({ id: 'routine-1' });
    expect(res).toEqual({ ok: false, error: 'Only a parent or adult can forget a routine.' });
    expect(calls).toHaveLength(0);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('does not leak an internal failure to the page', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('supabase down: postgres://user:pw@host'));
    const res = await forgetRoutineAction({ id: 'routine-1' });
    expect(res).toEqual({ ok: false, error: 'Could not forget that routine.' });
  });
});

describe('resetMemberTraitsAction', () => {
  it('clears one member’s learned traits and keeps the rest of their profile', async () => {
    const calls = wire((call) => (call.table === 'family_digital_twin_profiles' && call.kind === 'select'
      ? { data: PROFILE({ autopilot_traits: LEARNED, focus: 'homework' }), error: null }
      : { data: null, error: null }));
    const res = await resetMemberTraitsAction({ memberId: 'member-2' });
    expect(res).toEqual({ ok: true });

    const update = calls.find((c) => c.table === 'family_digital_twin_profiles' && c.kind === 'update');
    expect(update?.filters).toMatchObject({ family_id: 'fam-1', member_id: 'member-2' });
    expect(update?.payload).toMatchObject({ metadata: { focus: 'homework' } });
    expect((update?.payload as { metadata: Record<string, unknown> }).metadata).not.toHaveProperty('autopilot_traits');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/settings');
  });

  it.each(['child', 'teen'] as const)('relays the service’s refusal to a %s and writes nothing', async (role) => {
    ctx.active.role = role;
    const calls = wire(() => ({ data: null, error: null }));
    const res = await resetMemberTraitsAction({ memberId: 'member-2' });
    expect(res).toEqual({ ok: false, error: 'Only a parent or adult can reset what Bubaly learned about someone.' });
    expect(calls).toHaveLength(0);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('does not report a reset when the read failed', async () => {
    wire(() => ({ data: null, error: { code: '08006', message: 'connection failure' } }));
    const res = await resetMemberTraitsAction({ memberId: 'member-2' });
    expect(res.ok).toBe(false);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
