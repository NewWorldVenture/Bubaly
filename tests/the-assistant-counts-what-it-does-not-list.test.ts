import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { tasksSlice } from '@/lib/ai/context/slices/tasks';
import type { SliceEnv } from '@/lib/ai/context/policy';
import type { FamilyMember } from '@/lib/services/family';
import type { ServiceScope } from '@/lib/services/types';
import { answerAssistant, type AssistantLink } from '@/lib/assistant/service';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// N15 — the assistant's context and the kitchen speaker stated a capped read
// as the family's total, driven here through the REAL tasks slice and the
// REAL speaker answer against an in-memory database.
//
// The slice read 40 open to-dos and 60 open chores and wrote "40 open to-dos"
// for a family with 150, then computed the "Load split (fairness N/100)" and
// "Rebalance idea" lines from that due-date-ordered prefix, so they could
// contradict the Workload page they claim to match. The speaker read 40 items
// and said "40 things on your to-do list … and 30 more" of a list of 120.

const FAMILY = 'family-1';
const MUM = 'member-mum';
const DAD = 'member-dad';
let db: InMemorySupabase;

const member = (id: string, displayName: string): FamilyMember => ({
  id, userId: `user-${id}`, displayName, role: 'parent', birthday: null, age: null, isActive: true,
  canManage: true, hasLogin: true, color: null, avatarUrl: null,
});
const scope = (): ServiceScope => ({
  db: db as unknown as SupabaseClient<Database>, familyId: FAMILY, userId: 'user-member-mum', memberId: MUM,
  role: 'parent', actorKind: 'member', tz: 'UTC',
});
const env = (): SliceEnv => ({
  now: new Date('2026-10-13T12:00:00Z'), tz: 'UTC', todayKey: '2026-10-13',
  weekFromIso: '2026-10-13T00:00:00.000Z', weekToIso: '2026-10-20T00:00:00.000Z',
  viewer: { role: 'parent', memberId: MUM, canManage: true },
  members: [member(MUM, 'Mum'), member(DAD, 'Dad')], pageContext: null,
});
const todo = (i: number, assignee: string, due: string | null) => ({
  id: `todo-${String(i).padStart(4, '0')}`, family_id: FAMILY, list_id: 'list-1', title: `Task ${i}`, is_done: false,
  due_date: due, priority: 'medium', assigned_to_id: assignee, created_at: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
});

beforeEach(() => {
  db = createInMemorySupabase();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('todo_lists', [{ id: 'list-1', family_id: FAMILY, name: 'Family', archived_at: null }]);
});
afterEach(() => vi.restoreAllMocks());

describe('the assistant context says how many there are, not how many it read', () => {
  it('a family with 150 open to-dos is told it has 150, and given no split computed from 40', async () => {
    // The 40 soonest-due are all Dad's; Mum carries the other 110.
    db.seed('todo_items', [
      ...Array.from({ length: 40 }, (_, i) => todo(i, DAD, '2026-10-14')),
      ...Array.from({ length: 110 }, (_, i) => todo(100 + i, MUM, null)),
    ]);
    const result = await tasksSlice.load(scope(), env());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lines[0]).toBe('- showing 40 of 150 open to-dos, 0 open chores');
    expect(result.data.lines.some((line) => line.startsWith('- Load split'))).toBe(false);
    expect(result.data.lines.some((line) => line.startsWith('- Rebalance idea'))).toBe(false);
  });

  it('a family whose open work fits in the read keeps its total and its split', async () => {
    db.seed('todo_items', [todo(1, DAD, '2026-10-14'), todo(2, MUM, null), todo(3, MUM, null)]);
    const result = await tasksSlice.load(scope(), env());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lines[0]).toBe('- 3 open to-dos, 0 open chores');
    expect(result.data.lines.some((line) => line.startsWith('- Load split'))).toBe(true);
  });

  it('a count that cannot be read fails the slice rather than reporting the rows as the total', async () => {
    db.seed('todo_items', [todo(1, DAD, null)]);
    const realFrom = db.from.bind(db);
    db.from = ((table: string) => {
      const builder = realFrom(table);
      if (table !== 'chore_assignments') return builder;
      const select = builder.select.bind(builder);
      builder.select = ((list?: string, opts?: { head?: boolean; count?: 'exact' }) => {
        if (!opts?.head) return select(list, opts);
        return { eq: () => ({ in: () => Promise.resolve({ data: null, count: null, error: { message: 'count refused' } }) }) };
      }) as typeof builder.select;
      return builder;
    }) as typeof db.from;
    const result = await tasksSlice.load(scope(), env());
    expect(result.ok).toBe(false);
  });
});

describe('the speaker says how long the list is', () => {
  const link: AssistantLink = { id: 'link-1', family_id: FAMILY, user_id: 'user-member-mum', provider: 'alexa', scopes: ['read'], timezone: 'UTC' };

  it('reads the first items of a 120-item to-do list and counts all 120', async () => {
    db.seed('todo_items', Array.from({ length: 120 }, (_, i) => todo(i, MUM, null)));
    const reply = await answerAssistant(db as unknown as SupabaseClient<Database>, link, { kind: 'list', list: 'tasks' } as never);
    expect(reply.speech).toMatch(/^120 things on your to-do list: /);
    expect(reply.speech).toContain('and 110 more');
  });

  it('and the shopping list the same way', async () => {
    db.seed('grocery_lists', [{ id: 'g-1', family_id: FAMILY, name: 'Shop', is_archived: false, archived_at: null }]);
    db.seed('grocery_items', Array.from({ length: 55 }, (_, i) => ({
      id: `g-${String(i).padStart(3, '0')}`, family_id: FAMILY, list_id: 'g-1', name: `Item ${i}`, quantity: null, is_checked: false,
      created_at: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
    })));
    const reply = await answerAssistant(db as unknown as SupabaseClient<Database>, link, { kind: 'list', list: 'shopping' } as never);
    expect(reply.speech).toMatch(/^55 things on the shopping list: /);
  });
});
