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

/**
 * Either the member's saved ticks, or the fact that we could not read them. The
 * failure carries no sentence: the page's only consumer is MomentsView, which
 * owns the copy (it needs it for the alert AND for the toast a tap would raise),
 * and the cause is logged here, where it happened.
 */
export type MomentPrepRead =
  | { ok: true; done: Record<string, string[]> }
  | { ok: false };

/**
 * The signed-in user's checked prep steps, keyed by event id.
 *
 * A read that FAILED is not "nothing is ticked yet". PostgREST RESOLVES with
 * `{ data: null, error }` rather than throwing, so dropping the error handed the
 * page an empty map byte-identical to a brand-new member's: every card read
 * `0/N`, the strip said "N need prep", and — worse than the wrong words — the
 * next tap sent that emptiness back as the event's COMPLETE done-list, so
 * `setMomentPrepDoneAction` (then `map[eventId] = doneIds`) replaced the four
 * steps the family had really ticked with the one they just tapped. Report the
 * failure so the page can say so and refuse to write over what it never read.
 */
export async function loadMomentPrep(): Promise<MomentPrepRead> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { data, error } = await supabase.from('user_preferences')
    .select('notification_prefs').eq('user_id', ctx.user.id).maybeSingle();
  if (error) {
    console.error('[dashboard/moment-prep] preferences read failed', error);
    return { ok: false };
  }
  const prefs = (data?.notification_prefs as Record<string, unknown> | null) ?? null;
  const saved = prefs?.[PREF_KEY];
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return { ok: true, done: {} };
  const out: Record<string, string[]> = {};
  for (const [eventId, ids] of Object.entries(saved as Record<string, unknown>)) {
    if (Array.isArray(ids)) out[eventId] = ids.filter((v): v is string => typeof v === 'string');
  }
  return { ok: true, done: out };
}

/**
 * Mark ONE prep step of one event done or not done (merged into
 * notification_prefs).
 *
 * The caller names the step and the state it wants — never the whole list. This
 * used to take the client's picture of the event's done-list and store it
 * wholesale (`map[eventId] = doneIds`), so any picture that was not current
 * deleted real ticks: a failed read painted every step unticked, and a
 * back/forward navigation re-mounts /dashboard/moments from Next's router cache
 * (restoreReducer reuses the cached RSC payload and does not refetch) with the
 * ticks as they stood when the page was first rendered, so the next tap sent
 * that older list back and erased every step ticked since. Merging the one step
 * into the list read HERE means a stale screen can at worst show a step wrongly;
 * it cannot delete one it never mentioned.
 */
export async function setMomentPrepDoneAction(input: { eventId: string; stepId: string; done: boolean }): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const eventId = String(input.eventId || '').trim();
  if (!eventId) return { ok: false, error: t('momentActions.missingEvent') };
  const stepId = typeof input.stepId === 'string' ? input.stepId.trim() : '';
  // `done` must be said, not inferred: a missing flag read as "not done" would
  // untick a step nobody asked to untick.
  if (!stepId || typeof input.done !== 'boolean') return { ok: false, error: t('momentActions.missingStep') };
  const supabase = await createServer();

  // Read-merge-write so we never clobber other notification_prefs keys. A read
  // that FAILED is not an empty prefs blob: the upsert below replaces the WHOLE
  // notification_prefs column, so merging into `{}` would erase App Lock, the
  // Google Calendar token and every other key this member has set. Fail closed
  // instead — the same guard Capture shortcuts and App Lock already use.
  const { data: existing, error: readError } = await supabase.from('user_preferences')
    .select('notification_prefs').eq('user_id', ctx.user.id).maybeSingle();
  if (readError) {
    console.error('[dashboard/moment-prep] preferences read failed', readError);
    return { ok: false, error: readError.message };
  }
  const prefs = (existing?.notification_prefs as Record<string, unknown> | null) ?? {};
  const map = (prefs[PREF_KEY] && typeof prefs[PREF_KEY] === 'object' && !Array.isArray(prefs[PREF_KEY]))
    ? { ...(prefs[PREF_KEY] as Record<string, unknown>) } : {};
  const saved = Array.isArray(map[eventId])
    ? (map[eventId] as unknown[]).filter((v): v is string => typeof v === 'string') : [];
  const doneIds = input.done
    ? (saved.includes(stepId) ? saved : [...saved, stepId]).slice(0, 32)
    : saved.filter((id) => id !== stepId);
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
  // A refused read is NOT "this family has no list": `lists` is null on failure
  // and `[]` when genuinely empty, and `?.[0]?.id` flattens both to undefined,
  // so falling through created a SECOND "Groceries" list and put the snacks on
  // it. The shopping module opens the oldest list, so those items land where
  // nobody shops while the toast says they were added. Fail closed — the same
  // guard lib/services/groceries ensureDefaultList and the recipes module use.
  const { data: lists, error: listLookupError } = await supabase.from('grocery_lists')
    .select('id').eq('family_id', input.familyId).eq('is_archived', false).is('archived_at', null)
    .order('created_at').limit(1);
  if (listLookupError) {
    console.error('[dashboard/moment-prep] grocery list read failed', listLookupError);
    return { ok: false, error: t('momentActions.couldNotOpenYourGroceryList') };
  }
  let listId = lists?.[0]?.id;
  if (!listId) {
    const { data: created, error: listErr } = await supabase.from('grocery_lists')
      .insert({ family_id: input.familyId, name: 'Groceries', created_by: ctx.user.id })
      .select('id').single();
    if (listErr || !created) return { ok: false, error: listErr?.message ?? 'Could not create a list' };
    listId = created.id;
  }

  // Skip items already present (unchecked) so re-tapping is idempotent. The
  // idempotence in the docstring above is THIS read, and `existing ?? []` turned
  // a failed one into "the list is empty" — so a second tap re-inserted every
  // item and still reported "Added 3", the one answer that reads exactly like
  // the first tap. There is no DB backstop either: the only unique index on
  // grocery_items is on (family_id, idempotency_key), which this insert leaves
  // null (supabase/migrations/0256_idempotency_keys.sql:47). Fail closed.
  const { data: existing, error: dedupeError } = await supabase.from('grocery_items')
    .select('name').eq('list_id', listId).eq('is_checked', false);
  if (dedupeError) {
    console.error('[dashboard/moment-prep] duplicate read failed', dedupeError);
    return { ok: false, error: t('momentActions.couldNotReadYourGroceryList') };
  }
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
