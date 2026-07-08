// lib/intelligence/hard-signals-server.ts — service-callable detection for the
// hard family-intelligence signals (R10). Reads the family's real data, runs the
// pure engines (hard-signals.ts), and upserts the results into family_signals —
// PRESERVING any signal the family has dismissed (so a dismissed pattern never
// nags again). Callable on-demand (the Family Intelligence page's Refresh) and
// from the model-refresh cron (always-learning). This is the only place raw rows
// are read; the engines stay pure.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { detectConflicts, type ConflictEvent } from '@/lib/home/conflicts';
import {
  buildHardSignals, type HardSignalInputs, type ReminderRow, type ChoreRow, type RoutineRow, type RoutineCompletion,
} from './hard-signals';

type DB = SupabaseClient<Database>;

export type SignalDetectionResult = { ok: boolean; error?: string; signals: number };

const DAY = 86_400_000;

/** Recompute the family's hard signals from live data and upsert them. */
export async function runSignalDetection(sb: DB, familyId: string, now: Date = new Date()): Promise<SignalDetectionResult> {
  const since90 = new Date(now.getTime() - 90 * DAY).toISOString();
  const windowStart = new Date(now.getTime() - 21 * DAY).toISOString();
  const windowEnd = new Date(now.getTime() + 14 * DAY).toISOString();

  // ── Read sources in parallel ──
  const [reminders, events, choreRows, routines] = await Promise.all([
    sb.from('family_reminders')
      .select('id, title, remind_at, status, completed_at, member_id')
      .eq('family_id', familyId).not('remind_at', 'is', null)
      .gte('remind_at', since90).limit(2000),
    sb.from('calendar_events')
      .select('id, title, starts_at, ends_at, assignee_id')
      .eq('family_id', familyId)
      .gte('starts_at', windowStart).lte('starts_at', windowEnd).limit(2000),
    sb.from('chore_assignments')
      .select('chore_id, status, disputed, member_id, chores(title)')
      .eq('family_id', familyId).gte('created_at', since90).limit(2000),
    sb.from('routine_templates')
      .select('id, name, weekday_mask').eq('family_id', familyId).eq('is_active', true).limit(200),
  ]);
  if (reminders.error) return { ok: false, error: reminders.error.message, signals: 0 };

  const nowMs = now.getTime();
  const reminderRows: ReminderRow[] = (reminders.data ?? []).map((r) => ({
    id: r.id, title: r.title, remindAt: r.remind_at, status: r.status, completedAt: r.completed_at, memberId: r.member_id,
  }));

  const eventRows = (events.data ?? []) as { id: string; title: string; starts_at: string; ends_at: string | null; assignee_id: string | null }[];
  const stressEvents = eventRows.map((e) => ({ at: e.starts_at }));
  const conflicts = detectConflicts(eventRows.map((e) => ({
    id: e.id, title: e.title, starts_at: e.starts_at, ends_at: e.ends_at, all_day: false, assignee_id: e.assignee_id,
  })) as ConflictEvent[]).map((c) => ({ at: c.startsAt }));
  const overdue = reminderRows
    .filter((r) => r.remindAt && Date.parse(r.remindAt) < nowMs && r.status !== 'done' && !r.completedAt)
    .map((r) => ({ at: r.remindAt as string }));

  const chores: ChoreRow[] = (choreRows.data ?? []).map((c) => {
    const rel = (c as { chores?: { title?: string } | { title?: string }[] | null }).chores;
    const title = Array.isArray(rel) ? rel[0]?.title : rel?.title;
    return { choreId: c.chore_id, choreTitle: title ?? 'A chore', status: c.status as string, disputed: !!c.disputed, memberId: c.member_id };
  });

  const routineRows: RoutineRow[] = (routines.data ?? []).map((r) => ({ id: r.id, name: r.name, weekdayMask: r.weekday_mask }));
  // Adherence proxy: a calendar event whose title contains a routine's name (in the
  // recent window) counts as that routine happening.
  const recentEvents = eventRows.filter((e) => Date.parse(e.starts_at) <= nowMs && Date.parse(e.starts_at) >= nowMs - 28 * DAY);
  const routineCompletions: RoutineCompletion[] = [];
  for (const e of recentEvents) {
    const t = (e.title ?? '').toLowerCase();
    for (const r of routineRows) {
      if (r.name && t.includes(r.name.toLowerCase())) { routineCompletions.push({ routineId: r.id, occurredAt: e.starts_at }); break; }
    }
  }

  const inputs: HardSignalInputs = {
    reminders: reminderRows, events: stressEvents, conflicts, overdue,
    chores, routines: routineRows, routineCompletions,
  };
  const signals = buildHardSignals(inputs, now);

  // ── Persist (preserve dismissals) ──
  const { data: existing } = await sb.from('family_signals')
    .select('kind, subject_key, status').eq('family_id', familyId);
  const dismissed = new Set((existing ?? []).filter((r) => r.status === 'dismissed').map((r) => `${r.kind}:${r.subject_key}`));

  const toUpsert = signals
    .filter((s) => !dismissed.has(`${s.kind}:${s.subjectKey}`))
    .map((s) => ({
      family_id: familyId, kind: s.kind, subject_key: s.subjectKey,
      title: s.title, detail: s.detail, score: s.score,
      evidence: s.evidence as Database['public']['Tables']['family_signals']['Insert']['evidence'],
      member_id: s.memberId ?? null, status: 'active', last_seen_at: now.toISOString(),
    }));

  if (toUpsert.length > 0) {
    const { error: upErr } = await sb.from('family_signals')
      .upsert(toUpsert, { onConflict: 'family_id,kind,subject_key' });
    if (upErr) return { ok: false, error: upErr.message, signals: 0 };
  }
  return { ok: true, signals: toUpsert.length };
}
