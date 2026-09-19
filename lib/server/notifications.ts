// "Who Needs to Know" — the smart-notification engine.
// Scans the next 24–48h of real family data and creates per-member notification
// rows (mapped to the affected member's user account), deduplicating against
// notifications already created for the same item. Deterministic by design:
// notifications must be trustworthy, so this is rule-based, not AI-generated.
import type { SupabaseClient } from '@supabase/supabase-js';
import { settle, settleAll, describeReadError } from '@/lib/supabase/settle';
import type { Database, NotificationType } from '@/lib/database.types';
import { renewalReminders, opportunityReminders } from '@/lib/notifications/deadline-reminders';
import { approvalReminders, type ApprovalInput } from '@/lib/notifications/approval-reminders';
import { detectConflicts, type ConflictEvent } from '@/lib/home/conflicts';
import { medicationDueReminders } from '@/lib/notifications/medication-reminders';
import { upcomingRelationship, formatCountdown, milestoneLabel, type RelDate } from '@/lib/relationship/dates';
import { dueFamilyReminderNotices, reminderFetchHorizonIso, type FamilyReminderRow } from '@/lib/reminders/notify';
import { onThisDayNotice } from '@/lib/memories/on-this-day';
import { imminentMomentNotices } from '@/lib/moments/notify';
import { deliveryTimeFor } from '@/lib/services/notifications';
import { addDaysToDayKey, dayKeyInTz, systemScopeForFamily, zonedDayBoundsMs } from '@/lib/services/scope';
import { readInChunks } from '@/lib/supabase/chunked-in';

type DB = SupabaseClient<Database>;

type Candidate = {
  type: NotificationType;
  title: string;
  body: string | null;
  related_type: string;
  related_id: string;
  user_id: string | null; // null = whole family
};

const HOUR = 3600_000;

// "today", "tomorrow" and the clock time IN THE FAMILY'S ZONE. This used to
// compare `toDateString()` against the SERVER's midnight, and render the time
// with no timeZone at all — so on a UTC host a Pacific family was told an 8pm
// event was "tomorrow" (20:00 PT is 03:00 UTC the next day) and shown the wrong
// hour beside it. The rest of this file already resolves `families.timezone`
// for exactly this reason — see the medication-window note above — and this was
// the one place the value was not threaded through.
function timeLabel(iso: string, tz: string, allDay = false): string {
  const d = new Date(iso);
  const dayKey = dayKeyInTz(d, tz);
  const todayKey = dayKeyInTz(new Date(), tz);
  const day = dayKey === todayKey
    ? 'today'
    : dayKey === addDaysToDayKey(todayKey, 1)
      ? 'tomorrow'
      : d.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz });
  if (allDay) return day;
  return `${day} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })}`;
}

export async function generateFamilyNotifications(supabase: DB, familyId: string): Promise<number> {
  const now = new Date();
  const in24 = new Date(now.getTime() + 24 * HOUR).toISOString();
  const in48 = new Date(now.getTime() + 48 * HOUR).toISOString();
  const in14d = new Date(now.getTime() + 14 * 24 * HOUR).toISOString();
  const nowIso = now.toISOString();

  // "Today" has to be the family's day, and for one reader here that is not a
  // nicety. `todayStartIso` bounds the doses already logged today, and the
  // medication reminder asks "has this dose been taken yet?" against it. Read in
  // UTC it starts at 17:00 local in California — so the morning dose looks
  // untaken every evening and the family is reminded again — and in Tokyo it
  // starts at 09:00 the PREVIOUS local day, so yesterday's dose is mistaken for
  // today's and the reminder never fires. A missed medication reminder is the
  // worse of the two, and neither is acceptable.
  // ...which is why the ERROR here is not dropped. This read used to be
  // `const { data: familyRow }`, so a failed read fell through to exactly the
  // `'UTC'` the paragraph above spends ten lines explaining is unacceptable —
  // silently, and most damagingly for the medication reminder that then never
  // fires. Throwing instead skips this family for this tick: all three callers
  // wrap each family in try/catch and count `generationFailures`, so the family
  // is retried next tick and a broken tick still reads differently from a quiet
  // one. Late is recoverable; a dose reminder that never fires is not.
  const { data: familyRow, error: familyZoneError } = await settle(
    supabase.from('families').select('timezone').eq('id', familyId).maybeSingle());
  if (familyZoneError) {
    throw new Error(`Could not read the family timezone for ${familyId}: ${describeReadError(familyZoneError)}`);
  }
  // A family row with no zone set is a different thing from one we could not
  // read, and keeps the long-standing default.
  const tz = familyRow?.timezone || 'UTC';
  const todayKey = dayKeyInTz(now, tz);
  const todayStartIso = new Date(zonedDayBoundsMs(todayKey, tz).start).toISOString();

  // These two only bound 90- and 7-day windows, where a day either way changes
  // nothing; they use the same key for consistency rather than out of need.
  const renewalMaxKey = addDaysToDayKey(todayKey, 90);
  const signupMaxKey = addDaysToDayKey(todayKey, 7);

  const sourceResults = await settleAll([
    supabase.from('family_members').select('id, user_id, display_name, role, birthday').eq('family_id', familyId).eq('is_active', true),
    supabase.from('calendar_events').select('id, title, starts_at, all_day, location, assignee_id').eq('family_id', familyId).gte('starts_at', nowIso).lte('starts_at', in48),
    supabase.from('chore_assignments').select('id, due_at, member_id, chore_id, status').eq('family_id', familyId).in('status', ['todo', 'in_progress']).not('due_at', 'is', null).lte('due_at', in24).gte('due_at', nowIso),
    supabase.from('school_events').select('id, title, starts_at, member_id, event_type').eq('family_id', familyId).gte('starts_at', nowIso).lte('starts_at', in48),
    supabase.from('sports_events').select('id, title, starts_at, member_id, sport, location').eq('family_id', familyId).gte('starts_at', nowIso).lte('starts_at', in48),
    supabase.from('reminders').select('id, title, remind_at, member_id, is_done').eq('family_id', familyId).eq('is_done', false).gte('remind_at', nowIso).lte('remind_at', in24),
    supabase.from('documents').select('id, title, expires_at').eq('family_id', familyId).not('expires_at', 'is', null).gte('expires_at', nowIso).lte('expires_at', in14d),
    // Renewals within ~90d (per-item reminder window applied in code) and open signups within 7d.
    supabase.from('renewals').select('id, title, expires_at, reminder_days, status').eq('family_id', familyId).eq('status', 'active').gte('expires_at', todayKey).lte('expires_at', renewalMaxKey),
    supabase.from('opportunities').select('id, title, deadline, status').eq('family_id', familyId).in('status', ['interested', 'waitlisted']).not('deadline', 'is', null).gte('deadline', todayKey).lte('deadline', signupMaxKey),
    // Active meds + their schedules + today's logged doses → "dose due today" reminders.
    supabase.from('medications').select('id, name, dosage, member_id, is_active').eq('family_id', familyId).eq('is_active', true),
    supabase.from('medication_schedules').select('id, medication_id, time_of_day, days_of_week, starts_on, ends_on').eq('family_id', familyId),
    supabase.from('medication_doses').select('schedule_id, scheduled_for, status').eq('family_id', familyId).gte('scheduled_for', todayStartIso),
    // Pending money approvals → a "decision is waiting on you" ping for parents.
    supabase.from('parent_approvals').select('id, kind, amount_cents, created_at').eq('family_id', familyId).eq('status', 'pending').limit(50),
  ]);
  // Degrade-but-log: a failed source read skips only its own notification
  // category (partial delivery beats all-or-nothing for a "who needs to know"
  // engine), but a silently-broken table would otherwise stop those reminders
  // forever with no signal — so surface each read failure.
  const SOURCE_TABLES = [
    'family_members', 'calendar_events', 'chore_assignments', 'school_events', 'sports_events',
    'reminders', 'documents', 'renewals', 'opportunities', 'medications',
    'medication_schedules', 'medication_doses', 'parent_approvals',
  ] as const;
  sourceResults.forEach((r, i) => {
    if (r.error) console.error('[notifications] generation source read failed', { familyId, table: SOURCE_TABLES[i], error: r.error });
  });
  const [
    { data: members },
    { data: events },
    { data: chores },
    { data: school },
    { data: sports },
    { data: reminders },
    { data: docs },
    { data: renewalsDue },
    { data: signupsDue },
    { data: meds },
    { data: medSchedules },
    { data: medDoses },
    { data: approvalsPending },
  ] = sourceResults;

  const userByMember = new Map((members ?? []).map((m) => [m.id, m.user_id]));
  const managers = (members ?? []).filter((m) => m.role === 'parent' || m.role === 'adult');
  const managerLites = managers.map((m) => ({ id: m.id, user_id: m.user_id }));

  // Resolve chore titles.
  const choreIds = [...new Set((chores ?? []).map((c) => c.chore_id))];
  const { data: choreRows } = choreIds.length
    ? await supabase.from('chores').select('id, title').in('id', choreIds)
    : { data: [] as { id: string; title: string }[] };
  const choreTitle = new Map((choreRows ?? []).map((c) => [c.id, c.title]));

  const candidates: Candidate[] = [];

  for (const e of events ?? []) {
    const target = e.assignee_id ? userByMember.get(e.assignee_id) ?? null : null;
    candidates.push({
      type: 'calendar_event', related_type: 'calendar_events', related_id: e.id, user_id: target,
      title: e.title,
      body: `${timeLabel(e.starts_at, tz, e.all_day)}${e.location ? ` · ${e.location}` : ''}`,
    });
  }

  for (const c of chores ?? []) {
    candidates.push({
      type: 'chore_due', related_type: 'chore_assignments', related_id: c.id,
      user_id: userByMember.get(c.member_id) ?? null,
      title: `Chore due: ${choreTitle.get(c.chore_id) ?? 'Task'}`,
      body: c.due_at ? `Due ${timeLabel(c.due_at, tz)}` : 'Due soon',
    });
  }

  for (const s of school ?? []) {
    const target = s.member_id ? userByMember.get(s.member_id) ?? null : null;
    candidates.push({
      type: 'school_event', related_type: 'school_events', related_id: s.id, user_id: target,
      title: `School: ${s.title}`,
      body: `${timeLabel(s.starts_at, tz)}${s.event_type ? ` · ${s.event_type}` : ''}`,
    });
  }

  for (const s of sports ?? []) {
    const target = s.member_id ? userByMember.get(s.member_id) ?? null : null;
    candidates.push({
      type: 'sports_event', related_type: 'sports_events', related_id: s.id, user_id: target,
      title: `${s.sport ?? 'Sports'}: ${s.title}`,
      body: `${timeLabel(s.starts_at, tz)}${s.location ? ` · ${s.location}` : ''}`,
    });
  }

  for (const r of reminders ?? []) {
    candidates.push({
      type: 'system', related_type: 'reminders', related_id: r.id,
      user_id: r.member_id ? userByMember.get(r.member_id) ?? null : null,
      title: `Reminder: ${r.title}`,
      body: `Due ${timeLabel(r.remind_at, tz)}`,
    });
  }

  // Expiring documents → notify managers (one per manager so each is alerted).
  for (const d of docs ?? []) {
    const when = d.expires_at ? new Date(d.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'soon';
    if (managers.length === 0) {
      candidates.push({ type: 'document_expiry', related_type: 'documents', related_id: d.id, user_id: null, title: `Document expiring: ${d.title}`, body: `Expires ${when}` });
    } else {
      for (const m of managers) {
        candidates.push({ type: 'document_expiry', related_type: 'documents', related_id: `${d.id}:${m.id}`, user_id: m.user_id, title: `Document expiring: ${d.title}`, body: `Expires ${when}` });
      }
    }
  }

  // Renewals approaching their per-item reminder window, and signups whose
  // registration deadline is within a week → alert managers (pure builders).
  for (const row of renewalReminders(renewalsDue ?? [], managerLites, todayKey)) {
    candidates.push(row);
  }
  for (const row of opportunityReminders(signupsDue ?? [], managerLites, todayKey)) {
    candidates.push(row);
  }

  // Pending money approvals → notify the parents who can act on them.
  for (const row of approvalReminders((approvalsPending ?? []) as ApprovalInput[], managerLites)) {
    candidates.push(row);
  }

  // Relationship dates entering their reminder window (anniversaries, birthdays,
  // date nights). The related_id is keyed by occurrence year so the permanent
  // dedup sends one advance reminder per occurrence, then again next year.
  //
  // `todayKey` — the family's day, computed above and used by every other
  // reminder in this function via `timeLabel(..., tz)`. This one block passed
  // the raw instant instead, so it resolved against the HOST's day: a birthday
  // reminder fired a day early for the last seven hours of every Californian
  // day. And because the dedup is PERMANENT and keyed by occurrence year, the
  // early one is the only one — the real day arrives with nothing sent.
  const { data: relDates } = await supabase.from('relationship_dates')
    .select('id, kind, title, event_date, recurs_annually, reminder_days_before, status')
    .eq('family_id', familyId).neq('status', 'cancelled').limit(100);
  for (const d of upcomingRelationship((relDates ?? []).map((r): RelDate => ({
    id: r.id, kind: r.kind, title: r.title, eventDate: r.event_date,
    recursAnnually: r.recurs_annually, reminderDaysBefore: r.reminder_days_before, status: r.status,
  })), todayKey)) {
    const ms = milestoneLabel(d);
    candidates.push({
      type: 'system', related_type: 'relationship_dates', related_id: `${d.id}:${d.nextKey.slice(0, 4)}`, user_id: null,
      title: `💞 ${d.title} ${formatCountdown(d.days).toLowerCase()}`,
      body: ms ? `${ms} · plan something special` : 'Open the Relationship Helper for gift ideas',
    });
  }

  // Rich family reminders (the /dashboard/reminders service) — these never
  // notified before. Fire when the effective time (due minus the early-reminder
  // lead) is within the window; dedup permanently per reminder.
  const { data: famReminders } = await supabase.from('family_reminders')
    .select('id, title, remind_at, status, early_reminder_minutes, member_id')
    .eq('family_id', familyId).eq('status', 'active').not('remind_at', 'is', null)
    .gte('remind_at', nowIso).lte('remind_at', reminderFetchHorizonIso(now));
  for (const n of dueFamilyReminderNotices((famReminders ?? []) as FamilyReminderRow[], now)) {
    const r = (famReminders ?? []).find((x) => x.id === n.id)!;
    candidates.push({
      type: 'system', related_type: 'family_reminders', related_id: `fr:${n.id}`,
      user_id: r.member_id ? userByMember.get(r.member_id) ?? null : null,
      title: `Reminder: ${n.title}`,
      body: `Due ${timeLabel(n.remindAtIso, tz)}`,
    });
  }

  // "On this day" memories → one warm family-wide ping on days that resurface
  // past photos. The related_id embeds today's date, so the permanent dedup
  // sends it at most once per day; ordinary days produce nothing.
  const { data: datedPhotos } = await supabase.from('family_photos')
    .select('id, taken_at')
    .eq('family_id', familyId).not('taken_at', 'is', null)
    .order('taken_at', { ascending: false }).limit(400);
  const memoryNotice = onThisDayNotice(datedPhotos ?? [], now);
  if (memoryNotice) {
    candidates.push({
      type: 'system', related_type: 'family_photos', related_id: memoryNotice.relatedId,
      user_id: null, title: memoryNotice.title, body: memoryNotice.body,
    });
  }

  // Imminent life-moments (sports/trips/parties/appointments within 36h, plus
  // today/tomorrow birthdays) → one family-wide "get ready" nudge each, carrying
  // the leave-by time and top prep steps from the Moments engine. The related_id
  // embeds the event's date, so each occurrence pings at most once and 'general'
  // events stay covered by the plain calendar_event notification above.
  for (const m of imminentMomentNotices(
    (events ?? []).map((e) => ({ id: e.id, title: e.title, category: null, location: e.location, starts_at: e.starts_at, all_day: e.all_day })),
    members ?? [],
    now,
  )) {
    candidates.push({
      type: 'system', related_type: 'calendar_events', related_id: m.relatedId,
      user_id: null, title: m.title, body: m.body,
    });
  }

  // Calendar double-bookings → proactively flag whoever is double-booked (or the
  // managers, for a child with no account). Reuses the pure conflict detector.
  const { data: conflictEvents } = await supabase.from('calendar_events')
    .select('id, title, starts_at, ends_at, all_day, assignee_id')
    .eq('family_id', familyId).not('assignee_id', 'is', null)
    .gte('starts_at', nowIso).lte('starts_at', in14d)
    .order('starts_at').limit(200);
  const nameByMember = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  for (const c of detectConflicts((conflictEvents ?? []) as ConflictEvent[])) {
    const key = `conflict:${[...c.eventIds].sort().join('-')}`;
    const who = nameByMember.get(c.assigneeId);
    const body = `${who ? `${who}: ` : ''}${c.eventIds.length} events overlap ${timeLabel(c.startsAt, tz)}`;
    const target = userByMember.get(c.assigneeId) ?? null;
    if (target) {
      candidates.push({ type: 'system', related_type: 'calendar_events', related_id: key, user_id: target, title: 'Schedule conflict', body });
    } else if (managers.length > 0) {
      for (const m of managers) candidates.push({ type: 'system', related_type: 'calendar_events', related_id: `${key}:${m.id}`, user_id: m.user_id, title: 'Schedule conflict', body });
    } else {
      candidates.push({ type: 'system', related_type: 'calendar_events', related_id: key, user_id: null, title: 'Schedule conflict', body });
    }
  }

  // ── Generic items: dedup permanently against notifications for the same item.
  let rows: NotificationRow[] = [];
  if (candidates.length > 0) {
    const relatedIds = [...new Set(candidates.map((c) => c.related_id))];
    // Batched, because a PostgREST filter travels in the QUERY STRING and these
    // ids are not uuids — `related_id` carries a composite dedupe key such as
    // `moment:<eventId>:<date>`, about 60 characters once url-encoded. A few
    // hundred of them build a request line past the gateway's limit and the read
    // comes back `URI too long`, which (per the comment below) leaves `seen`
    // empty and re-inserts every candidate. Observed exactly that, every run.
    // 50 per batch keeps the longest URL near 3 KB.
    const { data: existing, error: existingErr } = await readInChunks<
      { type: string; related_id: string | null; user_id: string | null }, { message: string }
    >(relatedIds, (chunk) => supabase
      .from('notifications')
      .select('type, related_id, user_id')
      .eq('family_id', familyId)
      .in('related_id', chunk), 50);
    // A failed dedup read leaves `seen` empty, so every candidate would pass the
    // filter and re-insert as a duplicate — log it so that spam is diagnosable.
    if (existingErr) console.error('[notifications] dedup read failed', { familyId, error: existingErr });
    const seen = new Set((existing ?? []).map((e) => `${e.type}:${e.related_id}:${e.user_id ?? 'all'}`));
    rows = candidates
      .filter((c) => !seen.has(`${c.type}:${c.related_id}:${c.user_id ?? 'all'}`))
      .slice(0, 100)
      .map((c) => toRow(familyId, c));
  }

  // ── Medication doses recur daily, so they dedup against TODAY's medication_due
  //    notifications only (related_id stays the medication's real uuid).
  let medRows: NotificationRow[] = [];
  const medReminders = medicationDueReminders(meds ?? [], medSchedules ?? [], medDoses ?? [], userByMember, managerLites, now);
  if (medReminders.length > 0) {
    const { data: existingMed, error: existingMedErr } = await supabase
      .from('notifications')
      .select('related_id, user_id')
      .eq('family_id', familyId)
      .eq('type', 'medication_due')
      .gte('created_at', todayStartIso);
    // Same duplicate-spam risk as above for daily medication-due reminders.
    if (existingMedErr) console.error('[notifications] medication dedup read failed', { familyId, error: existingMedErr });
    const seenMed = new Set((existingMed ?? []).map((e) => `${e.related_id}:${e.user_id ?? 'all'}`));
    medRows = medReminders
      .filter((r) => !seenMed.has(`${r.related_id}:${r.user_id ?? 'all'}`))
      .map((r) => toRow(familyId, r));
  }

  const allRows = [...rows, ...medRows].slice(0, 150);
  if (allRows.length === 0) return 0;

  // The last writer that bypassed the quiet-hours window. It is NOT routed
  // through `notify()`, deliberately: it builds up to 150 rows and inserts them
  // in one batch, with its own per-type dedupe reads above, so `notify()` would
  // turn one insert into 150 round trips on a cron to re-solve a problem this
  // function already solves. What it lacked was the window — so it takes the
  // window, from the same function `notify()` uses, resolved ONCE for the whole
  // batch since every row belongs to this one family.
  //
  // Not urgent: everything this generator produces is a courtesy notice about a
  // day's events, reminders and medications. A run at 06:30 UTC is 23:30 for a
  // family on US Pacific time.
  const scope = await systemScopeForFamily(supabase, familyId);
  if (scope) {
    const { sendAt } = await deliveryTimeFor(scope);
    for (const row of allRows) row.send_at = sendAt;
  } else {
    // The family could not be read, so its zone is unknown. Send now rather than
    // hold against a guessed window: a notice that arrives is recoverable, one
    // held for eight hours against the wrong clock is not.
    console.error('[notifications] could not read the family for quiet hours', { familyId });
  }

  const { error } = await supabase.from('notifications').insert(allRows);
  if (error) throw new Error(error.message);
  return allRows.length;
}

type NotificationRow = {
  family_id: string;
  user_id: string | null;
  /** Set from `deliveryTimeFor` before the insert; the column defaults to now(). */
  send_at?: string;
  type: NotificationType;
  title: string;
  body: string | null;
  related_type: string;
  related_id: string;
};

function toRow(familyId: string, c: Candidate): NotificationRow {
  return {
    family_id: familyId,
    user_id: c.user_id,
    type: c.type,
    title: c.title,
    body: c.body,
    related_type: c.related_type,
    related_id: c.related_id,
  };
}
