// M34 — launching a playbook writes real work, or writes nothing.
//
// The old launch wrote a plan and a checklist and stopped there. It now also
// creates to-dos and reminders through the domain services and opens the row in
// the module that owns the transition (Move Planner, Home Projects, Vacations).
// Five writes across four tables cannot be one PostgREST transaction, so the
// property that matters is ALL OR NOTHING: this file drives the real launcher
// against the in-memory Supabase and asserts both halves — what a success
// leaves behind, and that a failure at each stage leaves the household exactly
// as it was.
//
// It also pins the boundary the server action is supposed to keep: the action
// does auth and copy, the library does the work.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { launchLifeEvent, refsInNote, noteWithRef, reminderItemsFor, todoItemsFor, resolveAnchor } from '@/lib/life-events/launch';
import { buildPlanItems, getTemplate } from '@/lib/life-events/templates';
import type { ServiceScope } from '@/lib/services/types';

const FAMILY = 'fam-1';
const USER = 'user-1';
const MEMBER = 'member-1';
const NOW = new Date('2026-03-10T12:00:00Z');

let db: InMemorySupabase;

function scope(): ServiceScope {
  return {
    db: db as never, familyId: FAMILY, userId: USER, memberId: MEMBER,
    role: 'parent', actorKind: 'member', tz: 'UTC', now: NOW,
  } as ServiceScope;
}

/** Make the next insert into `table` fail the way Postgres would. */
function breakInsert(table: string) {
  const original = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation((name: string) => {
    const builder = original(name);
    if (name !== table) return builder;
    const insert = builder.insert.bind(builder);
    builder.insert = ((payload: unknown) => {
      const chained = insert(payload as never);
      const failure = { data: null, error: { code: '23514', message: `${table} write rejected`, details: null, hint: null }, count: null, status: 400, statusText: 'Bad Request' };
      const failing = {
        select: () => failing,
        single: async () => failure,
        maybeSingle: async () => failure,
        then: (resolve: (v: unknown) => void) => resolve(failure),
      };
      void chained;
      return failing;
    }) as never;
    return builder;
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  // The column default 0245 actually declares (`status text NOT NULL DEFAULT
  // 'planning'`), so a move the service opens carries the same status in the
  // fake as it does in Postgres. The moving service leaves `status` to the
  // database on purpose — it is the table's business what a new move starts
  // as — and a fake with no default would read that as `undefined` and fail
  // an assertion the real column would pass. Same precedent as the routing
  // test's defaults for family_inbox_messages.
  db = createInMemorySupabase({ defaults: { moves: { status: 'planning' } } });
});

describe('the pure halves of a launch', () => {
  it('anchors on the caller\'s date when it is a real day key, else the lead time', () => {
    expect(resolveAnchor(30, '2026-09-01', NOW)).toBe('2026-09-01');
    expect(resolveAnchor(30, 'soon', NOW)).toBe('2026-04-09');
    expect(resolveAnchor(30, null, NOW)).toBe('2026-04-09');
  });

  it('turns only the doing categories into to-dos, capped', () => {
    const items = buildPlanItems(getTemplate('new_baby')!, '2026-06-01');
    const todos = todoItemsFor(items);
    expect(todos.length).toBeGreaterThan(0);
    expect(todos.length).toBeLessThanOrEqual(6);
    for (const t of todos) expect(['buy', 'plan', 'notify']).toContain(t.category);
  });

  it('only reminds about hard deadlines that are actually near', () => {
    const items = buildPlanItems(getTemplate('vacation')!, '2026-04-01');
    const reminders = reminderItemsFor(items, '2026-03-10');
    expect(reminders.length).toBeLessThanOrEqual(3);
    for (const r of reminders) {
      expect(['book', 'document', 'health']).toContain(r.category);
      expect(r.due_on >= '2026-03-10').toBe(true);
    }
    // Nothing in the past, and nothing beyond the horizon.
    expect(reminderItemsFor(items, '2027-01-01')).toEqual([]);
  });

  it('records artefact links in a note without losing the template\'s own note', () => {
    expect(noteWithRef('Use the packing list.', '[bubaly:todo:abc]')).toBe('Use the packing list. [bubaly:todo:abc]');
    expect(noteWithRef(null, '[bubaly:todo:abc]')).toBe('[bubaly:todo:abc]');
    expect(noteWithRef('Keep me', null)).toBe('Keep me');
    expect(refsInNote('Keep me [bubaly:todo:abc] [bubaly:reminder:def]')).toEqual([
      { kind: 'todo', id: 'abc' }, { kind: 'reminder', id: 'def' },
    ]);
    expect(refsInNote(null)).toEqual([]);
  });
});

describe('a launch that succeeds', () => {
  it('writes the plan, the checklist, real to-dos and real reminders', async () => {
    const result = await launchLifeEvent(scope(), { templateKey: 'school_start', eventDate: '2026-04-01' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const plans = db.table('life_event_plans');
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ family_id: FAMILY, template_key: 'school_start', event_date: '2026-04-01' });

    const items = db.table('life_event_plan_items');
    expect(items).toHaveLength(result.data.itemCount);
    expect(items.every((i) => i.plan_id === plans[0].id)).toBe(true);

    // The to-dos are real rows on a real list, not checklist entries.
    expect(db.table('todo_items').length).toBe(result.data.todoIds.length);
    expect(result.data.todoIds.length).toBeGreaterThan(0);
    expect(db.table('todo_items')[0]).toMatchObject({ family_id: FAMILY });

    // And each item that produced one says so.
    const linked = items.filter((i) => refsInNote(i.note as string | null).length > 0);
    expect(linked.length).toBe(result.data.todoIds.length + result.data.reminderIds.length);
    const todoRefs = linked.flatMap((i) => refsInNote(i.note as string | null)).filter((r) => r.kind === 'todo');
    expect(todoRefs.map((r) => r.id).sort()).toEqual([...result.data.todoIds].sort());
  });

  it('hands a move off to the Move Planner and records it on the plan', async () => {
    const result = await launchLifeEvent(scope(), { templateKey: 'moving', eventDate: '2026-05-01' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.handoff).toMatchObject({ kind: 'move', href: '/dashboard/moving' });
    const moves = db.table('moves');
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ family_id: FAMILY, move_date: '2026-05-01', status: 'planning', title: 'Moving Home' });
    expect(db.table('life_event_plans')[0].notes).toBe(`[bubaly:move:${moves[0].id}]`);
  });

  it('hands a renovation to Home Projects and a vacation to Vacations', async () => {
    const renovation = await launchLifeEvent(scope(), { templateKey: 'renovation', eventDate: '2026-06-01' });
    expect(renovation.ok && renovation.data.handoff?.kind).toBe('project');
    expect(db.table('home_projects')[0]).toMatchObject({ family_id: FAMILY, kind: 'renovation', status: 'planning', target_start: '2026-06-01' });

    const vacation = await launchLifeEvent(scope(), { templateKey: 'vacation', eventDate: '2026-07-01' });
    expect(vacation.ok && vacation.data.handoff?.kind).toBe('vacation');
    expect(db.table('vacations')[0]).toMatchObject({ family_id: FAMILY, start_date: '2026-07-01' });
  });

  it('leaves a checklist-only template with no handoff at all', async () => {
    const result = await launchLifeEvent(scope(), { templateKey: 'emergency_prep', eventDate: '2026-05-01' });
    expect(result.ok && result.data.handoff).toBeNull();
    expect(db.table('moves')).toHaveLength(0);
    expect(db.table('home_projects')).toHaveLength(0);
    expect(db.table('vacations')).toHaveLength(0);
  });

  it('refuses a template it does not know, and writes nothing', async () => {
    const result = await launchLifeEvent(scope(), { templateKey: 'not_a_playbook' });
    expect(result.ok).toBe(false);
    expect(db.table('life_event_plans')).toHaveLength(0);
  });
});

describe('a launch that fails rolls all the way back', () => {
  it('undoes the plan, the handoff and the to-dos when the checklist write fails', async () => {
    breakInsert('life_event_plan_items');
    const result = await launchLifeEvent(scope(), { templateKey: 'moving', eventDate: '2026-05-01' });

    expect(result.ok).toBe(false);
    expect(db.table('life_event_plans')).toHaveLength(0);
    expect(db.table('life_event_plan_items')).toHaveLength(0);
    expect(db.table('moves')).toHaveLength(0);
    expect(db.table('todo_items')).toHaveLength(0);
    expect(db.table('family_reminders')).toHaveLength(0);
  });

  it('undoes the plan when the handoff itself fails', async () => {
    breakInsert('moves');
    const result = await launchLifeEvent(scope(), { templateKey: 'moving', eventDate: '2026-05-01' });

    expect(result.ok).toBe(false);
    expect(db.table('life_event_plans')).toHaveLength(0);
    expect(db.table('moves')).toHaveLength(0);
  });

  it('undoes everything when a to-do write fails half way through', async () => {
    breakInsert('todo_items');
    const result = await launchLifeEvent(scope(), { templateKey: 'school_start', eventDate: '2026-04-01' });

    expect(result.ok).toBe(false);
    expect(db.table('life_event_plans')).toHaveLength(0);
    expect(db.table('life_event_plan_items')).toHaveLength(0);
    expect(db.table('todo_items')).toHaveLength(0);
  });
});

describe('the server action stays a boundary', () => {
  const source = readFileSync(new URL('../app/(app)/dashboard/life-event-actions.ts', import.meta.url), 'utf8');

  it('delegates the work rather than writing rows itself', () => {
    expect(source).toContain("from '@/lib/life-events/launch'");
    expect(source).toContain('launchLifeEvent(scope');
    // No direct table writes for the launch path: those live in the library
    // that can roll them back.
    expect(source).not.toContain("from('life_event_plan_items')");
    expect(source).not.toContain("insert({ family_id");
  });

  it('authenticates and scopes before it does anything', () => {
    expect(source).toContain('requireUserContext()');
    expect(source).toContain('scopeFromUserContext(ctx, supabase)');
  });
});
