// A retried task whose date or title changed is not told "Task added".
//
// The quick add holds one submission id across every press until a row lands,
// and the key built from it is deliberately content-free (two children each
// needing "Pack the kit" are two compositions, not one). So when a parent
// presses Today, the insert commits but the response is lost, and they then
// press Tomorrow — or fix a typo — the second press arrives under the SAME key
// with DIFFERENT content. The guard found the first row and handed it back as a
// success: "Task added", the box cleared, and the task sat on the wrong day (or
// the retyped task was never created at all). Nothing compared the row to the
// request, and no log line said anything had been dropped.
//
// What the family should see instead: not a success, a message naming the task
// that really was saved, that task left exactly as it was, and — once the
// browser treats the next press as a new composition — the new task saved.
//
// What must NOT change: a caller whose key names an OPERATION rather than a
// person's composition (an executor step, a per-pet trip task) still gets the
// row its step already wrote, as before — a trip renamed between two attempts of
// one step must not stop the pet-care loop halfway.
//
// The Add Event and Add Chore modals hold one id the same way and stay open,
// fully editable, after a failed Save, so they are covered here too. The
// reminder quick adds are not: every reminder submission id carries FIXED
// content (a suggestion template, a call's or a message's action item), so a
// person cannot change it between presses and there is nothing to refuse. And
// applying a routine keys (routine, week) by design — a second Apply is the
// same composition whatever the steps now say — which is not this defect.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
// The REAL en-US catalogue, not a template of this file's own. A private
// template would pass while the catalogue lacks the key, and the family would
// read the raw 'tasks.alreadySavedAs' with no title in it (translate falls back
// to the key). Resolving through the catalogue and asserting the English
// sentence is what makes a missing entry fail here.
//
// RED UNTIL THE CATALOGUE MERGE LANDS: the key is requested in the i18n-asks
// file for this change and merged into lib/i18n/messages/*.json centrally,
// before commit. Until then the sentence assertions below fail, deliberately.
const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(MESSAGES, key, params),
}));

import { createTodoAction, updateTodoAction } from '@/app/(app)/dashboard/todos/actions';
import { createCalendarEventAction } from '@/app/(app)/dashboard/calendar/actions';
import { createChoreAction } from '@/app/(app)/dashboard/chores/actions';
import { createTodo } from '@/lib/services/tasks';
import { createPetCareTasks } from '@/lib/services/trips';
import { ALREADY_SAVED, makeKey, sameInstant } from '@/lib/services/idempotency';
import { scopeFromUserContext } from '@/lib/services/scope';
import { submissionSettled } from '@/lib/utils/submission-id';

const FAMILY = 'family-1';
const LIST = 'list-1';
const MEMBER = 'member-1';
const QUICK_ADD = '33333333-3333-4333-8333-333333333333';
const NEXT_PRESS = '44444444-4444-4444-8444-444444444444';

const TODAY = '2026-09-26';
const TOMORROW = '2026-09-27';

/** What the family reads for a press whose earlier attempt saved "Buy milk". */
const SAVED_AS_BUY_MILK =
  'An earlier try already saved this task as "Buy milk", so nothing was added or changed this time. ' +
  'Edit that task in your list, or add this one again as a new task.';
const SAVED_AS_SCHOOL_CONCERT =
  'An earlier try already saved this event as "School concert", so nothing was added or changed this time. ' +
  'Edit that event on the calendar, or add this one again as a new event.';
const SAVED_AS_MAKE_YOUR_BED =
  'An earlier try already saved this chore as "Make your bed", so nothing was added or changed this time. ' +
  'Edit that chore on the board, or add this one again as a new chore.';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
const tasks = () => db.table('todo_items').filter((r) => r.family_id === FAMILY);
let warn: ReturnType<typeof vi.spyOn>;

const CTX = {
  user: { id: 'user-1' },
  active: {
    familyId: FAMILY, role: 'parent',
    family: { name: 'Family One', timezone: 'America/Chicago' },
    member: { id: MEMBER },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      todo_items: {
        notes: null, is_done: false, priority: 'medium', due_date: null,
        tags: [], sort_order: 0, idempotency_key: null, completed_at: null,
        assigned_to_id: null,
      },
      todo_lists: { archived_at: null },
      pets: { is_active: true, notes: null, vet_name: null, vet_phone: null },
      calendar_events: {
        description: null, location: null, ends_at: null, all_day: false, category: 'general',
        recurrence: 'none', recurrence_until: null, assignee_id: null, idempotency_key: null,
      },
      chores: {
        description: null, points: 10, priority: 'medium', recurrence: 'none', due_at: null,
        requires_approval: true, icon: null, is_active: true,
      },
      chore_assignments: {
        status: 'todo', due_at: null, submitted_at: null, approved_at: null, approved_by: null,
        points_awarded: null, ai_score: null, cash_awarded_cents: null, idempotency_key: null, disputed: false,
      },
    },
    // 0256: partial unique on (family_id, idempotency_key), on each keyed table used here.
    uniques: {
      todo_items: [['family_id', 'idempotency_key']],
      calendar_events: [['family_id', 'idempotency_key']],
      chore_assignments: [['family_id', 'idempotency_key']],
    },
  });
  db.seed('todo_lists', [{ id: LIST, family_id: FAMILY, name: 'Tasks', created_by: MEMBER, sort_order: 0 }]);
  db.seed('family_members', [{ id: MEMBER, family_id: FAMILY }]);
  mocks.requireUserContext.mockResolvedValue(CTX);
  mocks.createServer.mockResolvedValue(db);
});
afterEach(() => vi.restoreAllMocks());

/** Exactly what the sidebar Quick Add sends for one press. */
const quickAdd = (title: string, dueDate: string, submissionId = QUICK_ADD) =>
  createTodoAction({ title, listId: LIST, dueDate, priority: 'medium', assigneeId: MEMBER, submissionId });

describe('Today pressed, response lost, then Tomorrow pressed', () => {
  it('is not told "Task added", is told which task was saved, and the saved task is left on its real day', async () => {
    const first = await quickAdd('Buy milk', TODAY);
    expect(first.ok).toBe(true); // committed — the browser just never heard back

    const retry = await quickAdd('Buy milk', TOMORROW);

    expect(retry.ok).toBe(false);
    expect(!retry.ok && retry.code).toBe('already_saved');
    expect(!retry.ok && retry.error).toBe(SAVED_AS_BUY_MILK);
    // One task, still due today: nothing was silently moved, nothing duplicated.
    expect(tasks()).toHaveLength(1);
    expect(tasks()[0]!.due_date).toBe(TODAY);
    // An operator can now see it happened; the log carries field names, not the task text.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('does not match the row its key already wrote'),
      expect.objectContaining({ fields: ['due_date'] }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Buy milk');
  });

  it('adds the Tomorrow task once the browser presses again as a new composition', async () => {
    await quickAdd('Buy milk', TODAY);
    const conflict = await quickAdd('Buy milk', TOMORROW);
    expect(!conflict.ok && conflict.code).toBe('already_saved');

    const again = await quickAdd('Buy milk', TOMORROW, NEXT_PRESS);

    expect(again.ok).toBe(true);
    expect(tasks().map((r) => r.due_date).sort()).toEqual([TODAY, TOMORROW]);
  });
});

describe('a retyped title under the same press', () => {
  it('does not report the second task as added when only the first exists', async () => {
    await quickAdd('Buy milk', TODAY);

    const retyped = await quickAdd('Call the dentist', TODAY);

    expect(retyped.ok).toBe(false);
    expect(!retyped.ok && retyped.error).toBe(SAVED_AS_BUY_MILK);
    expect(tasks().map((r) => r.title)).toEqual(['Buy milk']);
  });

  it('reports a typo fix too, rather than keeping the typo under a success', async () => {
    await quickAdd('Buy mlik', TODAY);
    const fixed = await quickAdd('Buy milk', TODAY);
    expect(fixed.ok).toBe(false);
    expect(!fixed.ok && fixed.code).toBe('already_saved');
    expect(tasks().map((r) => r.title)).toEqual(['Buy mlik']);
  });
});

describe('the task was edited after it landed, and the unchanged press is re-sent', () => {
  // The comparison is with the row as it stands now — nothing records what was
  // first written — so this is answered as a conflict too. The copy must be
  // true for it: the press changed nothing, and it must not claim the press
  // carried changes that were dropped.
  it('keeps the family\'s edit and says only that nothing was added or changed', async () => {
    const first = await quickAdd('Buy milk', TODAY);
    if (!first.ok) throw new Error(first.error);
    const moved = await updateTodoAction(first.id, { dueDate: TOMORROW });
    expect(moved.ok).toBe(true);

    const resent = await quickAdd('Buy milk', TODAY);

    expect(resent.ok).toBe(false);
    expect(!resent.ok && resent.code).toBe('already_saved');
    expect(!resent.ok && resent.error).toBe(SAVED_AS_BUY_MILK);
    expect(!resent.ok && resent.error).not.toMatch(/changes you (just )?made/i);
    expect(tasks()).toHaveLength(1);
    expect(tasks()[0]!.due_date).toBe(TOMORROW);
  });
});

describe('what must still be deduplicated', () => {
  it('an unchanged retry after a lost response is the same task and a success', async () => {
    const first = await quickAdd('Buy milk', TODAY);
    const retry = await quickAdd('  Buy milk ', TODAY); // same text as the service stores it
    expect(retry.ok).toBe(true);
    expect(retry.ok && first.ok && retry.id).toBe(first.ok ? first.id : null);
    expect(tasks()).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('two presses racing with different days: one lands, the other is not told it did', async () => {
    const [a, b] = await Promise.all([quickAdd('Buy milk', TODAY), quickAdd('Buy milk', TOMORROW)]);
    expect(tasks()).toHaveLength(1);
    const landed = tasks()[0]!.due_date;
    const results = [[a, TODAY], [b, TOMORROW]] as const;
    for (const [result, day] of results) {
      // Success is only ever reported for the press whose day is the day stored.
      expect(result.ok).toBe(day === landed);
    }
  });
});

describe('the same press on the Add Event modal', () => {
  const CONCERT_AT_7 = '2026-10-01T19:00:00.000Z';
  const CONCERT_AT_6 = '2026-10-01T18:00:00.000Z';
  const events = () => db.table('calendar_events').filter((r) => r.family_id === FAMILY);
  /** What the modal's Save sends for one press: an absolute instant, so no zone is involved. */
  const save = (title: string, startsAt: string, submissionId = QUICK_ADD) =>
    createCalendarEventAction({ title, startsAt, endsAt: null, allDay: false, category: 'school', recurrence: 'none', submissionId });

  it('Save landed, response lost, time corrected, Save again: told which event was saved, and it stays at its real time', async () => {
    const first = await save('School concert', CONCERT_AT_7);
    expect(first.ok).toBe(true);

    const corrected = await save('School concert', CONCERT_AT_6);

    expect(corrected.ok).toBe(false);
    expect(!corrected.ok && corrected.code).toBe('already_saved');
    expect(!corrected.ok && corrected.error).toBe(SAVED_AS_SCHOOL_CONCERT);
    expect(events()).toHaveLength(1);
    expect(events()[0]!.starts_at).toBe(CONCERT_AT_7);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('does not match the row its key already wrote'),
      expect.objectContaining({ fields: ['starts_at'] }),
    );
  });

  it('an unchanged Save after a lost response is the same event, and a new id is a new one', async () => {
    const first = await save('School concert', CONCERT_AT_7);
    const retry = await save('School concert', CONCERT_AT_7);
    expect(retry.ok && first.ok && retry.id).toBe(first.ok ? first.id : null);
    expect(events()).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();

    const again = await save('School concert', CONCERT_AT_6, NEXT_PRESS);
    expect(again.ok).toBe(true);
    expect(events()).toHaveLength(2);
  });
});

describe('the same press on the Add Chore modal', () => {
  const chores = () => db.table('chores').filter((r) => r.family_id === FAMILY);
  const assignments = () => db.table('chore_assignments').filter((r) => r.family_id === FAMILY);
  /** What the board's Add sends for one press; `dueAt` is the bare day its date input gives. */
  const add = (title: string, dueAt: string | null, submissionId = QUICK_ADD) =>
    createChoreAction({ title, description: null, points: 10, priority: 'medium', recurrence: 'none', icon: null, dueAt, assigneeId: MEMBER, submissionId });

  it('Add landed, response lost, due day moved, Add again: told which chore was saved, and it keeps its day', async () => {
    const first = await add('Make your bed', TODAY);
    expect(first.ok).toBe(true);

    const moved = await add('Make your bed', TOMORROW);

    expect(moved.ok).toBe(false);
    expect(!moved.ok && moved.code).toBe('already_saved');
    expect(!moved.ok && moved.error).toBe(SAVED_AS_MAKE_YOUR_BED);
    // One chore with its one assignment: the pair was neither moved nor doubled.
    expect(chores()).toHaveLength(1);
    expect(assignments()).toHaveLength(1);
    expect(chores()[0]!.due_at).toBe(TODAY);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('does not match the row its key already wrote'),
      expect.objectContaining({ fields: ['due_at'] }),
    );
  });

  it('an unchanged Add after a lost response is the same chore, and a new id is a new one', async () => {
    const first = await add('Make your bed', TODAY);
    const retry = await add('Make your bed', TODAY);
    expect(retry.ok && first.ok && retry.id).toBe(first.ok ? first.id : null);
    expect(chores()).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();

    const again = await add('Make your bed', TOMORROW, NEXT_PRESS);
    expect(again.ok).toBe(true);
    expect(chores()).toHaveLength(2);
    expect(assignments()).toHaveLength(2);
  });

  it('reads a stored timestamptz back as the instant the bare day meant, not as different text', () => {
    // PostgREST returns the `2026-09-26` the board sent in its own text form. The
    // in-memory table above stores the text as sent and cannot show that, so the
    // comparison the guard uses is pinned here against the real shapes.
    expect(sameInstant('2026-09-26T00:00:00+00:00', '2026-09-26')).toBe(true);
    expect(sameInstant('2026-10-01T19:00:00+00:00', '2026-10-01T19:00:00.000Z')).toBe(true);
    expect(sameInstant('2026-09-27T00:00:00+00:00', '2026-09-26')).toBe(false);
    expect(sameInstant(null, null)).toBe(true);
    expect(sameInstant(null, '2026-09-26')).toBe(false);
  });
});

describe('a key that names an operation, not a person\'s composition', () => {
  const stepScope = (step: string) =>
    scopeFromUserContext(CTX as never, db as unknown as SupabaseClient<Database>, {
      idempotencyKey: makeKey(['executor-step', FAMILY, 'run-1', step, 'tasks.createTodo']),
    });

  it('a retried executor step whose recomputed content moved still gets the row it already wrote', async () => {
    const first = await createTodo(stepScope('step-1'), { title: 'Book the plumber', dueDate: TODAY });
    if (!first.ok) throw new Error(first.error);

    const retried = await createTodo(stepScope('step-1'), { title: 'Book the plumber', dueDate: TOMORROW });

    expect(retried.ok).toBe(true);
    expect(retried.ok && retried.data.id).toBe(first.data.id);
    expect(tasks()).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a pet-care retry after the trip was renamed does not stop halfway through the pets', async () => {
    const VACATION = 'vacation-1';
    const scope = stepScope('pet_care');
    db.seed('vacations', [{ id: VACATION, family_id: FAMILY, title: 'Lake week', start_date: '2026-10-10' }]);
    db.seed('pets', [{ id: 'pet-a', family_id: FAMILY, name: 'Biscuit', species: 'dog' }]);
    const first = await createPetCareTasks(scope, VACATION);
    expect(first.ok).toBe(true);

    // Before the step's retry: the trip is renamed (so Biscuit's recomputed task
    // no longer matches the stored one) and Mochi's task has not been written.
    db.table('vacations').find((r) => r.id === VACATION)!.title = 'Lake week (moved)';
    db.seed('pets', [{ id: 'pet-b', family_id: FAMILY, name: 'Mochi', species: 'cat' }]);

    const retried = await createPetCareTasks(scope, VACATION);

    expect(retried.ok).toBe(true);
    expect(retried.ok && retried.data.created.map((c) => c.petName)).toEqual(['Biscuit', 'Mochi']);
    expect(tasks()).toHaveLength(2);
  });
});

describe('the browser half: when the submission id is spent', () => {
  it('is spent once the save landed, and once the server answers already_saved', () => {
    expect(submissionSettled({ ok: true })).toBe(true);
    // Tied to the service's own code, so renaming one without the other fails here.
    expect(submissionSettled({ ok: false, code: ALREADY_SAVED })).toBe(true);
  });

  it('is held on any other failure, which may be a write that committed', () => {
    expect(submissionSettled({ ok: false })).toBe(false);
    expect(submissionSettled({ ok: false, code: 'db_error' })).toBe(false);
  });

  // A client component with hooks does not render under `environment: 'node'`
  // (see tests/todo-single-write-path.test.ts), so the call sites are read.
  // Without these, reverting one leaves every press after a conflict answered
  // `already_saved` again until the page is reloaded, with every service test
  // above still green.
  const stripped = (file: string) => readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((line) => line.replace(/(^|\s)\/\/.*$/, '')).join('\n');
  /** The source from `start` on; a renamed function fails here rather than matching nothing. */
  const from = (source: string, start: string) => {
    const at = source.indexOf(start);
    expect(at, start).toBeGreaterThanOrEqual(0);
    return source.slice(at);
  };

  function assertSettledModalRemint(source: string, requiresCurrentFence = false) {
    // Closing fences a pending result before its old modal can mutate state.
    // The guard still requires settlement and the exact fresh-id assignment.
    expect(source)
      .toMatch(/if \(!result\.ok\) \{\s*(?:if \(!isCurrent\(\)\) return;\s*)?if \(submissionSettled\(result\)\) submissionId\.current = newSubmissionId\(\);/);
    const tree = ts.createSourceFile('modal.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const refusals: ts.Block[] = [];
    function visit(node: ts.Node) {
      if (ts.isIfStatement(node) && node.expression.getText(tree) === '!result.ok' && ts.isBlock(node.thenStatement)) {
        refusals.push(node.thenStatement);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    const renewal = 'if (submissionSettled(result)) submissionId.current = newSubmissionId();';
    const statements = refusals.map((block) => block.statements.map((statement) => statement.getText(tree)))
      .find((block) => block.includes(renewal));
    expect(statements).toBeDefined();
    const at = (statement: string) => {
      const index = statements!.indexOf(statement);
      expect(index, `required statement missing: ${statement}`).toBeGreaterThanOrEqual(0);
      return index;
    };
    const renewalAt = at(renewal);
    const currentFence = 'if (!isCurrent()) return;';
    if (requiresCurrentFence) expect(at(currentFence)).toBeLessThan(renewalAt);
    else if (statements!.includes(currentFence)) expect(at(currentFence)).toBeLessThan(renewalAt);
  }
  it('Quick Add drops its id when the attempt is settled, before it branches on the result', () => {
    const quickAdd = from(stripped('components/modules/todos-module.tsx'), 'async function quickAdd(').split('async function openAdd(')[0]!;
    expect(quickAdd).toMatch(/if \(submissionSettled\(result\)\) quickSubmission\.current = '';\s*if \(!result\.ok\)/);
    // The id is dropped nowhere else, so a thrown call (a lost response) keeps it.
    expect(quickAdd.match(/quickSubmission\.current = /g)).toHaveLength(1);
  });

  it.each([
    ['components/modules/todos-module.tsx', 'function ItemModal(', false],
    ['components/modules/calendar-module.tsx', 'function NewEventModal(', false],
    ['components/modules/chores-module.tsx', 'function NewChoreModal(', true],
  ])('%s: the modal mints a fresh id when its save is settled without closing', (file, modal, requiresCurrentFence) => {
    assertSettledModalRemint(from(stripped(file), modal), requiresCurrentFence);
  });
});
