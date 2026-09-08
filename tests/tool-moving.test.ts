// Contract tests for the moving tools: registered with honest risk tiers,
// strict inputs, offered to the plan_move intent, and — through the service —
// laying out the template once and adding keyed tasks once.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { toolsForIntent } from '@/lib/ai/planner/prompts';
import { getTool, listTools } from '@/lib/ai/tools/registry';
import { toolInputSchema } from '@/lib/ai/tools/legacy-adapter';
import { applicableTemplate } from '@/lib/moving/planner';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const NOW = new Date('2026-09-05T12:00:00Z');
const FAMILY = randomUUID();
const MEMBER = randomUUID();
const MOVE = randomUUID();

function makeDb(): InMemorySupabase {
  const db = createInMemorySupabase({
    defaults: {
      moves: { status: 'planning', move_kind: 'local', has_kids: true, has_pets: true, is_renting_out: false, budget_cents: null, spent_cents: 0, mover_quote_cents: null, from_address: null, to_address: null, notes: null },
      move_tasks: { status: 'todo', category: 'admin', offset_days: 0, due_date: null, date_mode: 'fixed', assignee_id: null, completed_at: null, template_key: null, notes: null },
    },
  });
  db.seed('family_members', [{ id: MEMBER, family_id: FAMILY, role: 'parent', display_name: 'Dad', is_active: true }]);
  return db;
}

function scopeWith(db: InMemorySupabase, extra?: Partial<ServiceScope>): ServiceScope {
  return { db: db as unknown as SupabaseClient<Database>, familyId: FAMILY, userId: 'auth-1', memberId: MEMBER, role: 'parent', actorKind: 'ai', tz: 'America/New_York', now: NOW, ...extra };
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

const MINE: Record<string, { readOnly: boolean; capability: string; risk: string }> = {
  'moving.getMove': { readOnly: true, capability: 'view', risk: 'low' },
  'moving.createMove': { readOnly: false, capability: 'create', risk: 'low' },
  'moving.planTasks': { readOnly: false, capability: 'create', risk: 'low' },
  'moving.addTask': { readOnly: false, capability: 'create', risk: 'low' },
  'moving.setMoveDate': { readOnly: false, capability: 'edit', risk: 'medium' },
};

describe('registration', () => {
  it('registers every moving tool under home_maintenance with the tier its blast radius earns', () => {
    for (const [name, meta] of Object.entries(MINE)) {
      const tool = getTool(name);
      expect(tool, name).not.toBeNull();
      expect(tool, name).toMatchObject({ domain: 'home_maintenance', ...meta });
      if (!tool!.readOnly) expect(typeof tool!.idempotencyFrom, `${name} needs a duplicate guard`).toBe('function');
      const schema = toolInputSchema(tool!);
      expect(schema?.additionalProperties, name).toBe(false);
    }
    expect(getTool('moving.setMoveDate')!.consequences?.({ date: '2026-10-10' })).toEqual(expect.arrayContaining([expect.stringContaining('2026-10-10')]));
  });

  it('is offered to the move plan along with reminders and the roster', () => {
    const names = toolsForIntent('plan_move', listTools()).map((t) => t.name);
    for (const name of Object.keys(MINE)) expect(names).toContain(name);
    expect(names).toContain('reminders.create');
    expect(names).toContain('family.listMembers');
    expect(names).not.toContain('finances.updateBudget');
  });

  it('validates its inputs before anything runs', () => {
    expect(getTool('moving.setMoveDate')!.input.safeParse({}).success).toBe(false);
    expect(getTool('moving.addTask')!.input.safeParse({ title: 'x', category: 'laundry' }).success).toBe(false);
    expect(getTool('moving.addTask')!.input.safeParse({ title: 'x', category: 'address', offset_days: -14 }).success).toBe(true);
    expect(getTool('moving.createMove')!.input.safeParse({ move_kind: 'teleport' }).success).toBe(false);
    expect(getTool('moving.getMove')!.input.safeParse({ move_id: null }).success).toBe(true);
  });
});

describe('the tools through the service', () => {
  it('reports no move honestly, then puts one on file, lays out the template once and keys a one-off task', async () => {
    const db = makeDb();
    const get = getTool('moving.getMove')!;
    const none = await get.execute(scopeWith(db), { move_id: null });
    expect(none).toMatchObject({ ok: true, data: { found: false, move: null } });
    expect(get.summarize({}, none.ok ? none.data : {})).toBe('No move on file');

    const create = getTool('moving.createMove')!;
    const created = await create.execute(scopeWith(db), { title: 'Move to Maple St', move_date: '2026-10-03', to_address: '12 Maple St' });
    expect(created).toMatchObject({ ok: true, data: { created: true, move: { title: 'Move to Maple St', move_date: '2026-10-03', has_kids: false, has_pets: false } } });

    const plan = getTool('moving.planTasks')!;
    const planned = await plan.execute(scopeWith(db), { move_id: null });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const out = planned.data as { added: number; already_planned: number; tasks: { template_key: string | null; due_date: string | null }[] };
    expect(out.added).toBe(applicableTemplate({ move_kind: 'local', has_kids: false, has_pets: false, is_renting_out: false }).length);
    expect(plan.summarize({}, out)).toMatch(/^Added \d+ dated move tasks$/);
    const again = await plan.execute(scopeWith(db), { move_id: null });
    expect(again).toMatchObject({ ok: true, data: { added: 0 } });
    expect(plan.summarize({}, again.ok ? again.data : {})).toMatch(/already in place/);

    const add = getTool('moving.addTask')!;
    const first = await add.execute(scopeWith(db), { title: 'Change the address with Netflix', category: 'address', offset_days: -14, template_key: 'address-sub-1', assignee: 'Dad' });
    expect(first).toMatchObject({ ok: true, data: { created: true, task: { due_date: '2026-09-19', assignee_id: MEMBER, template_key: 'address-sub-1' } } });
    const dup = await add.execute(scopeWith(db), { title: 'Change the address with Netflix', category: 'address', offset_days: -14, template_key: 'address-sub-1' });
    expect(dup).toMatchObject({ ok: true, data: { created: false } });
    expect(add.summarize({ title: 'x' }, dup.ok ? dup.data : {})).toMatch(/already on the move/);
    expect(await add.execute(scopeWith(db), { title: 'x', assignee: 'Nobody' })).toMatchObject({ ok: false, code: 'not_found' });

    const detail = await get.execute(scopeWith(db), { move_id: null });
    expect(detail.ok && (detail.data as { tasks: unknown[] }).tasks).toHaveLength(out.added + 1);
  });

  // What the tool says about boxes has to be what `move_boxes` holds: the
  // sentence goes into the ledger and out to the family verbatim.
  it('reports the box counts it read, not an assumed empty shelf', async () => {
    const db = makeDb();
    db.seed('moves', [{ id: MOVE, family_id: FAMILY, title: 'Move', move_date: '2026-09-01', status: 'settling' }]);
    const box = (over: Record<string, unknown>) => ({ id: randomUUID(), family_id: FAMILY, move_id: MOVE, label: 'Box', to_room: null, is_fragile: false, is_essential: false, contents: [], ...over });
    db.seed('move_boxes', [box({ box_number: 1, status: 'unpacked' }), box({ box_number: 2, status: 'delivered' })]);
    const get = getTool('moving.getMove')!;
    const res = await get.execute(scopeWith(db), { move_id: null });
    expect(res).toMatchObject({ ok: true, data: { boxes: { total: 2, packed: 2, unpacked: 1 }, summary: '4 days in · 1/2 boxes unpacked' } });
    expect(res.ok && get.output.safeParse(res.data).success).toBe(true);
    expect(get.summarize({}, res.ok ? res.data : {})).toBe('Move: 4 days in · 1/2 boxes unpacked');
  });

  it('refuses to change the date for an actor with nobody behind it', async () => {
    const db = makeDb();
    db.seed('moves', [{ id: MOVE, family_id: FAMILY, title: 'Move', move_date: '2026-10-03' }]);
    const res = await getTool('moving.setMoveDate')!.execute(scopeWith(db, { memberId: null, userId: null, role: 'system', actorKind: 'system' }), { date: '2026-10-10' });
    expect(res).toMatchObject({ ok: false, code: 'denied' });
    expect(db.table('moves')[0].move_date).toBe('2026-10-03');
  });
});
