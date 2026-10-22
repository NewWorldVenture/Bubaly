// Real service, task writer and registered tool definition; the table model is
// synthetic, not native SQL/transport or the full tool ledger/run executor.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createPetCareTasks } from '@/lib/services/trips';
import { tripTools } from '@/lib/ai/tools/trips';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'pet-family';
const notice = 'Confirmed care tasks for 1 of 3 pets, but could not confirm the rest. Check your to-dos before adding more.';
type Fault = 'refuse' | 'throw' | 'reject' | 'commit-lost' | 'commit-error';
const violations: string[] = [];
afterEach(() => { expect(violations.splice(0)).toEqual([]); vi.restoreAllMocks(); });

function fixture(fault?: Fault, failAt = 2) {
  const db = createInMemorySupabase({
    uniques: { todo_items: [['family_id', 'idempotency_key']] },
    defaults: { todo_items: { is_done: false, tags: [], priority: 'medium', notes: null, due_date: null } },
  });
  db.seed('vacations', [{ id: 'trip', family_id: FAMILY, title: 'Lake week', start_date: '2026-11-10' }]);
  db.seed('family_members', [{ id: 'parent', family_id: FAMILY, user_id: 'user', role: 'parent', is_active: true }]);
  db.seed('todo_lists', [{ id: 'list', family_id: FAMILY, name: 'Family', archived_at: null }]);
  db.seed('pets', ['Amber', 'Biscuit', 'Coco'].map((name, i) => ({
    id: `pet-${i}`, family_id: FAMILY, name, species: 'cat', is_active: true,
    notes: `Care notes ${name}`, vet_name: null, vet_phone: null,
  })));
  db.seed('pets', [{ id: 'foreign', family_id: 'other', name: 'Foreign', is_active: true },
    { id: 'inactive', family_id: FAMILY, name: 'Inactive', is_active: false }]);
  const mutations: { table: string; method: string; payload: unknown }[] = [];
  const terminals: string[] = [];
  let inserts = 0;
  let armed = fault;
  const refusal = { data: null, error: { code: '42501', message: 'synthetic refused', details: null, hint: null }, count: null };
  const allowed = new Set(['vacations', 'family_members', 'pets', 'todo_lists', 'todo_items', 'audit_logs', 'agent_activity']);
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      if (name !== 'ensure_default_todo_list') { violations.push(`Unexpected RPC ${name}`); throw new Error('Unexpected RPC'); }
      expect(args.p_family_id).toBe(FAMILY);
      return db.rpc(name, args);
    },
    from(table: string) {
      if (!allowed.has(table)) { violations.push(`Unexpected table ${table}`); throw new Error('Unexpected table'); }
      const builder = db.from(table);
      let writing = false;
      let ordinal = 0;
      const proxy: typeof builder = new Proxy(builder, {
        get(target, property) {
          if (property === 'single' && table === 'todo_items') return () => {
            if (!writing) { violations.push('Unexpected to-do single read'); throw new Error('Unexpected terminal'); }
            terminals.push(`todo-insert-${ordinal}`);
            const current = ordinal === failAt ? armed : undefined;
            if (current === 'refuse') return Promise.resolve(refusal);
            if (current === 'throw') throw new Error('synthetic private throw');
            if (current === 'reject') return Promise.reject(new Error('synthetic private rejection'));
            if (current === 'commit-lost') return target.single().then(() => { throw new Error('synthetic response lost'); });
            if (current === 'commit-error') return target.single().then(() => refusal);
            return target.single();
          };
          const value: unknown = Reflect.get(target, property, target);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            if (['insert', 'update', 'delete', 'upsert'].includes(String(property))) {
              mutations.push({ table, method: String(property), payload: args[0] });
              if (table === 'todo_items' && property === 'insert') {
                writing = true; ordinal = ++inserts;
                expect(args[0]).toMatchObject({ family_id: FAMILY, assigned_to_id: 'parent', created_by: 'parent' });
              }
            }
            const result: unknown = Reflect.apply(value, target, args);
            return result === target ? proxy : result;
          };
        },
      });
      return proxy;
    },
  };
  const scope: ServiceScope = { db: client as unknown as SupabaseClient<Database>, familyId: FAMILY,
    memberId: 'parent', userId: 'user', role: 'parent', actorKind: 'member', tz: 'UTC', idempotencyKey: 'pet-operation' };
  const rows = () => db.table('todo_items');
  const run = (tool = false) => tool
    ? tripTools.find(t => t.name === 'trips.createPetCareTasks')!.execute(scope, { vacation_id: 'trip' })
    : createPetCareTasks(scope, 'trip');
  return { db, scope, rows, run, mutations, terminals, disarm: () => { armed = undefined; },
    inserts: () => inserts, arm: (next: Fault, at: number) => { armed = next; failAt = at; } };
}

describe('a later pet-care failure preserves confirmed progress truthfully', () => {
  for (const tool of [false, true]) {
    it.each(['refuse', 'throw', 'reject', 'commit-lost'] as const)(`${tool ? 'registered tool' : 'service'}: %s after the first receipt`, async fault => {
      const f = fixture(fault);
      const result = await f.run(tool);
      expect(result).toEqual({ ok: false, code: 'db', retryable: false, error: notice });
      expect(f.rows().map(r => r.title)).toEqual(fault === 'commit-lost'
        ? ['Arrange care for Amber during Lake week', 'Arrange care for Biscuit during Lake week']
        : ['Arrange care for Amber during Lake week']);
      expect(f.terminals).toEqual(['todo-insert-1', 'todo-insert-2']);
      expect(f.mutations.every(m => m.method === 'insert')).toBe(true);
      expect(f.mutations.filter(m => m.table === 'todo_items')).toHaveLength(2);
      expect(JSON.stringify(result)).not.toContain('synthetic');
    });
  }

  it('counts a replayed earlier receipt as confirmed without claiming a new insert', async () => {
    const f = fixture();
    await f.run();
    const existing = { ...f.rows()[0] };
    f.db.table('todo_items').splice(1);
    // A previously saved first task is found; the next new insertion is #4.
    f.arm('refuse', 4);
    const result = await f.run();
    expect(result).toEqual({ ok: false, code: 'db', retryable: false, error: notice });
    expect(f.rows()).toEqual([existing]);
    expect(f.mutations.every(m => m.method === 'insert')).toBe(true);
  });

  it('an explicit same-key retry resumes after refusal without replacing or duplicating the first task', async () => {
    const f = fixture('refuse');
    const partial = await f.run();
    expect(partial).toMatchObject({ ok: false, error: notice, retryable: false });
    const first = { ...f.rows()[0] };
    f.disarm();
    expect(await f.run()).toMatchObject({ ok: true, data: { pets: 3 } });
    expect(f.rows()).toHaveLength(3);
    expect(f.rows()[0]).toEqual(first);
    expect(new Set(f.rows().map(r => r.idempotency_key)).size).toBe(3);
    expect(f.inserts()).toBe(4); // first success, refusal, then the two remaining tasks
  });

  it('without a key, a later failure still reports progress without an automatic retry', async () => {
    const f = fixture('refuse'); delete f.scope.idempotencyKey;
    expect(await f.run()).toEqual({ ok: false, code: 'db', retryable: false, error: notice });
    expect(f.rows()).toHaveLength(1); expect(f.inserts()).toBe(2);
  });
});

describe('pet-care compatibility controls', () => {
  it('preserves a first refusal with no confirmed receipt and no later insert', async () => {
    const f = fixture('refuse', 1); const result = await f.run();
    expect(result).toMatchObject({ ok: false, code: 'db' });
    expect(result.ok ? '' : result.error).not.toContain('Confirmed');
    expect(result).not.toHaveProperty('retryable');
    expect(f.rows()).toEqual([]); expect(f.inserts()).toBe(1);
  });
  it.each(['throw', 'reject'] as const)('preserves a first %s for the existing caller boundary', async fault => {
    const f = fixture(fault, 1);
    await expect(f.run()).rejects.toThrow('synthetic private');
    expect(f.rows()).toEqual([]); expect(f.inserts()).toBe(1);
  });
  it('preserves healthy tasks, active-family filtering, notes, dates and idempotent replay', async () => {
    const f = fixture(); const result = await f.run(true);
    expect(result).toMatchObject({ ok: true, data: { pets: 3, created: [{ pet_name: 'Amber' }, { pet_name: 'Biscuit' }, { pet_name: 'Coco' }] } });
    expect(f.rows()).toHaveLength(3);
    expect(f.rows().every(r => r.due_date === '2026-11-09' && String(r.notes).includes('Care notes'))).toBe(true);
    expect(await f.run()).toMatchObject({ ok: true, data: { pets: 3 } });
    expect(f.inserts()).toBe(3);
  });
  it('a returned error whose keyed re-read confirms the second commit remains healthy', async () => {
    const f = fixture('commit-error');
    expect(await f.run()).toMatchObject({ ok: true, data: { pets: 3 } });
    expect(f.rows()).toHaveLength(3); expect(f.inserts()).toBe(3);
  });
  it('empty active pets write nothing', async () => {
    const f = fixture(); f.db.table('pets').splice(0);
    expect(await f.run()).toEqual({ ok: true, data: { created: [], pets: 0 } });
    expect(f.mutations).toEqual([]);
  });
  it('a guest cannot start creating care tasks', async () => {
    const f = fixture(); f.scope.role = 'guest';
    expect(await f.run()).toMatchObject({ ok: false, code: 'denied' });
    expect(f.mutations).toEqual([]);
  });
});
