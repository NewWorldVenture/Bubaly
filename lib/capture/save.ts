// lib/capture/save.ts — the single place that turns a free-text capture into a
// real record. Shared by the floating Quick Capture sheet and the full-page
// /capture shell so both behave identically (natural-language times, due dates,
// multi-item shopping). Persistence lives here; the parsing lives in ./parse.

import type { SupabaseBrowser } from '@/lib/supabase/types';
import { parseEvent, parseDueDate, splitItems, parseGroceryItem, type CaptureKind } from './parse';

export type CaptureTable = 'notes' | 'calendar_events' | 'todo_items' | 'grocery_items';

/** Everything needed to undo a capture: the table and the created row ids. */
export type CaptureUndo = { table: CaptureTable; ids: string[]; familyId?: string };

export type CaptureOperationGuard = { isCurrent?: () => boolean };
type CaptureStage = 'lookup' | 'list' | 'capture' | 'undo';

/** An uncertain dispatched write must be reviewed, never blindly created again. */
export class CaptureSaveError extends Error {
  readonly code?: string;
  constructor(
    readonly outcome: 'failed' | 'uncertain' | 'retired',
    readonly stage: CaptureStage,
    readonly href: string,
    readonly dispatched: boolean,
    cause?: unknown,
  ) {
    const detail = cause && typeof cause === 'object' ? cause as { message?: unknown; code?: unknown } : null;
    super(outcome === 'retired' ? 'Capture operation is no longer current'
      : outcome === 'uncertain' ? 'Capture result is unconfirmed. Review the destination before trying again.'
        : typeof detail?.message === 'string' ? detail.message : 'Could not save capture', { cause });
    this.name = 'CaptureSaveError';
    if (typeof detail?.code === 'string') this.code = detail.code;
  }
}

const HREF: Record<CaptureTable, string> = { notes: '/dashboard/notes', calendar_events: '/dashboard/calendar', todo_items: '/dashboard/todos', grocery_items: '/dashboard/grocery' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_TIMEOUT_MS = 15_000;
type Operation = CaptureOperationGuard & { href: string; dispatched: boolean };
type Reply = { data: unknown; error: unknown };

function current(operation: Operation, stage: CaptureStage) {
  if (operation.isCurrent && !operation.isCurrent()) throw new CaptureSaveError('retired', stage, operation.href, operation.dispatched);
}
function failure(operation: Operation, stage: CaptureStage, outcome: 'failed' | 'uncertain', cause?: unknown): never {
  throw new CaptureSaveError(outcome, stage, operation.href, operation.dispatched, cause);
}
function validId(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
function receiptIds(data: unknown, expected: number): string[] | null {
  if (!Array.isArray(data) || data.length !== expected) return null;
  const ids = data.map(row => row && typeof row === 'object' ? row.id : undefined);
  return ids.every(validId) && new Set(ids).size === expected ? ids : null;
}
function definitiveRejection(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  // These PostgreSQL errors reject/roll back the statement. Transport errors,
  // gateway failures and post-mutation representation errors remain uncertain.
  return typeof code === 'string' && (/^(22|23|40|42|44)[A-Z0-9]{3}$/.test(code) || code === 'P0001');
}
async function request(operation: Operation, stage: CaptureStage, mutation: boolean, build: (signal: AbortSignal) => PromiseLike<Reply>): Promise<unknown> {
  current(operation, stage);
  const controller = new AbortController();
  let query: PromiseLike<Reply>;
  try { query = build(controller.signal); } catch (error) { failure(operation, stage, 'failed', error); }
  current(operation, stage);
  if (mutation) operation.dispatched = true;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      // The installed SDK recognizes AbortError as terminal; TimeoutError would
      // enter its automatic GET retry loop even though this signal is aborted.
      const error = new DOMException('Capture request timed out', 'AbortError');
      controller.abort(error);
      reject(error);
    }, REQUEST_TIMEOUT_MS);
  });
  let reply: Reply;
  // Abort the actual SDK fetch; the deadline also bounds a transport that fails
  // to settle on abort. A delayed acknowledgement can never resolve this save.
  try { reply = await Promise.race([query, deadline]); } catch (error) {
    current(operation, stage);
    failure(operation, stage, mutation ? 'uncertain' : 'failed', error);
  } finally { clearTimeout(timer); }
  current(operation, stage);
  if (expired) failure(operation, stage, mutation ? 'uncertain' : 'failed');
  if (reply.error) failure(operation, stage, !mutation || definitiveRejection(reply.error) ? 'failed' : 'uncertain', reply.error);
  return reply.data;
}
async function write(operation: Operation, stage: 'list' | 'capture' | 'undo', count: number, build: (signal: AbortSignal) => PromiseLike<Reply>): Promise<string[]> {
  const data = await request(operation, stage, true, build);
  current(operation, stage);
  const ids = receiptIds(data, count);
  if (!ids) failure(operation, stage, 'uncertain');
  return ids;
}

export type CaptureSaveResult = {
  kind: CaptureKind;
  /** How many records were created (shopping can be >1). */
  count: number;
  /** A short label for the created thing (e.g. the event/task title). */
  title: string;
  /** Where the user can go to see it. */
  href: string;
  /** What to delete to undo this capture. */
  undo: CaptureUndo;
};

/** The table a capture kind writes to (used for undo). */
export function tableForKind(kind: CaptureKind): CaptureTable {
  switch (kind) {
    case 'note': return 'notes';
    case 'event': return 'calendar_events';
    case 'task': return 'todo_items';
    case 'shopping': return 'grocery_items';
  }
}

export type CaptureSaveInput = CaptureOperationGuard & {
  kind: CaptureKind;
  text: string;
  familyId: string;
  userId: string;
  /** The acting member, used to self-assign tasks. */
  memberId?: string | null;
};

/** Get-or-create the family's default to-do list. `todo_lists.created_by`
 *  references family_members(id), not auth.users, so it takes the member id. */
async function defaultTodoListId(supabase: SupabaseBrowser, familyId: string, memberId: string | null, operation: Operation): Promise<string> {
  const existing = await request(operation, 'lookup', false, signal => supabase.from('todo_lists').select('id')
    .eq('family_id', familyId).is('archived_at', null).order('created_at', { ascending: true }).limit(1).abortSignal(signal).maybeSingle());
  current(operation, 'lookup');
  if (existing !== null) {
    if (typeof existing !== 'object' || !('id' in existing) || !validId(existing.id)) failure(operation, 'lookup', 'failed');
    return existing.id;
  }
  return (await write(operation, 'list', 1, signal => supabase.from('todo_lists')
    .insert({ family_id: familyId, name: 'To-Do', created_by: memberId }).select('id').abortSignal(signal)))[0];
}

/** Get-or-create the family's default grocery list. */
async function defaultGroceryListId(supabase: SupabaseBrowser, familyId: string, userId: string, operation: Operation): Promise<string> {
  // BOTH archive columns. `grocery_lists` carries `is_archived` from 0002 and
  // `archived_at` from 0014, and nothing in the application ever sets the
  // first — the shopping module stamps the second. So an is_archived-only
  // reader takes the family's oldest list whether or not they put it away, and
  // Quick Capture drops the milk somewhere nobody looks while saying it saved.
  const existing = await request(operation, 'lookup', false, signal => supabase.from('grocery_lists').select('id')
    .eq('family_id', familyId).eq('is_archived', false).is('archived_at', null)
    .order('created_at', { ascending: true }).limit(1).abortSignal(signal).maybeSingle());
  current(operation, 'lookup');
  if (existing !== null) {
    if (typeof existing !== 'object' || !('id' in existing) || !validId(existing.id)) failure(operation, 'lookup', 'failed');
    return existing.id;
  }
  return (await write(operation, 'list', 1, signal => supabase.from('grocery_lists')
    .insert({ family_id: familyId, name: 'Shopping List', created_by: userId }).select('id').abortSignal(signal)))[0];
}

/**
 * Persist a capture. Throws on a database error (callers show a toast). Applies
 * the same natural-language parsing the previews use, so what the user sees is
 * what gets saved.
 */
export async function saveCapture(supabase: SupabaseBrowser, input: CaptureSaveInput): Promise<CaptureSaveResult> {
  const { kind, familyId, userId, memberId } = input;
  const operation: Operation = { isCurrent: input.isCurrent, href: HREF[tableForKind(kind)], dispatched: false };
  current(operation, 'capture');
  const value = input.text.trim();
  if (!value) throw new Error('Nothing to capture');

  if (kind === 'note') {
    const ids = await write(operation, 'capture', 1, signal => supabase.from('notes')
      .insert({ family_id: familyId, body: value, created_by: userId }).select('id').abortSignal(signal));
    current(operation, 'capture');
    return { kind, count: ids.length, title: value.slice(0, 60), href: operation.href, undo: { table: 'notes', ids, familyId } };
  }

  if (kind === 'event') {
    const parsed = parseEvent(value);
    const ids = await write(operation, 'capture', 1, signal => supabase.from('calendar_events').insert({
      family_id: familyId, title: parsed.title, starts_at: parsed.startsAt.toISOString(),
      all_day: parsed.allDay, category: 'general', created_by: userId,
    }).select('id').abortSignal(signal));
    current(operation, 'capture');
    return { kind, count: ids.length, title: parsed.title, href: operation.href, undo: { table: 'calendar_events', ids, familyId } };
  }

  if (kind === 'task') {
    // todo_lists/todo_items.created_by reference family_members(id) (migration
    // 0015) — the auth user id violates that FK and the task never saves.
    const listId = await defaultTodoListId(supabase, familyId, memberId ?? null, operation);
    current(operation, 'capture');
    const { title, dueDate } = parseDueDate(value);
    const ids = await write(operation, 'capture', 1, signal => supabase.from('todo_items').insert({
      family_id: familyId, list_id: listId, title, due_date: dueDate, created_by: memberId ?? null,
      assigned_to_id: memberId ?? null,
    }).select('id').abortSignal(signal));
    current(operation, 'capture');
    return { kind, count: ids.length, title, href: operation.href, undo: { table: 'todo_items', ids, familyId } };
  }

  // shopping
  const listId = await defaultGroceryListId(supabase, familyId, userId, operation);
  current(operation, 'capture');
  const items = splitItems(value);
  const parsed = (items.length ? items : [value]).map(parseGroceryItem);
  const ids = await write(operation, 'capture', parsed.length, signal => supabase.from('grocery_items')
    .insert(parsed.map((p) => ({ family_id: familyId, list_id: listId, name: p.name, quantity: p.quantity, created_by: userId })))
    .select('id').abortSignal(signal));
  current(operation, 'capture');
  return { kind, count: ids.length, title: parsed.map((p) => p.name).join(', '), href: operation.href, undo: { table: 'grocery_items', ids, familyId } };
}

/** Undo a capture by deleting the rows it created. No-op when there's nothing
 *  to delete. Throws on a database error (caller shows a toast). */
export async function undoCapture(supabase: SupabaseBrowser, undo: CaptureUndo, options: CaptureOperationGuard = {}): Promise<void> {
  const operation: Operation = { ...options, href: HREF[undo.table], dispatched: false };
  current(operation, 'undo');
  if (!undo.ids.length) return;
  if (!undo.ids.every(validId) || new Set(undo.ids).size !== undo.ids.length) failure(operation, 'undo', 'failed');
  const removed = await write(operation, 'undo', undo.ids.length, signal => {
    let query = supabase.from(undo.table).delete().in('id', undo.ids);
    if (undo.familyId) query = query.eq('family_id', undo.familyId);
    return query.select('id').abortSignal(signal);
  });
  current(operation, 'undo');
  if (removed.some(id => !undo.ids.includes(id))) failure(operation, 'undo', 'uncertain');
}
