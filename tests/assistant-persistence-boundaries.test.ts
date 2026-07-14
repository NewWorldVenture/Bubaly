import { describe, expect, it } from 'vitest';
import { buildAssistantTools, type AssistantCtx } from '@/lib/assistant/tools';

type DbArg = Parameters<typeof buildAssistantTools>[0];
type Operation = 'select' | 'insert' | 'update' | 'delete' | 'upsert';
type Result = { data?: unknown; error?: unknown; count?: number };

type Call = { table: string; operation: Operation; payload?: unknown };

function fakeDb(resolveResult: (table: string, operation: Operation, count: number) => Result) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();

  const db = {
    from(table: string) {
      let operation: Operation = 'select';
      let payload: unknown;
      const chain: Record<string, unknown> & {
        then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => Promise<unknown>;
      } = {} as never;
      const finish = () => {
        const countKey = `${table}:${operation}`;
        const count = (counts.get(countKey) ?? 0) + 1;
        counts.set(countKey, count);
        calls.push({ table, operation, payload });
        return resolveResult(table, operation, count);
      };
      const passthrough = () => chain;
      Object.assign(chain, {
        select: passthrough,
        eq: passthrough,
        ilike: passthrough,
        in: passthrough,
        is: passthrough,
        not: passthrough,
        gte: passthrough,
        lte: passthrough,
        order: passthrough,
        limit: passthrough,
        maybeSingle: () => Promise.resolve(finish()),
        single: () => Promise.resolve(finish()),
        insert(value: unknown) { operation = 'insert'; payload = value; return chain; },
        update(value: unknown) { operation = 'update'; payload = value; return chain; },
        delete() { operation = 'delete'; return chain; },
        upsert(value: unknown) { operation = 'upsert'; payload = value; return chain; },
        then(resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
          return Promise.resolve(finish()).then(resolve, reject);
        },
      });
      return chain;
    },
  } as unknown as DbArg;

  return { db, calls };
}

const ctx: AssistantCtx = {
  familyId: 'family-1',
  userId: 'user-1',
  members: [{ id: 'member-1', display_name: 'Emma' }],
  tz: 'America/New_York',
};

function tool(db: DbArg, name: string) {
  const found = buildAssistantTools(db, ctx).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing assistant tool: ${name}`);
  return found;
}

describe('assistant persistence boundaries', () => {
  it('does not treat a failed grocery-list lookup as an empty list', async () => {
    const { db } = fakeDb((table, operation) => table === 'grocery_lists' && operation === 'select'
      ? { data: null, error: new Error('database unavailable') }
      : { data: [], error: null });

    const result = await tool(db, 'add_grocery_item').execute({ item: 'Milk' }) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: 'Could not open a grocery list.' });
  });

  it('rolls back a newly-created chore when assignment persistence fails', async () => {
    const { db, calls } = fakeDb((table, operation) => {
      if (table === 'chores' && operation === 'insert') return { data: { id: 'chore-1' }, error: null };
      if (table === 'chore_assignments' && operation === 'insert') return { error: new Error('assignment failed') };
      return { data: null, error: null };
    });

    const result = await tool(db, 'add_chore').execute({ title: 'Water plants', assignee: 'Emma' }) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: 'Could not save the chore assignment.' });
    expect(calls).toContainEqual({ table: 'chores', operation: 'delete', payload: undefined });
  });

  it('rolls a recurring reminder back to active when the next occurrence fails', async () => {
    const { db, calls } = fakeDb((table, operation, count) => {
      if (table === 'family_reminders' && operation === 'select') {
        return {
          data: [{ id: 'reminder-1', title: 'Water plants', recurrence: 'monthly', remind_at: '2026-07-01T09:00:00.000Z', kind: 'recurring', priority: 'medium', notes: null, member_id: null, location_name: null }],
          error: null,
        };
      }
      if (table === 'family_reminders' && operation === 'insert') return { error: new Error('next reminder failed') };
      if (table === 'family_reminders' && operation === 'update' && count === 1) return { error: null };
      if (table === 'family_reminders' && operation === 'update' && count === 2) return { error: null };
      return { data: [], error: null };
    });

    const result = await tool(db, 'complete_reminder').execute({ title: 'plants' }) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: 'Could not schedule the next reminder.' });
    expect(calls.filter((call) => call.table === 'family_reminders' && call.operation === 'update')).toHaveLength(2);
    expect(calls.at(-1)?.payload).toMatchObject({ status: 'active', completed_at: null });
  });

  it('fails closed when a pending-decision source cannot be read', async () => {
    const { db } = fakeDb((table, operation) => table === 'documents' && operation === 'select'
      ? { data: null, error: new Error('documents unavailable') }
      : { data: [], error: null, count: 0 });

    const result = await tool(db, 'list_pending_decisions').execute({}) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: 'Could not load pending decisions.' });
  });
});
