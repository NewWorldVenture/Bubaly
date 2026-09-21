// Prep-plan generation — service-callable core (no request context), shared by
// the on-demand server action and the model-refresh cron. Reads real upcoming
// signals (trips, member birthdays, expiring documents), runs the pure generator,
// and upserts plans + steps. Idempotent; preserves is_done on regeneration.
//
// EVERY DAY IN THIS FILE IS THE FAMILY'S DAY, which is why `tz` is a parameter
// rather than something this module reads off the server. It used to open with
//
//     const todayKey = now.toISOString().slice(0, 10);
//
// — the day at GREENWICH — and then spend that one key four ways:
//
//   - as the lower bound of `vacations.start_date` and `documents.expires_at`.
//     West of Greenwich that key is TOMORROW's for the last hours of every day
//     (7h in Los Angeles, 12h at Etc/GMT+12), so a trip departing today and a
//     passport expiring today were both filtered out of their own family's prep
//     as already past — the exact moment the plan matters most.
//   - as the upper bound, `now + 120 * 86_400_000` and `now + 60 * ...`. Those
//     added fixed milliseconds to an INSTANT: a local day is 23 or 25 hours
//     twice a year, so the horizon slid by an hour across a DST transition and
//     formatted as the wrong day. They are now calendar-day arithmetic on the
//     day KEY, which cannot slide.
//   - as the birthday signal's date, via `nextBirthdayDate(...).toISOString()`.
//     That built a Date from the RUNTIME's local parts and then re-expressed it
//     at Greenwich, so east of Greenwich the day walked backwards: a birthday on
//     the 5th was emitted as the 4th, and the plan's whole step ladder with it.
//   - as `generatePrepPlans`'s "today", from which every `daysUntil` and every
//     `overdue` flag is measured.
//
// CONVERTING ONE OF THOSE AND NOT THE OTHERS WOULD BE WORSE THAN LEAVING THEM
// ALONE: before, all four were Greenwich and at least agreed with each other.
// They move together here, and the one value they all come from is `todayKey`.
//
// EVERY COLUMN THIS TOUCHES IS A `date`, NOT A `timestamptz` — `vacations
// .start_date` (0070_vacations.sql:35), `documents.expires_at`
// (0002_tables.sql:349), `family_members.birthday` (0002_tables.sql:39),
// `prep_plans.target_date` and `prep_plan_steps.due_date` (0131_prep_plans.sql).
// A DATE column ALREADY holds the day on the family's wall, so it is bounded
// and written with a bare day KEY and never with an instant. Stapling a zone
// (or a `T00:00:00Z`) onto one of these would MOVE it, which is the same error
// one day out in the other direction.

import type { SupabaseClient } from '@supabase/supabase-js';
import { settleAll } from '@/lib/supabase/settle';
import type { Database } from '@/lib/database.types';
import { generatePrepPlans, type HorizonSignal } from './prep';
import { nextBirthdayDayKey } from '@/lib/moments/birthdays';
import { addDaysToDayKey, dayKeyInTz } from '@/lib/services/scope';

type DB = SupabaseClient<Database>;

export type PrepGenerationResult = { ok: boolean; error?: string; plans: number };

/**
 * `tz` is the family's IANA zone and is REQUIRED — not optional with a 'UTC'
 * default. A defaulted zone is how a caller keeps compiling while it keeps
 * being wrong; required, the typechecker names every call site. Both callers
 * already hold the family row this comes from (`families.timezone`, which 0002
 * defaults to 'UTC'), so neither needs a second read.
 */
export async function runPrepGeneration(
  sb: DB,
  familyId: string,
  createdBy: string | null,
  tz: string,
  now: Date = new Date(),
): Promise<PrepGenerationResult> {
  // The one day key the whole function is measured from. Horizons step whole
  // CALENDAR days off it rather than adding N x 86_400_000 to an instant.
  const todayKey = dayKeyInTz(now, tz);
  const in120 = addDaysToDayKey(todayKey, 120);
  const in60 = addDaysToDayKey(todayKey, 60);

  const [trips, members, docs] = await settleAll([
    sb.from('vacations').select('id, title, start_date').eq('family_id', familyId).gte('start_date', todayKey).lte('start_date', in120),
    sb.from('family_members').select('id, display_name, birthday').eq('family_id', familyId).not('birthday', 'is', null),
    sb.from('documents').select('id, title, expires_at').eq('family_id', familyId).not('expires_at', 'is', null).gte('expires_at', todayKey).lte('expires_at', in60),
  ]);

  const firstErr = [trips, members, docs].find((r) => r.error)?.error;
  if (firstErr) return { ok: false, error: firstErr.message, plans: 0 };

  const signals: HorizonSignal[] = [];
  for (const t of trips.data ?? []) if (t.start_date) signals.push({ id: t.id, kind: 'trip', title: t.title ?? 'Trip', date: t.start_date });
  for (const m of members.data ?? []) {
    // Day key in, day key out. `family_members.birthday` is a DATE column, the
    // answer is a DATE, and the "next occurrence on or after today" question is
    // asked against the FAMILY's today — never the runtime's, and never through
    // an instant that would have to be re-expressed as a day afterwards.
    const next = m.birthday ? nextBirthdayDayKey(m.birthday, todayKey) : null;
    if (next) signals.push({ id: m.id, kind: 'birthday', title: `${m.display_name}'s Birthday`, date: next });
  }
  for (const d of docs.data ?? []) if (d.expires_at) signals.push({ id: d.id, kind: 'doc_expiry', title: d.title ?? 'Document', date: d.expires_at });

  const plans = generatePrepPlans(signals, todayKey);
  if (plans.length === 0) return { ok: true, plans: 0 };

  const planRows = plans.map((p) => ({
    family_id: familyId, signal_kind: p.kind, signal_id: p.signalId,
    title: p.title, target_date: p.targetDate, urgency: p.urgency, status: 'active', created_by: createdBy,
  }));
  const { error: planErr } = await sb.from('prep_plans').upsert(planRows, { onConflict: 'family_id,signal_kind,signal_id' });
  if (planErr) return { ok: false, error: planErr.message, plans: 0 };

  const { data: idRows, error: readErr } = await sb.from('prep_plans').select('id, signal_kind, signal_id').eq('family_id', familyId);
  if (readErr) return { ok: false, error: readErr.message, plans: 0 };
  const idByKey = new Map<string, string>();
  for (const r of idRows ?? []) idByKey.set(`${r.signal_kind}:${r.signal_id}`, r.id);

  const stepRows = plans.flatMap((p) => {
    const planId = idByKey.get(`${p.kind}:${p.signalId}`);
    if (!planId) return [];
    return p.steps.map((s, i) => ({
      family_id: familyId, plan_id: planId, label: s.label, href: s.href, due_date: s.dueDate, lead_days: s.leadDays, sort_order: i,
    }));
  });
  if (stepRows.length) {
    const { error: stepErr } = await sb.from('prep_plan_steps').upsert(stepRows, { onConflict: 'family_id,plan_id,label', ignoreDuplicates: true });
    if (stepErr) return { ok: false, error: stepErr.message, plans: 0 };
  }

  return { ok: true, plans: plans.length };
}
