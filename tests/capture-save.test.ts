import { describe, it, expect } from 'vitest';
import { saveCapture } from '@/lib/capture/save';
import type { SupabaseBrowser } from '@/lib/supabase/types';

// A tiny chainable fake of the Supabase browser client: records every insert
// and resolves list lookups to an existing list (so we exercise the insert
// path, not list creation). Each builder is thenable so `await from().insert()`
// resolves like a terminal PostgREST call.
function makeFakeSupabase() {
  const inserts: { table: string; payload: unknown }[] = [];
  function builder(table: string) {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    Object.assign(b, {
      select: chain, eq: chain, is: chain, order: chain, limit: chain,
      insert: (payload: unknown) => { inserts.push({ table, payload }); return b; },
      maybeSingle: () =>
        Promise.resolve(
          table === 'todo_lists' || table === 'grocery_lists'
            ? { data: { id: `${table}-1` }, error: null }
            : { data: null, error: null },
        ),
      then: (resolve: (v: { data: null; error: null }) => void) => resolve({ data: null, error: null }),
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

  it('rejects empty input', async () => {
    const { client } = makeFakeSupabase();
    await expect(saveCapture(client, { ...BASE, kind: 'note', text: '   ' })).rejects.toThrow();
  });
});
