// "Who Needs to Know" — the smart-notification engine.
// Scans the next 24–48h of real family data and creates per-member notification
// rows (mapped to the affected member's user account), deduplicating against
// notifications already created for the same item. Deterministic by design:
// notifications must be trustworthy, so this is rule-based, not AI-generated.
import type { SupabaseClient } from '@supabase/supabase-js';
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
import { systemScopeForFamily } from '@/lib/services/scope';

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

function timeLabel(iso: string, allDay = false): string {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = d.toDateString() === today.toDateString()
    ? 'today'
    : d.toDateString() === new Date(today.getTime() + 24 * HOUR).toDateString()
      ? 'tomorrow'
      : d.toLocaleDateString('en-US', { weekday: 'long' });
  if (allDay) return day;
  return `${day} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

export async function generateFamilyNotifications(supabase: DB, familyId: string): Promise<number> {
  const now = new Date();
  const in24 = new Date(now.getTime() + 24 * HOUR).toISOString();
  const in48 = new Date(now.getTime() + 48 * HOUR).toISOString();
  const in14d = new Date(now.getTime() + 14 * 24 * HOUR).toISOString();
  const nowIso = now.toISOString();
  // Date-only (YYYY-MM-DD) bounds for the date columns on renewals/opportunities.
  const todayKey = nowIso.slice(0, 10);
  const todayStartIso = `${todayKey}T00:00:00.000Z`;
  const renewalMaxKey = new Date(now.getTime() + 90 * 24 * HOUR).toISOString().slice(0, 10);
  const signupMaxKey = new Date(now.getTime() + 7 * 24 * HOUR).toISOString().slice(0, 10);

  const sourceResults = await Promise.all([
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
      body: `${timeLabel(e.starts_at, e.all_day)}${e.location ? ` · ${e.location}` : ''}`,
    });
  }

  for (const c of chores ?? []) {
    candidates.push({
      type: 'chore_due', related_type: 'chore_assignments', related_id: c.id,
      user_id: userByMember.get(c.member_id) ?? null,
      title: `Chore due: ${choreTitle.get(c.chore_id) ?? 'Task'}`,
      body: c.due_at ? `Due ${timeLabel(c.due_at)}` : 'Due soon',
    });
  }

  for (const s of school ?? []) {
    const target = s.member_id ? userByMember.get(s.member_id) ?? null : null;
    candidates.push({
      type: 'school_event', related_type: 'school_events', related_id: s.id, user_id: target,
      title: `School: ${s.title}`,
      body: `${timeLabel(s.starts_at)}${s.event_type ? ` · ${s.event_type}` : ''}`,
    });
  }

  for (const s of sports ?? []) {
    const target = s.member_id ? userByMember.get(s.member_id) ?? null : null;
    candidates.push({
      type: 'sports_event', related_type: 'sports_events', related_id: s.id, user_id: target,
      title: `${s.sport ?? 'Sports'}: ${s.title}`,
      body: `${timeLabel(s.starts_at)}${s.location ? ` · ${s.location}` : ''}`,
    });
  }

  for (const r of reminders ?? []) {
    candidates.push({
      type: 'system', related_type: 'reminders', related_id: r.id,
      user_id: r.member_id ? userByMember.get(r.member_id) ?? null : null,
      title: `Reminder: ${r.title}`,
      body: `Due ${timeLabel(r.remind_at)}`,
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
  const { data: relDates } = await supabase.from('relationship_dates')
    .select('id, kind, title, event_date, recurs_annually, reminder_days_before, status')
    .eq('family_id', familyId).neq('status', 'cancelled').limit(100);
  for (const d of upcomingRelationship((relDates ?? []).map((r): RelDate => ({
    id: r.id, kind: r.kind, title: r.title, eventDate: r.event_date,
    recursAnnually: r.recurs_annually, reminderDaysBefore: r.reminder_days_before, status: r.status,
  })), now)) {
    const ms = milestoneLabel(d);
    candidates.push({
      type: 'system', related_type: 'relationship_dates', related_id: `${d.id}:${d.next.getFullYear()}`, user_id: null,
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
      body: `Due ${timeLabel(n.remindAtIso)}`,
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
    const body = `${who ? `${who}: ` : ''}${c.eventIds.length} events overlap ${timeLabel(c.startsAt)}`;
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
    const { data: existing, error: existingErr } = await supabase
      .from('notifications')
      .select('type, related_id, user_id')
      .eq('family_id', familyId)
      .in('related_id', relatedIds);
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
