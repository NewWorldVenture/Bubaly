// lib/capture/save.ts — the single place that turns a free-text capture into a
// real record. Shared by the floating Quick Capture sheet and the full-page
// /capture shell so both behave identically (natural-language times, due dates,
// multi-item shopping). Persistence lives here; the parsing lives in ./parse.

import type { SupabaseBrowser } from '@/lib/supabase/types';
import { parseEvent, parseDueDate, splitItems, parseGroceryItem, type CaptureKind } from './parse';

export type CaptureTable = 'notes' | 'calendar_events' | 'todo_items' | 'grocery_items';

/** Everything needed to undo a capture: the table and the created row ids. */
export type CaptureUndo = { table: CaptureTable; ids: string[] };

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

export type CaptureSaveInput = {
  kind: CaptureKind;
  text: string;
  familyId: string;
  userId: string;
  /** The acting member, used to self-assign tasks. */
  memberId?: string | null;
};

/** Get-or-create the family's default to-do list. `todo_lists.created_by`
 *  references family_members(id), not auth.users, so it takes the member id. */
async function defaultTodoListId(supabase: SupabaseBrowser, familyId: string, memberId: string | null): Promise<string | null> {
  const { data: existing } = await supabase.from('todo_lists').select('id')
    .eq('family_id', familyId).is('archived_at', null).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (existing) return existing.id;
  const { data: created } = await supabase.from('todo_lists')
    .insert({ family_id: familyId, name: 'To-Do', created_by: memberId }).select('id').maybeSingle();
  return created?.id ?? null;
}

/** Get-or-create the family's default grocery list. */
async function defaultGroceryListId(supabase: SupabaseBrowser, familyId: string, userId: string): Promise<string | null> {
  const { data: existing } = await supabase.from('grocery_lists').select('id')
    .eq('family_id', familyId).eq('is_archived', false).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (existing) return existing.id;
  const { data: created } = await supabase.from('grocery_lists')
    .insert({ family_id: familyId, name: 'Shopping List', created_by: userId }).select('id').maybeSingle();
  return created?.id ?? null;
}

/**
 * Persist a capture. Throws on a database error (callers show a toast). Applies
 * the same natural-language parsing the previews use, so what the user sees is
 * what gets saved.
 */
export async function saveCapture(supabase: SupabaseBrowser, input: CaptureSaveInput): Promise<CaptureSaveResult> {
  const { kind, familyId, userId, memberId } = input;
  const value = input.text.trim();
  if (!value) throw new Error('Nothing to capture');

  if (kind === 'note') {
    const { data, error } = await supabase.from('notes')
      .insert({ family_id: familyId, body: value, created_by: userId }).select('id');
    if (error) throw error;
    return { kind, count: 1, title: value.slice(0, 60), href: '/dashboard/notes', undo: { table: 'notes', ids: ids(data) } };
  }

  if (kind === 'event') {
    const parsed = parseEvent(value);
    const { data, error } = await supabase.from('calendar_events').insert({
      family_id: familyId, title: parsed.title, starts_at: parsed.startsAt.toISOString(),
      all_day: parsed.allDay, category: 'general', created_by: userId,
    }).select('id');
    if (error) throw error;
    return { kind, count: 1, title: parsed.title, href: '/dashboard/calendar', undo: { table: 'calendar_events', ids: ids(data) } };
  }

  if (kind === 'task') {
    // todo_lists/todo_items.created_by reference family_members(id) (migration
    // 0015) — the auth user id violates that FK and the task never saves.
    const listId = await defaultTodoListId(supabase, familyId, memberId ?? null);
    if (!listId) throw new Error('Could not find a to-do list');
    const { title, dueDate } = parseDueDate(value);
    const { data, error } = await supabase.from('todo_items').insert({
      family_id: familyId, list_id: listId, title, due_date: dueDate, created_by: memberId ?? null,
      assigned_to_id: memberId ?? null,
    }).select('id');
    if (error) throw error;
    return { kind, count: 1, title, href: '/dashboard/todos', undo: { table: 'todo_items', ids: ids(data) } };
  }

  // shopping
  const listId = await defaultGroceryListId(supabase, familyId, userId);
  if (!listId) throw new Error('Could not find a grocery list');
  const items = splitItems(value);
  const parsed = (items.length ? items : [value]).map(parseGroceryItem);
  const { data, error } = await supabase.from('grocery_items')
    .insert(parsed.map((p) => ({ family_id: familyId, list_id: listId, name: p.name, quantity: p.quantity, created_by: userId })))
    .select('id');
  if (error) throw error;
  return { kind, count: parsed.length, title: parsed.map((p) => p.name).join(', '), href: '/dashboard/grocery', undo: { table: 'grocery_items', ids: ids(data) } };
}

/** Pull the created row ids out of a Supabase insert .select('id') result. */
function ids(data: { id: string }[] | null): string[] {
  return (data ?? []).map((r) => r.id);
}

/** Undo a capture by deleting the rows it created. No-op when there's nothing
 *  to delete. Throws on a database error (caller shows a toast). */
export async function undoCapture(supabase: SupabaseBrowser, undo: CaptureUndo): Promise<void> {
  if (!undo.ids.length) return;
  const { error } = await supabase.from(undo.table).delete().in('id', undo.ids);
  if (error) throw error;
}
