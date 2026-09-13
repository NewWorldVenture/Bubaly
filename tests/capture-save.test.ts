import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { saveCapture, tableForKind, undoCapture } from '@/lib/capture/save';
import type { SupabaseBrowser } from '@/lib/supabase/types';
const LIST = '44444444-4444-4444-8444-444444444444';

// A tiny chainable fake of the Supabase browser client: records every insert
// and resolves list lookups to an existing list (so we exercise the insert
// path, not list creation). Each builder is thenable so `await from().insert()`
// resolves like a terminal PostgREST call.
function makeFakeSupabase() {
  const inserts: { table: string; payload: unknown }[] = [];
  function builder(table: string) {
    let rows: unknown[] = [];
    const b: Record<string, unknown> = {};
    const chain = () => b;
    Object.assign(b, {
      select: chain, eq: chain, is: chain, order: chain, limit: chain, abortSignal: chain,
      insert: (payload: unknown) => { inserts.push({ table, payload }); rows = Array.isArray(payload) ? payload : [payload]; return b; },
      maybeSingle: () =>
        Promise.resolve(
          table === 'todo_lists' || table === 'grocery_lists'
            ? { data: { id: LIST }, error: null }
            : { data: null, error: null },
        ),
      then: (resolve: (v: { data: { id: string }[]; error: null }) => void) => resolve({ data: rows.map(() => ({ id: randomUUID() })), error: null }),
    });
    return b;
  }
  const client = { from: (table: string) => builder(table) } as unknown as SupabaseBrowser;
  return { client, inserts };
}

const BASE = { familyId: 'fam-1', userId: 'user-1', memberId: 'member-1' };

describe('saveCapture', () => {
  it('saves a note', async () => {
    const { client, inserts } = makeFakeSupabase();
    const res = await saveCapture(client, { ...BASE, kind: 'note', text: 'Wifi code is 1234' });
    expect(res).toMatchObject({ kind: 'note', count: 1, href: '/dashboard/notes' });
    expect(inserts).toEqual([{ table: 'notes', payload: { family_id: 'fam-1', body: 'Wifi code is 1234', created_by: 'user-1' } }]);
  });

  it('parses an event time and cleans the title', async () => {
    const { client, inserts } = makeFakeSupabase();
    const res = await saveCapture(client, { ...BASE, kind: 'event', text: 'Dentist at 3pm tomorrow' });
    expect(res).toMatchObject({ kind: 'event', count: 1, title: 'Dentist', href: '/dashboard/calendar' });
    const row = inserts[0].payload as Record<string, unknown>;
    expect(inserts[0].table).toBe('calendar_events');
    expect(row.title).toBe('Dentist');
    expect(row.all_day).toBe(false);
    expect(typeof row.starts_at).toBe('string');
  });

  it('sets a task due date and self-assigns', async () => {
    const { client, inserts } = makeFakeSupabase();
    const res = await saveCapture(client, { ...BASE, kind: 'task', text: 'Pay rent friday' });
    expect(res).toMatchObject({ kind: 'task', count: 1, title: 'Pay rent', href: '/dashboard/todos' });
    const row = inserts.find((i) => i.table === 'todo_items')!.payload as Record<string, unknown>;
    expect(row.title).toBe('Pay rent');
    expect(row.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row.assigned_to_id).toBe('member-1');
    // todo_items.created_by references family_members(id), not auth.users
    // (migration 0015): the auth user id would violate the FK and the first
    // task of the onboarding journey would never save.
    expect(row.created_by).toBe('member-1');
  });

  it('creates the default to-do list with the member id, not the auth user id', async () => {
    const inserts: { table: string; payload: unknown }[] = [];
    function builder(table: string) {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      Object.assign(b, {
        select: chain, eq: chain, is: chain, order: chain, limit: chain, abortSignal: chain,
        insert: (payload: unknown) => { inserts.push({ table, payload }); return b; },
        // No existing list → exercise the list-creation path.
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (resolve: (v: { data: { id: string }[]; error: null }) => void) => resolve({ data: [{ id: table === 'todo_lists' ? LIST : randomUUID() }], error: null }),
      });
      return b;
    }
    const client = { from: (table: string) => builder(table) } as unknown as SupabaseBrowser;
    await saveCapture(client, { ...BASE, kind: 'task', text: 'Pack lunches for tomorrow' });
    expect(inserts.find((i) => i.table === 'todo_lists')!.payload).toEqual({ family_id: 'fam-1', name: 'To-Do', created_by: 'member-1' });
    const item = inserts.find((i) => i.table === 'todo_items')!.payload as Record<string, unknown>;
    expect(item).toMatchObject({ list_id: LIST, title: 'Pack lunches for tomorrow', created_by: 'member-1', assigned_to_id: 'member-1' });
  });

  it('splits a shopping list into multiple rows', async () => {
    const { client, inserts } = makeFakeSupabase();
    const res = await saveCapture(client, { ...BASE, kind: 'shopping', text: 'milk, eggs and bread' });
    expect(res).toMatchObject({ kind: 'shopping', count: 3, href: '/dashboard/grocery' });
    const row = inserts.find((i) => i.table === 'grocery_items')!.payload as unknown[];
    expect(Array.isArray(row)).toBe(true);
    expect(row).toHaveLength(3);
    expect((row[0] as Record<string, unknown>).name).toBe('milk');
  });

  it('parses quantities on shopping items', async () => {
    const { client, inserts } = makeFakeSupabase();
    const res = await saveCapture(client, { ...BASE, kind: 'shopping', text: '2 milk, eggs x12' });
    expect(res.count).toBe(2);
    const rows = inserts.find((i) => i.table === 'grocery_items')!.payload as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ name: 'milk', quantity: '2' });
    expect(rows[1]).toMatchObject({ name: 'eggs', quantity: '12' });
  });

  it('rejects empty input', async () => {
    const { client } = makeFakeSupabase();
    await expect(saveCapture(client, { ...BASE, kind: 'note', text: '   ' })).rejects.toThrow();
  });

  it('returns an undo descriptor with the right table per kind', async () => {
    const cases: { kind: 'note' | 'event' | 'task' | 'shopping'; text: string; table: string }[] = [
      { kind: 'note', text: 'a note', table: 'notes' },
      { kind: 'event', text: 'Dentist at 3pm', table: 'calendar_events' },
      { kind: 'task', text: 'Pay rent', table: 'todo_items' },
      { kind: 'shopping', text: 'milk', table: 'grocery_items' },
    ];
    for (const c of cases) {
      const { client } = makeFakeSupabase();
      const res = await saveCapture(client, { ...BASE, kind: c.kind, text: c.text });
      expect(res.undo.table).toBe(c.table);
      expect(Array.isArray(res.undo.ids)).toBe(true);
      expect(res.undo.ids).toHaveLength(res.count);
    }
  });
});

describe('tableForKind', () => {
  it('maps every capture kind to its table', () => {
    expect(tableForKind('note')).toBe('notes');
    expect(tableForKind('event')).toBe('calendar_events');
    expect(tableForKind('task')).toBe('todo_items');
    expect(tableForKind('shopping')).toBe('grocery_items');
  });
});

describe('undoCapture', () => {
  function makeDeleteFake() {
    const deletes: { table: string; ids: unknown }[] = [];
    let curTable = '';
    let removed: string[] = [];
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      delete: () => b,
      select: () => b,
      abortSignal: () => b,
      in: (_col: string, ids: string[]) => { deletes.push({ table: curTable, ids }); removed = ids; return b; },
      then: (resolve: (v: { data: { id: string }[]; error: null }) => void) => resolve({ data: removed.map(id => ({ id })), error: null }),
    });
    const client = { from: (t: string) => { curTable = t; return b; } } as unknown as SupabaseBrowser;
    return { client, deletes };
  }

  it('deletes the created rows from the right table', async () => {
    const { client, deletes } = makeDeleteFake();
    const ids = [randomUUID(), randomUUID()];
    await undoCapture(client, { table: 'grocery_items', ids });
    expect(deletes).toEqual([{ table: 'grocery_items', ids }]);
  });

  it('is a no-op when there are no ids', async () => {
    const { client, deletes } = makeDeleteFake();
    await undoCapture(client, { table: 'notes', ids: [] });
    expect(deletes).toEqual([]);
  });
});
