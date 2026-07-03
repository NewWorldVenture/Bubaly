'use server';

// Server actions for the anticipatory "Moment prep" card. Checked prep steps are
// remembered per-event inside the core user_preferences.notification_prefs jsonb
// (same read-merge-write pattern as Capture shortcuts / sidebar nav — no
// migration, own-row RLS). One-tap steps that set a reminder create a real
// `reminders` row (family-scoped RLS), linked back to the source event.
import { requireUserContext } from '@/lib/supabase/auth';
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
  const ctx = await requireUserContext();
  const eventId = String(input.eventId || '').trim();
  if (!eventId) return { ok: false, error: 'Missing event' };
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

/** Turn a prep step into a real reminder (e.g. "Leave for Soccer game" at the leave-by time). */
export async function createMomentReminderAction(input: {
  familyId: string; title: string; remindAtISO: string; eventId: string;
}): Promise<Result> {
  const ctx = await requireUserContext();
  const title = String(input.title || '').trim();
  const remindAt = new Date(input.remindAtISO);
  if (!title) return { ok: false, error: 'Missing title' };
  if (Number.isNaN(remindAt.getTime())) return { ok: false, error: 'Invalid time' };
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
