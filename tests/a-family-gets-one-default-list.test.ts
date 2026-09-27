import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

vi.mock('server-only', () => ({}));

/**
 * DATA-007: two first captures at once gave a family two default lists.
 *
 * Every writer that files a grocery or a to-do without naming a list read "the
 * oldest open list" and inserted one when there was none, with nothing between
 * the two. 0443 makes the get-or-create one serialised operation, and
 * docs/audit/a-family-gets-one-default-list-check.sql races two real sessions
 * against it and against a lock-less copy. This file holds the application's
 * half: that every caller goes through the RPC, that a real error is never read
 * as "no list", and that a database without 0443 still works.
 */

const { ensureDefaultGroceryListId } = await import('@/lib/services/groceries');
const { ensureTodoListId } = await import('@/lib/services/tasks');

type Db = SupabaseClient<Database>;

describe('the default grocery list is one operation', () => {
  it('asks the database for it in one call, and writes nothing itself', async () => {
    const calls: Record<string, unknown>[] = [];
    const db = createInMemorySupabase<Db>({
      rpc: { ensure_default_grocery_list: (args) => { calls.push(args); return 'list-from-rpc'; } },
    });
    const result = await ensureDefaultGroceryListId(db, 'fam-1', 'user-1');
    expect(result).toEqual({ id: 'list-from-rpc', error: null });
    expect(calls).toEqual([{ p_family_id: 'fam-1', p_name: 'Groceries', p_created_by: 'user-1' }]);
    expect((db as unknown as { table: (t: string) => unknown[] }).table('grocery_lists')).toEqual([]);
  });

  it('returns a refusal rather than reading it as "no list" and creating one', async () => {
    const db = createInMemorySupabase<Db>({
      rpc: { ensure_default_grocery_list: () => { throw new Error('permission denied for table grocery_lists'); } },
    });
    const result = await ensureDefaultGroceryListId(db, 'fam-1', 'user-1');
    expect(result.id).toBeNull();
    expect(result.error).toBeTruthy();
    expect((db as unknown as { table: (t: string) => unknown[] }).table('grocery_lists')).toEqual([]);
  });

  it('still works on a database without 0443, and still makes only one', async () => {
    // No handler: the in-memory client answers 42883, as Postgres does.
    const db = createInMemorySupabase<Db>({ defaults: { grocery_lists: { is_archived: false, archived_at: null } } });
    const first = await ensureDefaultGroceryListId(db, 'fam-1', 'user-1');
    const second = await ensureDefaultGroceryListId(db, 'fam-1', 'user-1');
    expect(first.id).toBeTruthy();
    expect(second.id).toBe(first.id);
    expect((db as unknown as { table: (t: string) => unknown[] }).table('grocery_lists')).toHaveLength(1);
  });
});

describe('the to-do twin', () => {
  it('asks for a default or a named list, and says which', async () => {
    const calls: Record<string, unknown>[] = [];
    const db = createInMemorySupabase<Db>({
      rpc: { ensure_default_todo_list: (args) => { calls.push(args); return `todo-${String(args.p_name)}`; } },
    });
    expect((await ensureTodoListId(db, 'fam-1', 'member-1', 'To-Do', false)).id).toBe('todo-To-Do');
    expect((await ensureTodoListId(db, 'fam-1', 'member-1', 'School', true)).id).toBe('todo-School');
    expect(calls).toEqual([
      { p_family_id: 'fam-1', p_name: 'To-Do', p_match_name: false, p_created_by: 'member-1' },
      { p_family_id: 'fam-1', p_name: 'School', p_match_name: true, p_created_by: 'member-1' },
    ]);
  });
});

describe('no writer creates a default list around the one get-or-create', () => {
  // A list a PERSON creates by name (the shopping and to-do modules' "New
  // list") is not a default and is not raced; everything else must come
  // through the helper, or the next caller brings the duplicate back.
  //
  // Each exception says why:
  //   lib/services/*                    the helpers' own fallback for a
  //                                     database without 0443
  //   shopping-, todos-, recipes-module a list the person NAMED ("New list",
  //                                     "Add to a new list")
  //   dashboard/migrate/actions.ts      the importer's own named list, looked
  //                                     up by NAME, not the family default
  //   lib/capture/save.ts               its fallback for a database without
  //                                     0443 only: an empty lookup goes through
  //                                     the get-or-create first (Q72), inside the
  //                                     request-deadline machinery the capture
  //                                     harnesses pin request by request.
  const ALLOWED = new Map([
    ['grocery_lists', new Set([
      'lib/services/groceries/index.ts', 'components/modules/shopping-module.tsx',
      'components/modules/recipes-module.tsx', 'app/(app)/dashboard/migrate/actions.ts',
      'lib/capture/save.ts',
    ])],
    ['todo_lists', new Set(['lib/services/tasks/index.ts', 'components/modules/todos-module.tsx', 'lib/capture/save.ts'])],
  ]);

  function files(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) files(path, out);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
    }
    return out;
  }

  it('inserts grocery and to-do lists only where it is allowed to', () => {
    const offenders: string[] = [];
    for (const file of [...files('app'), ...files('lib'), ...files('components')]) {
      const source = readFileSync(file, 'utf8');
      for (const [table, allowed] of ALLOWED) {
        const insert = new RegExp(`from\\(\\s*['"]${table}['"]\\s*\\)[\\s\\S]{0,40}?\\.insert\\(`);
        if (insert.test(source) && !allowed.has(file)) offenders.push(`${file} inserts into ${table}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
