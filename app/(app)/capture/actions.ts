'use server';

import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';

type Result = { ok: true } | { ok: false; error: string };

export type FileResult =
  | { ok: true; filed: boolean; label: string; url: string }
  | { ok: false; error: string };

/**
 * File a captured note straight into the right place — no extra taps. Supports
 * grocery items, to-dos, and notes (find-or-create the default list where
 * needed). RLS scopes every write to the caller's family.
 */
export async function fileCaptureAction(input: { text: string; key: string; title?: string | null; whenISO?: string | null }): Promise<FileResult> {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const userId = ctx.user.id;
  const supabase = await createServer();
  const text = input.text.trim().slice(0, 500);
  if (!text) return { ok: false, error: 'Nothing to file' };
  const title = (input.title?.trim() || text).slice(0, 200);
  const whenISO = input.whenISO && !Number.isNaN(new Date(input.whenISO).getTime())
    ? new Date(input.whenISO).toISOString() : null;

  try {
    if (input.key === 'calendar') {
      if (!whenISO) return { ok: true, filed: false, label: 'Calendar', url: '/dashboard/calendar' };
      const { error } = await supabase
        .from('calendar_events').insert({ family_id: familyId, title, starts_at: whenISO, all_day: false, created_by: userId });
      if (error) return { ok: false, error: error.message };
      return { ok: true, filed: true, label: 'Calendar', url: '/dashboard/calendar' };
    }

    if (input.key === 'reminders') {
      const { error } = await supabase
        .from('family_reminders').insert({ family_id: familyId, created_by: userId, title, kind: 'time', remind_at: whenISO });
      if (error) return { ok: false, error: error.message };
      return { ok: true, filed: true, label: 'Reminders', url: '/dashboard/reminders' };
    }

    if (input.key === 'grocery') {
      const { data: existing } = await supabase
        .from('grocery_lists').select('id')
        .eq('family_id', familyId).eq('is_archived', false)
        .order('created_at', { ascending: true }).limit(1).maybeSingle();
      let listId = existing?.id;
      if (!listId) {
        const { data: created, error } = await supabase
          .from('grocery_lists').insert({ family_id: familyId, name: 'Groceries', created_by: userId }).select('id').single();
        if (error || !created) return { ok: false, error: error?.message ?? 'Could not create list' };
        listId = created.id;
      }
      const { error } = await supabase
        .from('grocery_items').insert({ family_id: familyId, list_id: listId, name: text, created_by: userId });
      if (error) return { ok: false, error: error.message };
      return { ok: true, filed: true, label: 'Grocery List', url: '/dashboard/grocery' };
    }

    if (input.key === 'todos') {
      const { data: existing } = await supabase
        .from('todo_lists').select('id')
        .eq('family_id', familyId).is('archived_at', null)
        .order('created_at', { ascending: true }).limit(1).maybeSingle();
      let listId = existing?.id;
      if (!listId) {
        const { data: created, error } = await supabase
          .from('todo_lists').insert({ family_id: familyId, name: 'To-Do', created_by: userId }).select('id').single();
        if (error || !created) return { ok: false, error: error?.message ?? 'Could not create list' };
        listId = created.id;
      }
      const { error } = await supabase
        .from('todo_items').insert({ family_id: familyId, list_id: listId, title: text.slice(0, 200), priority: 'medium' });
      if (error) return { ok: false, error: error.message };
      return { ok: true, filed: true, label: 'To-Do List', url: '/dashboard/todos' };
    }

    if (input.key === 'notes') {
      const title = text.split('\n')[0].slice(0, 120);
      const body = text.length > title.length ? text : '';
      const { error } = await supabase
        .from('notes').insert({ family_id: familyId, created_by: userId, title, body });
      if (error) return { ok: false, error: error.message };
      return { ok: true, filed: true, label: 'Notes', url: '/dashboard/notes' };
    }

    return { ok: true, filed: false, label: '', url: '' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not file' };
  }
}

/**
 * Persist the user's customized Capture quick-jump buttons (ordered route keys)
 * to user_preferences.ui_prefs so they sync across devices. Merges into the
 * existing ui_prefs bag so other UI prefs are preserved. Resilient: returns a
 * soft error if the column isn't present yet (pre-migration), letting the client
 * keep its localStorage cache rather than throwing.
 */
export async function saveCaptureRoutesAction(keys: string[]): Promise<Result> {
  const ctx = await requireUserContext();
  const userId = ctx.user.id;
  const supabase = await createServer();

  try {
    const clean = keys.filter((k) => typeof k === 'string').slice(0, 24);
    const { data: existing } = await supabase
      .from('user_preferences')
      .select('ui_prefs')
      .eq('user_id', userId)
      .maybeSingle();

    const prev = (existing?.ui_prefs && typeof existing.ui_prefs === 'object' ? existing.ui_prefs : {}) as Record<string, unknown>;
    const ui_prefs = { ...prev, captureQuickRoutes: clean };

    const { error } = await supabase
      .from('user_preferences')
      .upsert({ user_id: userId, ui_prefs }, { onConflict: 'user_id' });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not save' };
  }
}
