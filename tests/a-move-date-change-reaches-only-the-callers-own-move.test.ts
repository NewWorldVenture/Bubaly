// API-A59CC3A2156D — POST /api/moving/recalculate, driven end to end.
//
// tests/move-date-recalculation-api.test.ts pins the handler against a scripted
// fake: request parsing, the exact RPC arguments, every RPC error code's
// mapping and the result-shape checks. What it cannot show is what a real
// request DOES to the household's rows. Here the real handler runs over the
// in-memory database with the real getUserContext, the real plan resolver and
// a faithful model of `move_recalculate_date` (supabase/migrations/0271), so
// each case reads the moves, tasks and history rows back after the request.
//
// Isolation note: the in-memory database applies no RLS. The household
// boundary this route relies on is (1) the route's own familyId/memberId match
// against the active membership, and (2) the SECURITY DEFINER RPC's membership
// and `move.family_id = p_family_id` checks, modelled below line for line.
import { isDeepStrictEqual } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, rpcCalls: [] as string[] }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => h.db,
  createServiceClient: () => h.db,
}));

import { POST } from '@/app/api/moving/recalculate/route';

const FAMILY_A = 'a0000000-0000-4000-8000-00000000000a';
const FAMILY_B = 'b0000000-0000-4000-8000-00000000000b';
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
type Role = typeof ROLES[number];
const userOf = (role: Role) => `a1000000-0000-4000-8000-00000000000${ROLES.indexOf(role) + 1}`;
const memberOf = (role: Role) => `a2000000-0000-4000-8000-00000000000${ROLES.indexOf(role) + 1}`;
const USER_B = 'b1000000-0000-4000-8000-000000000001';
const MEMBER_B = 'b2000000-0000-4000-8000-000000000001';
const MOVE_A = 'a3000000-0000-4000-8000-000000000001';
const MOVE_B = 'b3000000-0000-4000-8000-000000000001';
const TASK_A_RELATIVE = 'a4000000-0000-4000-8000-000000000001';
const TASK_A_FIXED = 'a4000000-0000-4000-8000-000000000002';
const TASK_B_RELATIVE = 'b4000000-0000-4000-8000-000000000001';
const REQUEST = 'a5000000-0000-4000-8000-000000000001';
const STAMP = '2026-09-01T12:00:00+00:00';
const FROM = '2026-09-20';
const TO = '2026-09-30';
const URL = 'http://localhost/api/moving/recalculate';
const INTERNAL = 'relation "moves" internal detail 0xDEADBEEF';

let currentUser: string | null = null;

/** supabase/migrations/0271 `move_recalculate_date`, over the in-memory tables. */
function moveRecalculateDate(args: Record<string, unknown>, db: InMemorySupabase): unknown {
  h.rpcCalls.push(String(args.p_move_id));
  const fail = (code: string) => { throw Object.assign(new Error(code), { pgCode: code }); };
  const userId = currentUser;
  if (!userId) fail('42501');
  const member = db.table('family_members').find((m) => m.id === args.p_member_id && m.family_id === args.p_family_id
    && m.user_id === userId && m.is_active === true && ['parent', 'adult'].includes(String(m.role)));
  if (!member) fail('42501');
  const history = () => db.table('move_date_recalculations').find((r) => r.request_id === args.p_request_id);
  const replay = () => {
    const saved = history();
    if (!saved) return null;
    if (saved.family_id === args.p_family_id && saved.move_id === args.p_move_id && saved.actor_user_id === userId
      && saved.actor_member_id === member!.id && saved.to_date === args.p_new_date && isDeepStrictEqual(saved.reviewed, args.p_expected)) {
      return saved.result;
    }
    return fail('23505');
  };
  if (args.p_request_id !== null) { const r = replay(); if (r) return r; }
  if ((args.p_expected === null) !== (args.p_request_id === null)) fail('22023');
  const move = db.table('moves').find((m) => m.id === args.p_move_id && m.family_id === args.p_family_id);
  if (!move) fail('P0002');
  if (args.p_new_date === move!.move_date || ['done', 'cancelled'].includes(String(move!.status))) fail('22023');
  const tasks = db.table('move_tasks').filter((t) => t.move_id === args.p_move_id).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (tasks.some((t) => t.family_id !== args.p_family_id)) fail('P0002');
  const addDays = (day: string, n: number) => {
    const d = new Date(`${day}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const shift: Row[] = [];
  const previewTasks = tasks.map((t) => {
    let reason: string;
    let next = t.due_date as string | null;
    let action = 'preserve';
    if (t.completed_at !== null || t.status === 'done') reason = 'completed';
    else if (t.status === 'skipped') reason = 'skipped';
    else if (t.date_mode === 'fixed') reason = 'fixed';
    else if (t.due_date === null) reason = 'no_date';
    else if (!['todo', 'doing'].includes(String(t.status)) || t.due_date !== addDays(String(move!.move_date), Number(t.offset_days))) reason = 'out_of_sync';
    else { reason = 'relative'; next = addDays(String(args.p_new_date), Number(t.offset_days)); action = 'shift'; shift.push(t); }
    return { id: t.id, title: t.title, status: t.status, mode: t.date_mode, offsetDays: t.offset_days, dueDate: t.due_date,
      nextDueDate: next, updatedAt: t.updated_at, action, reason };
  });
  const preview = { version: 1, familyId: args.p_family_id, moveId: args.p_move_id, memberId: member!.id, fromDate: move!.move_date,
    toDate: args.p_new_date, moveUpdatedAt: move!.updated_at, tasks: previewTasks, changes: shift.length };
  if (args.p_expected === null) return { preview, applied: false, requestId: null, appliedAt: null };
  if (!isDeepStrictEqual(preview, args.p_expected)) fail('40001');
  const appliedAt = '2026-09-06T12:05:00.000000+00:00';
  const result = { preview, applied: true, requestId: args.p_request_id, appliedAt };
  db.table('move_date_recalculations').push({ request_id: args.p_request_id, family_id: args.p_family_id, move_id: args.p_move_id,
    actor_user_id: userId, actor_member_id: member!.id, from_date: move!.move_date, to_date: args.p_new_date,
    reviewed: args.p_expected, result, created_at: appliedAt });
  move!.move_date = args.p_new_date;
  for (const t of shift) t.due_date = addDays(String(args.p_new_date), Number(t.offset_days));
  return result;
}

function build(userId: string | null, opts: { superAdmin?: boolean; plan?: string | null; tiers?: Record<string, string> } = {}) {
  currentUser = userId;
  const db = createInMemorySupabase({ userId });
  // The route maps the RPC's SQLSTATE to a status, so the model's code is carried
  // through as Postgres would raise it.
  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    is_super_admin: () => opts.superAdmin === true,
    move_recalculate_date: (args) => moveRecalculateDate(args, db),
  };
  (db as unknown as { rpc: unknown }).rpc = async (name: string, args: Record<string, unknown> = {}) => {
    try {
      return { data: handlers[name](args), error: null };
    } catch (error) {
      return { data: null, error: { code: (error as { pgCode?: string }).pgCode ?? 'XX000', message: INTERNAL, details: null, hint: null } };
    }
  };
  db.seed('families', [
    { id: FAMILY_A, name: 'Household A', timezone: 'UTC', trial_ends_at: null, closed_at: null },
    { id: FAMILY_B, name: 'Household B', timezone: 'UTC', trial_ends_at: null, closed_at: null },
  ]);
  db.seed('family_members', [
    ...ROLES.map((role) => ({ id: memberOf(role), family_id: FAMILY_A, user_id: userOf(role), role, is_active: true, display_name: role })),
    { id: MEMBER_B, family_id: FAMILY_B, user_id: USER_B, role: 'parent', is_active: true, display_name: 'parent b' },
  ]);
  if (opts.plan !== null) db.seed('subscriptions', [{ family_id: FAMILY_A, plan: opts.plan ?? 'basic', status: 'active', current_period_end: null }]);
  db.seed('subscriptions', [{ family_id: FAMILY_B, plan: 'basic', status: 'active', current_period_end: null }]);
  db.seed('app_settings', [{ key: 'feature_tiers', value: opts.tiers ?? {} }]);
  db.seed('moves', [
    { id: MOVE_A, family_id: FAMILY_A, title: 'Move A', move_date: FROM, status: 'planning', updated_at: STAMP },
    { id: MOVE_B, family_id: FAMILY_B, title: 'Move B', move_date: FROM, status: 'planning', updated_at: STAMP },
  ]);
  db.seed('move_tasks', [
    { id: TASK_A_RELATIVE, family_id: FAMILY_A, move_id: MOVE_A, title: 'Book truck', status: 'todo', date_mode: 'relative', offset_days: -7, due_date: '2026-09-13', completed_at: null, updated_at: STAMP },
    { id: TASK_A_FIXED, family_id: FAMILY_A, move_id: MOVE_A, title: 'Utility visit', status: 'todo', date_mode: 'fixed', offset_days: 0, due_date: '2026-09-19', completed_at: null, updated_at: STAMP },
    { id: TASK_B_RELATIVE, family_id: FAMILY_B, move_id: MOVE_B, title: 'Book truck', status: 'todo', date_mode: 'relative', offset_days: -7, due_date: '2026-09-13', completed_at: null, updated_at: STAMP },
  ]);
  h.db = db;
  return db;
}

const body = (role: Role, extra: Record<string, unknown> = {}) => ({ familyId: FAMILY_A, memberId: memberOf(role), moveId: MOVE_A, date: TO, ...extra });
const post = (payload: unknown) => POST(new Request(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }));
const snapshot = (db: InMemorySupabase) => JSON.stringify(['moves', 'move_tasks', 'move_date_recalculations'].map((t) => db.table(t)));
const bRows = (db: InMemorySupabase) => JSON.stringify([db.table('moves').find((m) => m.id === MOVE_B), db.table('move_tasks').find((t) => t.id === TASK_B_RELATIVE)]);

beforeEach(() => { h.rpcCalls = []; });
afterEach(() => { vi.restoreAllMocks(); });

describe('POST /api/moving/recalculate over a two-household database', () => {
  it('API-A59CC3A2156D signed-out: 401, the RPC is never called and no move or task changes', async () => {
    const db = build(null);
    const before = snapshot(db);
    const response = await post(body('parent'));
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('signed_out');
    expect(h.rpcCalls).toEqual([]);
    expect(snapshot(db)).toBe(before);
  });

  it.each(['teen', 'child', 'caregiver', 'guest'] as const)('API-A59CC3A2156D a %s of household A is refused with 403 and nothing is read or written', async (role) => {
    const db = build(userOf(role));
    const before = snapshot(db);
    const response = await post(body(role));
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('role_required');
    expect(h.rpcCalls).toEqual([]);
    expect(snapshot(db)).toBe(before);
  });

  it.each(['parent', 'adult'] as const)('API-A59CC3A2156D a %s previews the real task plan and the preview writes nothing', async (role) => {
    const db = build(userOf(role));
    const before = snapshot(db);
    const response = await post(body(role));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const result = await response.json();
    expect(result).toMatchObject({ applied: false, requestId: null, appliedAt: null });
    expect(result.preview).toMatchObject({ familyId: FAMILY_A, moveId: MOVE_A, memberId: memberOf(role), fromDate: FROM, toDate: TO, changes: 1 });
    expect(result.preview.tasks.map((t: Row) => [t.id, t.action, t.nextDueDate])).toEqual([
      [TASK_A_RELATIVE, 'shift', '2026-09-23'],
      [TASK_A_FIXED, 'preserve', '2026-09-19'],
    ]);
    expect(snapshot(db)).toBe(before);
  });

  it('API-A59CC3A2156D a parent applies the reviewed preview: the move and its relative task move, the fixed task stays, one history row records the actor', async () => {
    const db = build(userOf('parent'));
    const reviewed = (await (await post(body('parent'))).json()).preview;
    const response = await post(body('parent', { expected: reviewed, requestId: REQUEST }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ applied: true, requestId: REQUEST });
    expect(db.table('moves').find((m) => m.id === MOVE_A)?.move_date).toBe(TO);
    expect(db.table('move_tasks').find((t) => t.id === TASK_A_RELATIVE)?.due_date).toBe('2026-09-23');
    expect(db.table('move_tasks').find((t) => t.id === TASK_A_FIXED)?.due_date).toBe('2026-09-19');
    expect(db.table('move_date_recalculations').map((r) => [r.request_id, r.family_id, r.move_id, r.actor_user_id, r.actor_member_id, r.from_date, r.to_date]))
      .toEqual([[REQUEST, FAMILY_A, MOVE_A, userOf('parent'), memberOf('parent'), FROM, TO]]);
  });

  it('API-A59CC3A2156D a replayed apply returns the original receipt and moves nothing a second time', async () => {
    const db = build(userOf('parent'));
    const reviewed = (await (await post(body('parent'))).json()).preview;
    const first = await (await post(body('parent', { expected: reviewed, requestId: REQUEST }))).json();
    const afterFirst = snapshot(db);
    const again = await post(body('parent', { expected: reviewed, requestId: REQUEST }));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    expect(snapshot(db)).toBe(afterFirst);
    expect(db.table('move_date_recalculations')).toHaveLength(1);
  });

  it("API-A59CC3A2156D household B's move id under household A is 404 and B's move and tasks are unchanged", async () => {
    const db = build(userOf('parent'));
    const before = bRows(db);
    const response = await post(body('parent', { moveId: MOVE_B }));
    expect(response.status).toBe(404);
    const result = await response.json();
    expect(result.code).toBe('move_unavailable');
    expect(JSON.stringify(result)).not.toContain(MOVE_B);
    expect(bRows(db)).toBe(before);
  });

  it("API-A59CC3A2156D household B's family and member ids are refused before the RPC, and B's move is unchanged", async () => {
    const db = build(userOf('parent'));
    const before = bRows(db);
    const response = await post({ familyId: FAMILY_B, memberId: MEMBER_B, moveId: MOVE_B, date: TO });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('context_changed');
    expect(h.rpcCalls).toEqual([]);
    expect(bRows(db)).toBe(before);
  });

  it("API-A59CC3A2156D an apply carrying a preview of B's move cannot change B", async () => {
    const db = build(userOf('parent'));
    const before = bRows(db);
    const forged = { version: 1, familyId: FAMILY_A, moveId: MOVE_B, memberId: memberOf('parent'), fromDate: FROM, toDate: TO,
      moveUpdatedAt: STAMP, changes: 1, tasks: [{ id: TASK_B_RELATIVE, title: 'Book truck', status: 'todo', mode: 'relative', offsetDays: -7,
        dueDate: '2026-09-13', nextDueDate: '2026-09-23', updatedAt: STAMP, action: 'shift', reason: 'relative' }] };
    const response = await post(body('parent', { moveId: MOVE_B, expected: forged, requestId: REQUEST }));
    expect(response.status).toBe(404);
    expect(bRows(db)).toBe(before);
    expect(db.table('move_date_recalculations')).toEqual([]);
  });

  it('API-A59CC3A2156D a family below the move planner tier is refused 403 before the RPC; a super admin passes', async () => {
    build(userOf('parent'), { plan: null });
    const refused = await post(body('parent'));
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe('plan_required');
    expect(h.rpcCalls).toEqual([]);
    build(userOf('parent'), { plan: null, superAdmin: true });
    expect((await post(body('parent'))).status).toBe(200);
    expect(h.rpcCalls).toEqual([MOVE_A]);
  });

  it('API-A59CC3A2156D a failed feature-settings read is 503 access_unavailable, no RPC, no internal text', async () => {
    const db = build(userOf('parent'));
    const before = snapshot(db);
    h.db = withFaults(db, (table) => (table === 'app_settings' ? { message: INTERNAL } : null));
    const response = await post(body('parent'));
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text).code).toBe('access_unavailable');
    expect(text).not.toContain(INTERNAL);
    expect(h.rpcCalls).toEqual([]);
    expect(snapshot(db)).toBe(before);
  });

  it('API-A59CC3A2156D a failed plan read is 503, not a plan refusal, and no RPC runs', async () => {
    const db = build(userOf('parent'));
    h.db = withFaults(db, (table) => (table === 'subscriptions' ? { message: INTERNAL } : null));
    const response = await post(body('parent'));
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text).code).toBe('recalculation_unavailable');
    expect(text).not.toContain(INTERNAL);
    expect(h.rpcCalls).toEqual([]);
  });
});
