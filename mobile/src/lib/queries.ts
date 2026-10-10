import type { Db } from './db';
import { completionPatch, OPEN_CHORE_STATUSES } from './chores-core';
import { dayKey } from './format';
import { config } from './config';
import { supabase as sessionClient } from './supabase';
import { buildCalendarRequest, parseCalendarReply, type CalendarOwner, type CalendarReply } from './calendar-core';

export type { EventRow } from './calendar-core';

export async function fetchUpcomingEvents(owner: CalendarOwner, days = 14, signal?: AbortSignal, now = new Date()): Promise<CalendarReply> {
  const { data, error } = await sessionClient.auth.getSession();
  if (error) throw error;
  if (!data.session || data.session.user.id !== owner.userId || signal?.aborted) throw new Error('Calendar account changed.');
  // The server derives the actual family timezone; request starts on that
  // family's date supplied by the caller rather than the travelling device.
  const fromDay = dayKey(now, owner.timezone ?? 'UTC');
  const { url, init } = buildCalendarRequest(config.apiUrl, data.session.access_token, owner, fromDay, days, signal);
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(response.status === 409 ? 'Calendar account changed.' : 'Calendar unavailable. Please try again.');
  return parseCalendarReply(await response.json(), owner, { fromDay, days });
}

export type ChoreRow = {
  id: string; status: string; due_at: string | null; member_id: string;
  chores: { title: string; points: number; requires_approval: boolean } | null;
  family_members: { display_name: string } | null;
};

export async function fetchOpenChores(supabase: Db, familyId: string): Promise<ChoreRow[]> {
  const { data, error } = await supabase
    .from('chore_assignments')
    .select('id, status, due_at, member_id, chores(title, points, requires_approval), family_members(display_name)')
    .eq('family_id', familyId)
    .in('status', ['todo', 'in_progress', 'submitted'])
    .order('due_at', { ascending: true, nullsFirst: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as unknown as ChoreRow[];
}

/** Thrown when a write the screen asked for did not change a row. */
export class WriteNotAppliedError extends Error {
  constructor(message: string) { super(message); this.name = 'WriteNotAppliedError'; }
}

/**
 * Submit a chore for approval (members may not approve their own work).
 *
 * Under RLS a refused UPDATE is not an error — zero rows, no error — and
 * chore_assignments UPDATE is own-assignment-or-manager (0374), while this tab
 * lists every family chore. So the write asks for its row back and a missing
 * one is a failure, not a success. It also only moves an OPEN chore: a list
 * loaded before the chore was approved, rejected or finished elsewhere must not
 * turn that decision back into "submitted".
 */
export async function completeChore(supabase: Db, assignment: ChoreRow, familyId: string): Promise<void> {
  const { data, error } = await supabase.from('chore_assignments').update(completionPatch())
    .eq('id', assignment.id).eq('family_id', familyId).in('status', [...OPEN_CHORE_STATUSES])
    .select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new WriteNotAppliedError('That chore was already updated, or isn’t yours to mark done.');
}

export type GroceryItemRow = { id: string; name: string; quantity: string | null; is_checked: boolean; created_at: string };

export async function fetchGroceryList(supabase: Db, familyId: string): Promise<{ listId: string | null; items: GroceryItemRow[] }> {
  const { data: list, error: listError } = await supabase
    // Both archive columns: only `archived_at` is written, so asking
    // `is_archived` alone shows the phone a list the web app has archived.
    .from('grocery_lists').select('id').eq('family_id', familyId).eq('is_archived', false).is('archived_at', null)
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (listError) throw listError;
  if (!list) return { listId: null, items: [] };
  const { data, error } = await supabase
    .from('grocery_items').select('id, name, quantity, is_checked, created_at')
    .eq('list_id', list.id).order('is_checked', { ascending: true }).order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  return { listId: list.id, items: (data ?? []) as GroceryItemRow[] };
}

/** Same confirmation as completeChore: an item removed elsewhere is not "checked". */
export async function setGroceryChecked(supabase: Db, id: string, isChecked: boolean, familyId: string): Promise<void> {
  const { data, error } = await supabase.from('grocery_items').update({ is_checked: isChecked })
    .eq('id', id).eq('family_id', familyId).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new WriteNotAppliedError('That item was changed or removed on another device.');
}

export async function addGroceryItem(supabase: Db, args: { familyId: string; listId: string | null; name: string; userId: string }): Promise<string> {
  let listId = args.listId;
  if (!listId) {
    const { data, error } = await supabase.from('grocery_lists')
      .insert({ family_id: args.familyId, name: 'Groceries', created_by: args.userId }).select('id').single();
    if (error) throw error;
    listId = data.id;
  }
  const { error } = await supabase.from('grocery_items')
    .insert({ family_id: args.familyId, list_id: listId, name: args.name.trim(), created_by: args.userId });
  if (error) throw error;
  return listId;
}
