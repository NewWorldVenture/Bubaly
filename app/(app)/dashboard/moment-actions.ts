'use server';

// Server actions for the anticipatory "Moment prep" card. Checked prep steps are
// remembered per-event inside the core user_preferences.notification_prefs jsonb
// (same read-merge-write pattern as Capture shortcuts / sidebar nav — no
// migration, own-row RLS). One-tap steps that set a reminder create a real
// `reminders` row (family-scoped RLS), linked back to the source event.
import { requireUserContext } from '@/lib/supabase/auth';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';

const PREF_KEY = 'momentPrep';

type Result = { ok: boolean; error?: string };

/** The signed-in user's checked prep steps, keyed by event id. */
export async function loadMomentPrep(): Promise<Record<string, string[]>> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { data } = await supabase.from('user_preferences')
    .select('notification_prefs').eq('user_id', ctx.user.id).maybeSingle();
  const prefs = (data?.notification_prefs as Record<string, unknown> | null) ?? null;
  const saved = prefs?.[PREF_KEY];
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
  const out: Record<string, string[]> = {};
  for (const [eventId, ids] of Object.entries(saved as Record<string, unknown>)) {
    if (Array.isArray(ids)) out[eventId] = ids.filter((v): v is string => typeof v === 'string');
  }
  return out;
}

/** Persist the checked prep-step ids for one event (merged into notification_prefs). */
export async function setMomentPrepDoneAction(input: { eventId: string; doneIds: string[] }): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const eventId = String(input.eventId || '').trim();
  if (!eventId) return { ok: false, error: t('momentActions.missingEvent') };
  const doneIds = Array.from(new Set((input.doneIds ?? []).filter((v) => typeof v === 'string' && v.trim()))).slice(0, 32);
  const supabase = await createServer();

  const { data: existing } = await supabase.from('user_preferences')
    .select('notification_prefs').eq('user_id', ctx.user.id).maybeSingle();
  const prefs = (existing?.notification_prefs as Record<string, unknown> | null) ?? {};
  const map = (prefs[PREF_KEY] && typeof prefs[PREF_KEY] === 'object' && !Array.isArray(prefs[PREF_KEY]))
    ? { ...(prefs[PREF_KEY] as Record<string, unknown>) } : {};
  if (doneIds.length === 0) delete map[eventId]; else map[eventId] = doneIds;
  const merged = { ...prefs, [PREF_KEY]: map };

  const { error } = await supabase.from('user_preferences')
    .upsert({ user_id: ctx.user.id, notification_prefs: merged as never }, { onConflict: 'user_id' });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Add inferred shopping items (e.g. team snacks) straight to the family's active
 *  grocery list — creating the list if needed and skipping items already on it
 *  (case-insensitive), so tapping twice never duplicates. Returns how many were added. */
export async function addMomentGroceryAction(input: {
  familyId: string; items: string[];
}): Promise<Result & { added?: number; ids?: string[] }> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const names = Array.from(new Set((input.items ?? [])
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean))).slice(0, 20);
  if (names.length === 0) return { ok: false, error: t('momentActions.nothingToAdd') };
  const supabase = await createServer();

  // Resolve the active (non-archived) list, or create "Groceries" — same rule the
  // Grocery module uses, so the moment's items land exactly where the family shops.
  // Both archive columns: only `archived_at` is ever written (the shopping
  // module stamps it), so `is_archived` alone calls an archived list active.
  const { data: lists } = await supabase.from('grocery_lists')
    .select('id').eq('family_id', input.familyId).eq('is_archived', false).is('archived_at', null)
    .order('created_at').limit(1);
  let listId = lists?.[0]?.id;
  if (!listId) {
    const { data: created, error: listErr } = await supabase.from('grocery_lists')
      .insert({ family_id: input.familyId, name: 'Groceries', created_by: ctx.user.id })
      .select('id').single();
    if (listErr || !created) return { ok: false, error: listErr?.message ?? 'Could not create a list' };
    listId = created.id;
  }

  // Skip items already present (unchecked) so re-tapping is idempotent.
  const { data: existing } = await supabase.from('grocery_items')
    .select('name').eq('list_id', listId).eq('is_checked', false);
  const have = new Set((existing ?? []).map((r) => r.name.trim().toLowerCase()));
  const toAdd = names.filter((n) => !have.has(n.toLowerCase()));
  if (toAdd.length === 0) return { ok: true, added: 0, ids: [] };

  const { data: inserted, error } = await supabase.from('grocery_items').insert(
    toAdd.map((name) => ({ family_id: input.familyId, list_id: listId as string, name, created_by: ctx.user.id })),
  ).select('id');
  if (error) return { ok: false, error: error.message };
  return { ok: true, added: toAdd.length, ids: (inserted ?? []).map((r) => r.id) };
}

/** Undo an "add to grocery" — deletes exactly the rows the moment just inserted. */
export async function removeMomentGroceryAction(input: { ids: string[] }): Promise<Result> {
  await requireUserContext();
  const ids = (input.ids ?? []).filter((v) => typeof v === 'string' && v);
  if (ids.length === 0) return { ok: true };
  const supabase = await createServer();
  // RLS scopes the delete to the caller's family; ids came straight from the insert.
  const { error } = await supabase.from('grocery_items').delete().in('id', ids);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Turn a prep step into a real reminder (e.g. "Leave for Soccer game" at the leave-by time). */
export async function createMomentReminderAction(input: {
  familyId: string; title: string; remindAtISO: string; eventId: string;
}): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const title = String(input.title || '').trim();
  const remindAt = new Date(input.remindAtISO);
  if (!title) return { ok: false, error: t('momentActions.missingTitle') };
  if (Number.isNaN(remindAt.getTime())) return { ok: false, error: t('momentActions.invalidTime') };
  const supabase = await createServer();

  const { error } = await supabase.from('reminders').insert({
    family_id: input.familyId,
    title,
    remind_at: remindAt.toISOString(),
    related_type: 'calendar_event',
    related_id: input.eventId || null,
    created_by: ctx.user.id,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
