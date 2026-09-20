import type { Db } from './db';
import { completionPatch } from './chores-core';
import { shiftDays } from './format';

export type EventRow = {
  id: string; title: string; starts_at: string; ends_at: string | null; all_day: boolean;
  location: string | null; category: string;
};

export async function fetchUpcomingEvents(supabase: Db, familyId: string, days = 14, now = new Date()): Promise<EventRow[]> {
  const { data, error } = await supabase
    .from('calendar_events')
    .select('id, title, starts_at, ends_at, all_day, location, category')
    .eq('family_id', familyId)
    .gte('starts_at', shiftDays(now, -0.5).toISOString())
    .lte('starts_at', shiftDays(now, days).toISOString())
    .order('starts_at', { ascending: true })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as EventRow[];
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

/** Submit a chore for approval (members may not approve their own work). */
export async function completeChore(supabase: Db, assignment: ChoreRow): Promise<void> {
  const { error } = await supabase.from('chore_assignments').update(completionPatch()).eq('id', assignment.id);
  if (error) throw error;
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

export async function setGroceryChecked(supabase: Db, id: string, isChecked: boolean): Promise<void> {
  const { error } = await supabase.from('grocery_items').update({ is_checked: isChecked }).eq('id', id);
  if (error) throw error;
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
