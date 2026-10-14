// Prep-plan generation — service-callable core (no request context), shared by
// the on-demand server action and the model-refresh cron. Reads real upcoming
// signals (trips, member birthdays, expiring documents), runs the pure generator,
// and upserts plans + steps. Idempotent; preserves is_done, and preserves what
// the family decided about a plan (dismissed/done) on regeneration.
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
import { generatePrepPlans, type HorizonSignal, type PrepPlan, type SignalKind } from './prep';
import { nextBirthdayDayKey } from '@/lib/moments/birthdays';
import { addDaysToDayKey, dayKeyInTz } from '@/lib/services/scope';
import { describeActionError } from '@/lib/supabase/errors';
import { isSensitiveDocument } from '@/lib/documents/sensitivity';

type DB = SupabaseClient<Database>;

/**
 * What a sensitive document is called on a prep plan: the plan reads "Renew:
 * Private document". Stored, like every plan title, in the source language.
 */
export const PRIVATE_DOCUMENT_TITLE = 'Private document';

export type PrepGenerationResult = { ok: boolean; error?: string; plans: number };

/** Signals that come round again under the same source row: a member's birthday, a document's expiry. */
const RECURRING_KINDS: ReadonlySet<SignalKind | string> = new Set<SignalKind>(['birthday', 'doc_expiry']);

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
    // A member removed from the household (is_active = false, a NOT NULL
    // column) is not planned a birthday for, every year, for good.
    sb.from('family_members').select('id, display_name, birthday').eq('family_id', familyId).neq('is_active', false).not('birthday', 'is', null),
    sb.from('documents').select('id, title, expires_at, is_secure, category').eq('family_id', familyId).not('expires_at', 'is', null).gte('expires_at', todayKey).lte('expires_at', in60),
  ]);

  const firstErr = [trips, members, docs].find((r) => r.error)?.error;
  if (firstErr) return { ok: false, error: describeActionError(firstErr), plans: 0 };

  // A PLAN WHOSE DAY HAS PASSED IS OVER. Nothing ever retired one: a trip that
  // happened, or a vacation row deleted before it, left its plan 'active' with
  // its unticked steps, and Readiness counted them as overdue — a blocker, for
  // good — and as plans in progress. A birthday or a document passing its day
  // is closed here too, and opened again below for its next occurrence.
  const { error: retireErr } = await sb.from('prep_plans').update({ status: 'done' })
    .eq('family_id', familyId).eq('status', 'active').lt('target_date', todayKey).select('id');
  if (retireErr) return { ok: false, error: describeActionError(retireErr), plans: 0 };

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
  // A SENSITIVE DOCUMENT'S TITLE STAYS WHERE ITS READERS ARE. The cron reads
  // with the service client and a manager's click with a session that sees the
  // Secure Vault, but `prep_plans` reads with is_family_member (0131) for every
  // role, guests included, and /dashboard/prep-plans prints the title. So a
  // Secure Vault document, or one whose category is identity, legal, medical
  // or money (`isSensitiveDocument`, the rule documents_select applies in
  // 0266/0312), is planned under a title that names nothing. Emitted rather
  // than skipped: the upsert below overwrites the real title an earlier run
  // wrote, and the rename after the `decided` read reaches the plans the family
  // dismissed.
  const sensitiveDocIds: string[] = [];
  for (const d of docs.data ?? []) {
    if (!d.expires_at) continue;
    const sensitive = isSensitiveDocument(d);
    if (sensitive) sensitiveDocIds.push(d.id);
    signals.push({ id: d.id, kind: 'doc_expiry', title: sensitive ? PRIVATE_DOCUMENT_TITLE : (d.title ?? 'Document'), date: d.expires_at });
  }

  const plans = generatePrepPlans(signals, todayKey);
  if (plans.length === 0) return { ok: true, plans: 0 };

  // WHAT THE FAMILY DECIDED ABOUT A PLAN IS NOT THE GENERATOR'S TO UNDO.
  // `generatePrepPlans` is pure over the current signals and never looks at the
  // rows already on the table, so every plan whose signal is still in the
  // horizon is re-emitted on every run. Writing a hardcoded `status: 'active'`
  // back through the upsert therefore RE-ACTIVATED a plan the family had
  // dismissed with the X on /dashboard/prep-plans — their only way to hide one,
  // since there is no un-dismiss — on the next "Generate plans" click and,
  // with nobody watching, on every model-refresh cron sweep.
  //
  // Same shape as lib/intelligence/hard-signals-server.ts: read what the family
  // already decided, leave those rows out of the write entirely, and omit
  // `status` from the payload so a dismissal landing BETWEEN this read and the
  // upsert is not reset either. New rows take the schema's 'active' default
  // (0131_prep_plans.sql), which is the only place that value belongs.
  //
  // THE READ FAILS CLOSED. PostgREST answers a refusal with
  // `{ data: null, error }`, so a dropped error reads as "this family has
  // dismissed nothing" and the very next write un-dismisses everything. A
  // generation that cannot see the existing rows does not write.
  //
  // Both reads here ask only for THIS run's signals. Plans are never deleted
  // (one accrues per trip and per expiring document), so reading every plan the
  // family ever had eventually passed PostgREST's `db-max-rows` and answered a
  // prefix: a dismissal outside it was re-activated, and a new plan outside it
  // found no id below and lost its step ladder while the run reported it
  // generated (SRV-001 census, SRV-C07).
  //
  // A DECISION BELONGS TO THE OCCURRENCE IT WAS MADE ON. A birthday and an
  // expiring document recur under the same source row (one plan per member,
  // one per document, unique on the signal), so a dismissal of Mia's 2026
  // birthday hid every birthday she would ever have, and a plan left active
  // rolled into 2027 with 2026's ticked steps and due dates. For those kinds a
  // plan whose stored date has PASSED is a NEW occurrence: it is opened again
  // with a fresh step ladder, whatever was decided about the last.
  //
  // Only a date that has passed. A birthday or an expiry date corrected
  // before it came (the 10th was really the 12th) is the same occurrence on
  // another day: it keeps what the family decided and ticked, and moves —
  // the `moved` ladder below for a plan still active, the date-only update
  // after the `decided` read for one dismissed or done. Treated as new, a
  // date edit re-opened a dismissed plan and cleared every ticked step.
  const signalIds = [...new Set(plans.map((p) => p.signalId))];
  const { data: existing, error: existingErr } = await sb.from('prep_plans')
    .select('id, signal_kind, signal_id, status, target_date').eq('family_id', familyId).in('signal_id', signalIds);
  if (existingErr) return { ok: false, error: describeActionError(existingErr), plans: 0 };
  const keyOf = (p: { kind: string; signalId: string }) => `${p.kind}:${p.signalId}`;
  const existingByKey = new Map((existing ?? []).map((r) => [`${r.signal_kind}:${r.signal_id}`, r]));
  const nextOccurrence = new Set(plans
    .filter((p) => {
      const row = existingByKey.get(keyOf(p));
      return RECURRING_KINDS.has(p.kind) && !!row && row.target_date !== p.targetDate && row.target_date < todayKey;
    })
    .map(keyOf));
  const decided = new Set((existing ?? [])
    .map((r) => `${r.signal_kind}:${r.signal_id}`)
    .filter((key) => existingByKey.get(key)!.status !== 'active' && !nextOccurrence.has(key)));

  // A dismissed (or done) birthday or document plan whose date was corrected
  // keeps that decision and takes the new date. Left on the old one, the old
  // date passing would read as the occurrence being over, and the next run
  // would open the corrected one again — the dismissal undone a few days
  // late. Keyed on the date this run read, so a concurrent run's change is
  // not overwritten.
  for (const p of plans) {
    const row = existingByKey.get(keyOf(p));
    if (!row || !RECURRING_KINDS.has(p.kind) || !decided.has(keyOf(p)) || row.target_date === p.targetDate) continue;
    const { error: moveErr } = await sb.from('prep_plans').update({ target_date: p.targetDate, urgency: p.urgency })
      .eq('id', row.id).eq('family_id', familyId).eq('target_date', row.target_date).select('id');
    if (moveErr) return { ok: false, error: describeActionError(moveErr), plans: 0 };
  }

  // A plan the family dismissed is left out of the write below, so a real
  // title an earlier run gave a sensitive document would stay on that row,
  // readable by every member through PostgREST. Rename just the title; the
  // family's decision (`status`) is not touched.
  const privateTitle = plans.find((p) => p.kind === 'doc_expiry' && sensitiveDocIds.includes(p.signalId))?.title;
  const decidedSensitive = (existing ?? [])
    .filter((r) => r.status !== 'active' && r.signal_kind === 'doc_expiry' && sensitiveDocIds.includes(r.signal_id))
    .map((r) => r.signal_id);
  if (privateTitle && decidedSensitive.length) {
    const { error: scrubErr } = await sb.from('prep_plans').update({ title: privateTitle })
      .eq('family_id', familyId).eq('signal_kind', 'doc_expiry').in('signal_id', decidedSensitive).select('id');
    if (scrubErr) return { ok: false, error: describeActionError(scrubErr), plans: 0 };
  }

  const fresh = plans.filter((p) => !decided.has(`${p.kind}:${p.signalId}`));
  if (fresh.length === 0) return { ok: true, plans: 0 };

  // A next occurrence is opened again from the row's OWN previous date, so a
  // concurrent run (the cron beside a click) that already opened it changes
  // nothing here and does not clear the steps the family has ticked since.
  const reopened = new Set<string>();
  for (const p of fresh.filter((plan) => nextOccurrence.has(keyOf(plan)))) {
    const row = existingByKey.get(keyOf(p))!;
    const { data: opened, error: openErr } = await sb.from('prep_plans')
      .update({ status: 'active', title: p.title, target_date: p.targetDate, urgency: p.urgency })
      .eq('id', row.id).eq('family_id', familyId).eq('target_date', row.target_date).select('id');
    if (openErr) return { ok: false, error: describeActionError(openErr), plans: 0 };
    if (opened?.length) reopened.add(keyOf(p));
  }

  const planRows = fresh.filter((p) => !nextOccurrence.has(keyOf(p))).map((p) => ({
    family_id: familyId, signal_kind: p.kind, signal_id: p.signalId,
    title: p.title, target_date: p.targetDate, urgency: p.urgency, created_by: createdBy,
  }));
  if (planRows.length) {
    const { error: planErr } = await sb.from('prep_plans').upsert(planRows, { onConflict: 'family_id,signal_kind,signal_id' });
    if (planErr) return { ok: false, error: describeActionError(planErr), plans: 0 };
  }

  const { data: idRows, error: readErr } = await sb.from('prep_plans').select('id, signal_kind, signal_id')
    .eq('family_id', familyId).in('signal_id', fresh.map((p) => p.signalId));
  if (readErr) return { ok: false, error: describeActionError(readErr), plans: 0 };
  const idByKey = new Map<string, string>();
  for (const r of idRows ?? []) idByKey.set(`${r.signal_kind}:${r.signal_id}`, r.id);

  // A plan this run just wrote that cannot be found again is not "generated":
  // it would be a card with an empty checklist. Say so instead.
  if (fresh.some((p) => !idByKey.has(`${p.kind}:${p.signalId}`))) {
    return { ok: false, error: 'Bubaly could not finish setting up those plans. Try again.', plans: 0 };
  }
  const stepsOf = (group: PrepPlan[]) => group.flatMap((p) => {
    const planId = idByKey.get(`${p.kind}:${p.signalId}`);
    if (!planId) return [];
    return p.steps.map((s, i) => ({
      family_id: familyId, plan_id: planId, label: s.label, href: s.href, due_date: s.dueDate, lead_days: s.leadDays, sort_order: i,
    }));
  });
  // Three kinds of plan, three ways to write a step ladder:
  //   - a next occurrence starts its ladder again: every step undone, due
  //     dates counted from the new date;
  //   - a plan whose date moved (a rescheduled trip, a birthday or expiry
  //     corrected before it came) keeps what was ticked and takes the new due
  //     dates;
  //   - any other plan only gains the steps it lacks, as before.
  const moved = fresh.filter((p) => !reopened.has(keyOf(p)) && existingByKey.has(keyOf(p))
    && existingByKey.get(keyOf(p))!.target_date !== p.targetDate);
  const resetRows = stepsOf(fresh.filter((p) => reopened.has(keyOf(p)))).map((row) => ({ ...row, is_done: false }));
  const movedRows = stepsOf(moved);
  const stepRows = stepsOf(fresh.filter((p) => !reopened.has(keyOf(p)) && !moved.includes(p)));
  for (const rows of [resetRows, movedRows]) {
    if (!rows.length) continue;
    const { error: stepErr } = await sb.from('prep_plan_steps').upsert(rows, { onConflict: 'family_id,plan_id,label' });
    if (stepErr) return { ok: false, error: describeActionError(stepErr), plans: 0 };
  }
  if (stepRows.length) {
    const { error: stepErr } = await sb.from('prep_plan_steps').upsert(stepRows, { onConflict: 'family_id,plan_id,label', ignoreDuplicates: true });
    if (stepErr) return { ok: false, error: describeActionError(stepErr), plans: 0 };
  }

  return { ok: true, plans: fresh.length };
}
