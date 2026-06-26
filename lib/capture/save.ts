// lib/capture/save.ts — the single place that turns a free-text capture into a
// real record. Shared by the floating Quick Capture sheet and the full-page
// /capture shell so both behave identically (natural-language times, due dates,
// multi-item shopping). Persistence lives here; the parsing lives in ./parse.

import type { SupabaseBrowser } from '@/lib/supabase/types';
import { parseEvent, parseDueDate, splitItems, type CaptureKind } from './parse';

export type CaptureSaveResult = {
  kind: CaptureKind;
  /** How many records were created (shopping can be >1). */
  count: number;
  /** A short label for the created thing (e.g. the event/task title). */
  title: string;
  /** Where the user can go to see it. */
  href: string;
};

export type CaptureSaveInput = {
  kind: CaptureKind;
  text: string;
  familyId: string;
  userId: string;
  /** The acting member, used to self-assign tasks. */
  memberId?: string | null;
};

/** Get-or-create the family's default to-do list. */
async function defaultTodoListId(supabase: SupabaseBrowser, familyId: string, userId: string): Promise<string | null> {
  const { data: existing } = await supabase.from('todo_lists').select('id')
    .eq('family_id', familyId).is('archived_at', null).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (existing) return existing.id;
  const { data: created } = await supabase.from('todo_lists')
    .insert({ family_id: familyId, name: 'To-Do', created_by: userId }).select('id').maybeSingle();
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
    const { error } = await supabase.from('notes').insert({ family_id: familyId, body: value, created_by: userId });
    if (error) throw error;
    return { kind, count: 1, title: value.slice(0, 60), href: '/dashboard/notes' };
  }

  if (kind === 'event') {
    const parsed = parseEvent(value);
    const { error } = await supabase.from('calendar_events').insert({
      family_id: familyId, title: parsed.title, starts_at: parsed.startsAt.toISOString(),
      all_day: parsed.allDay, category: 'general', created_by: userId,
    });
    if (error) throw error;
    return { kind, count: 1, title: parsed.title, href: '/dashboard/calendar' };
  }

  if (kind === 'task') {
    const listId = await defaultTodoListId(supabase, familyId, userId);
    if (!listId) throw new Error('Could not find a to-do list');
    const { title, dueDate } = parseDueDate(value);
    const { error } = await supabase.from('todo_items').insert({
      family_id: familyId, list_id: listId, title, due_date: dueDate, created_by: userId,
      assigned_to_id: memberId ?? null,
    });
    if (error) throw error;
    return { kind, count: 1, title, href: '/dashboard/todos' };
  }

  // shopping
  const listId = await defaultGroceryListId(supabase, familyId, userId);
  if (!listId) throw new Error('Could not find a grocery list');
  const items = splitItems(value);
  const names = items.length ? items : [value];
  const { error } = await supabase.from('grocery_items')
    .insert(names.map((name) => ({ family_id: familyId, list_id: listId, name, created_by: userId })));
  if (error) throw error;
  return { kind, count: names.length, title: names.join(', '), href: '/dashboard/grocery' };
}
