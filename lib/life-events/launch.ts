// lib/life-events/launch.ts — launching a life-event playbook actually does
// something (M34).
//
// BEFORE: launching wrote a `life_event_plans` row and twelve
// `life_event_plan_items`. Nothing reached the calendar, nobody was assigned
// anything, and a family with an eleven-item move checklist ALSO had a Move
// Planner that knew nothing about the move. The checklist was a second,
// disconnected to-do app.
//
// NOW a launch does three things beyond the checklist:
//   1. hands the transition to the module that owns it — moving → `moves`,
//      renovation → `home_projects`, vacation → `vacations` — so the family
//      lands in the tool that already does that job;
//   2. puts the doing items on real to-do lists through `lib/services/tasks`
//      and the hard-deadline items on real reminders through
//      `lib/services/reminders`, which means they show up in the brief, in
//      "what needs you", and in the ledger;
//   3. records what it created in each item's `note`, so the checklist can
//      point at the row it produced and a second launch can tell that the
//      first one already happened. No schema change: `note` is a text column
//      that was already there.
//
// ROLLBACK is the whole point of doing it here rather than in the action. Five
// writes across four tables cannot be one transaction through PostgREST, so
// every write pushes an undo, and the first failure unwinds them in reverse.
// A family that sees "could not start the plan" must not then find half a plan,
// three orphan to-dos and a move on file.
import 'server-only';
import { createReminder, deleteReminder } from '@/lib/services/reminders';
import { createTodo, deleteTodo } from '@/lib/services/tasks';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import { describeDbError } from '@/lib/supabase/errors';
import { buildPlanItems, getTemplate, addDays, type MaterializedItem } from './templates';

/** Categories that are somebody's job today — these become to-dos. */
const TODO_CATEGORIES = new Set(['buy', 'plan', 'notify']);
/** Categories with a hard external deadline — these become reminders. */
const REMINDER_CATEGORIES = new Set(['book', 'document', 'health']);
/** At most this many to-dos per launch: a checklist that dumps twelve tasks on someone is a checklist they delete. */
const MAX_TODOS = 6;
/** At most this many reminders per launch. */
const MAX_REMINDERS = 3;
/** Only dated items inside this window become reminders; anything further out is noise now. */
const REMINDER_HORIZON_DAYS = 45;
/** The hour a reminder fires, family-local. */
const REMINDER_HOUR = '09:00:00';

/** Where a launched transition is handed off to, and the row it created there. */
export type LifeEventHandoff = { kind: 'move' | 'project' | 'vacation'; id: string; href: string };

/** Which module owns which template. Templates not listed stay a checklist. */
export const HANDOFF_BY_TEMPLATE: Record<string, LifeEventHandoff['kind']> = {
  moving: 'move',
  renovation: 'project',
  vacation: 'vacation',
};

const HANDOFF_HREF: Record<LifeEventHandoff['kind'], string> = {
  move: '/dashboard/moving',
  project: '/dashboard/projects',
  vacation: '/dashboard/vacations',
};

/** The marker written into `life_event_plan_items.note`; parseable, and readable enough not to alarm anyone. */
export function linkRef(kind: 'todo' | 'reminder' | LifeEventHandoff['kind'], id: string): string {
  return `[bubaly:${kind}:${id}]`;
}

/** Append a link marker to an item note without losing the note the template wrote. */
export function noteWithRef(note: string | null, ref: string | null): string | null {
  if (!ref) return note;
  return note ? `${note} ${ref}` : ref;
}

/** Read the artefact links out of an item note. Used by the module and by the tests. */
export function refsInNote(note: string | null): { kind: string; id: string }[] {
  if (!note) return [];
  return [...note.matchAll(/\[bubaly:([a-z]+):([0-9a-zA-Z-]+)\]/g)].map((m) => ({ kind: m[1], id: m[2] }));
}

export type LaunchLifeEventInput = {
  templateKey: string;
  /** `YYYY-MM-DD`; when absent the template's default lead time from today is used. */
  eventDate?: string | null;
};

export type LaunchLifeEventResult = {
  planId: string;
  eventDate: string;
  itemCount: number;
  todoIds: string[];
  reminderIds: string[];
  handoff: LifeEventHandoff | null;
};

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** The anchor date for a launch: the caller's, when it is a real day key, else the template's lead time from today. */
export function resolveAnchor(templateLeadDays: number, eventDate: string | null | undefined, now: Date): string {
  if (typeof eventDate === 'string' && DAY_KEY.test(eventDate)) return eventDate;
  return addDays(now.toISOString().slice(0, 10), templateLeadDays);
}

/** The items that become to-dos: the doing categories, soonest first, capped. */
export function todoItemsFor(items: MaterializedItem[]): MaterializedItem[] {
  return items.filter((it) => TODO_CATEGORIES.has(it.category)).slice(0, MAX_TODOS);
}

/** The items that become reminders: hard deadlines inside the horizon, capped. */
export function reminderItemsFor(items: MaterializedItem[], todayKey: string): MaterializedItem[] {
  const horizon = addDays(todayKey, REMINDER_HORIZON_DAYS);
  return items
    .filter((it) => REMINDER_CATEGORIES.has(it.category) && it.due_on >= todayKey && it.due_on <= horizon)
    .slice(0, MAX_REMINDERS);
}

/**
 * Launch a playbook: the plan, the handoff, the checklist, the to-dos and the
 * reminders — or none of them.
 */
export async function launchLifeEvent(
  scope: ServiceScope,
  input: LaunchLifeEventInput,
): Promise<ServiceResult<LaunchLifeEventResult>> {
  const template = getTemplate(input.templateKey);
  if (!template) return fail('That life event is not one Bubaly knows.', { code: SERVICE_CODES.invalidInput });

  const now = scope.now ?? new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const anchor = resolveAnchor(template.defaultLeadDays, input.eventDate, now);

  // Every write pushes its undo; the first failure runs them newest-first.
  const undo: { what: string; run: () => Promise<void> }[] = [];
  const rollback = async (): Promise<void> => {
    for (const step of [...undo].reverse()) {
      try {
        await step.run();
      } catch (error) {
        // A failed rollback is worth shouting about — it is exactly the half-
        // created state this function exists to prevent.
        console.error(`[life-events] rollback of ${step.what} failed`, error);
      }
    }
  };

  // 1. The plan row.
  const { data: plan, error: planErr } = await scope.db
    .from('life_event_plans')
    .insert({
      family_id: scope.familyId,
      template_key: template.key,
      title: template.title,
      event_date: anchor,
      created_by: scope.userId,
    })
    .select('id')
    .single();
  if (planErr || !plan) {
    console.error('[life-events] plan create failed', planErr);
    return fail(describeDbError(planErr, 'Could not start that playbook.'), { code: SERVICE_CODES.db });
  }
  const planId = plan.id;
  undo.push({
    what: 'the plan',
    run: async () => { await scope.db.from('life_event_plans').delete().eq('id', planId).eq('family_id', scope.familyId); },
  });

  // 2. The handoff, when another module owns this transition.
  let handoff: LifeEventHandoff | null = null;
  const handoffKind = HANDOFF_BY_TEMPLATE[template.key];
  if (handoffKind) {
    const created = await createHandoff(scope, handoffKind, template.title, anchor);
    if (!created.ok) {
      await rollback();
      return created;
    }
    handoff = created.data;
    undo.push({ what: `the ${handoffKind}`, run: () => deleteHandoff(scope, handoff as LifeEventHandoff) });
    // The plan says where it is being run. `notes` is an existing column.
    const { error: noteErr } = await scope.db
      .from('life_event_plans')
      .update({ notes: linkRef(handoffKind, created.data.id) })
      .eq('id', planId)
      .eq('family_id', scope.familyId);
    if (noteErr) {
      console.error('[life-events] could not record the handoff on the plan', noteErr);
      await rollback();
      return fail(describeDbError(noteErr, 'Could not start that playbook.'), { code: SERVICE_CODES.db });
    }
  }

  // 3. The real work: to-dos and reminders, through the services, so they are
  //    ledgered and show up everywhere else household work shows up.
  const items = buildPlanItems(template, anchor);
  const refsByTitle = new Map<string, string[]>();
  const addRef = (title: string, ref: string) => {
    refsByTitle.set(title, [...(refsByTitle.get(title) ?? []), ref]);
  };

  const todoIds: string[] = [];
  for (const item of todoItemsFor(items)) {
    const created = await createTodo(scope, { title: item.title, dueDate: item.due_on, priority: item.category === 'notify' ? 'high' : 'medium' });
    if (!created.ok) {
      await rollback();
      return created;
    }
    todoIds.push(created.data.id);
    addRef(item.title, linkRef('todo', created.data.id));
    const todoId = created.data.id;
    undo.push({ what: 'a to-do', run: async () => { await deleteTodo(scope, todoId); } });
  }

  const reminderIds: string[] = [];
  for (const item of reminderItemsFor(items, todayKey)) {
    const created = await createReminder(scope, {
      title: item.title,
      remindAt: `${item.due_on}T${REMINDER_HOUR}`,
      notes: `${template.title} — ${item.category}`,
      priority: 'medium',
      aiSuggested: false,
    });
    if (!created.ok) {
      await rollback();
      return created;
    }
    reminderIds.push(created.data.id);
    addRef(item.title, linkRef('reminder', created.data.id));
    const reminderId = created.data.id;
    undo.push({ what: 'a reminder', run: async () => { await deleteReminder(scope, reminderId); } });
  }

  // 4. The checklist itself, each item carrying what it produced.
  const rows = items.map((it) => ({
    family_id: scope.familyId,
    plan_id: planId,
    title: it.title,
    category: it.category,
    due_on: it.due_on,
    sort: it.sort,
    note: noteWithRef(it.note, (refsByTitle.get(it.title) ?? []).join(' ') || null),
    created_by: scope.userId,
  }));
  const { error: itemsErr } = await scope.db.from('life_event_plan_items').insert(rows);
  if (itemsErr) {
    console.error('[life-events] checklist create failed', itemsErr);
    await rollback();
    return fail(describeDbError(itemsErr, 'Could not start that playbook.'), { code: SERVICE_CODES.db });
  }

  return ok({ planId, eventDate: anchor, itemCount: rows.length, todoIds, reminderIds, handoff });
}

/** Undo a handoff. Spelled out per kind so the table name stays a literal the types can check. */
async function deleteHandoff(scope: ServiceScope, handoff: LifeEventHandoff): Promise<void> {
  if (handoff.kind === 'move') {
    await scope.db.from('moves').delete().eq('id', handoff.id).eq('family_id', scope.familyId);
    return;
  }
  if (handoff.kind === 'project') {
    await scope.db.from('home_projects').delete().eq('id', handoff.id).eq('family_id', scope.familyId);
    return;
  }
  await scope.db.from('vacations').delete().eq('id', handoff.id).eq('family_id', scope.familyId);
}

/** Create the row in the module that owns this transition. */
async function createHandoff(
  scope: ServiceScope,
  kind: LifeEventHandoff['kind'],
  title: string,
  anchor: string,
): Promise<ServiceResult<LifeEventHandoff>> {
  if (kind === 'move') {
    const { data, error } = await scope.db
      .from('moves')
      .insert({ family_id: scope.familyId, title, move_date: anchor, status: 'planning', created_by: scope.userId })
      .select('id')
      .single();
    if (error || !data) {
      console.error('[life-events] move handoff failed', error);
      return fail(describeDbError(error, 'Could not open a move for that playbook.'), { code: SERVICE_CODES.db });
    }
    return ok({ kind, id: data.id, href: HANDOFF_HREF.move });
  }
  if (kind === 'project') {
    const { data, error } = await scope.db
      .from('home_projects')
      .insert({ family_id: scope.familyId, title, kind: 'renovation', status: 'planning', target_start: anchor, created_by: scope.userId })
      .select('id')
      .single();
    if (error || !data) {
      console.error('[life-events] project handoff failed', error);
      return fail(describeDbError(error, 'Could not open a project for that playbook.'), { code: SERVICE_CODES.db });
    }
    return ok({ kind, id: data.id, href: HANDOFF_HREF.project });
  }
  const { data, error } = await scope.db
    .from('vacations')
    .insert({ family_id: scope.familyId, title, start_date: anchor, created_by: scope.userId })
    .select('id')
    .single();
  if (error || !data) {
    console.error('[life-events] vacation handoff failed', error);
    return fail(describeDbError(error, 'Could not open a trip for that playbook.'), { code: SERVICE_CODES.db });
  }
  return ok({ kind, id: data.id, href: HANDOFF_HREF.vacation });
}
