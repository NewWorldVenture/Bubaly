// lib/autopilot/scan.ts — the server-side Autopilot pass, shared by the
// on-demand route (active family) and the cron runner (all families).
//
// Reads the family's real rows, builds the normalized snapshot, runs the pure
// engine, then reconciles `autopilot_suggestions`: respects prior resolutions,
// clears stale OPEN suggestions whose signal vanished, and auto-executes new
// high-confidence reminders (reversibly — it inserts a real `reminders` row).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { buildSuggestions, confidenceTier, type FamilySnapshot } from '@/lib/autopilot/engine';

type DB = SupabaseClient<Database>;

export type AutopilotScanResult = { scanned: number; autoExecuted: number; cleared: number };

const RESOLVED = new Set(['dismissed', 'snoozed', 'executed', 'approved', 'auto_executed']);

export async function runAutopilotScan(supabase: DB, familyId: string, userId: string | null): Promise<AutopilotScanResult> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const in30 = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);
  const in2 = new Date(now.getTime() + 2 * 86400000).toISOString();

  const [
    { data: renewals }, { data: appts }, { data: choreRows },
    { data: members }, { data: groceries }, { data: apptReminders },
    { data: events }, { data: existing },
  ] = await Promise.all([
    supabase.from('renewals').select('id, title, expires_at, status').eq('family_id', familyId).eq('status', 'active').lte('expires_at', in30).limit(100),
    supabase.from('appointments').select('id, title, starts_at, member_id').eq('family_id', familyId).gte('starts_at', `${today}T00:00:00Z`).lte('starts_at', in2).limit(50),
    supabase.from('chore_assignments').select('id, due_at, member_id, status, chores(title)').eq('family_id', familyId).in('status', ['todo', 'in_progress']).lt('due_at', `${today}T00:00:00Z`).limit(100),
    supabase.from('family_members').select('id, display_name, birthday').eq('family_id', familyId).eq('is_active', true).not('birthday', 'is', null).limit(50),
    supabase.from('grocery_items').select('id, name, created_at, is_checked').eq('family_id', familyId).eq('is_checked', false).limit(200),
    supabase.from('reminders').select('related_id').eq('family_id', familyId).eq('related_type', 'appointment').eq('is_done', false).limit(200),
    supabase.from('calendar_events').select('id, title, starts_at, ends_at, assignee_id').eq('family_id', familyId).gte('starts_at', `${today}T00:00:00Z`).lte('starts_at', in2).limit(100),
    supabase.from('autopilot_suggestions').select('id, dedupe_key, status').eq('family_id', familyId).limit(500),
  ]);

  const remindedAppt = new Set((apptReminders ?? []).map((r) => r.related_id).filter(Boolean) as string[]);

  const snapshot: FamilySnapshot = {
    today,
    renewals: (renewals ?? []).map((r) => ({ id: r.id, label: r.title, expiresOn: r.expires_at })),
    appointments: (appts ?? []).map((a) => ({ id: a.id, title: a.title, startsAt: a.starts_at, memberId: a.member_id, hasReminder: remindedAppt.has(a.id) })),
    overdueChores: (choreRows ?? []).map((c) => ({
      id: c.id,
      title: (c as unknown as { chores: { title: string } | null }).chores?.title ?? 'Chore',
      dueAt: c.due_at, memberId: c.member_id,
    })),
    birthdays: (members ?? []).map((m) => ({ memberId: m.id, name: m.display_name, birthday: m.birthday as string })),
    lingeringGroceries: (groceries ?? []).map((g) => ({ id: g.id, name: g.name, addedAt: g.created_at })),
    events: (events ?? []).map((e) => ({ id: e.id, title: e.title, startsAt: e.starts_at, endsAt: e.ends_at, memberId: e.assignee_id })),
  };

  const drafts = buildSuggestions(snapshot);
  const draftKeys = new Set(drafts.map((d) => d.dedupeKey));
  const existingByKey = new Map((existing ?? []).map((e) => [e.dedupe_key, e]));

  // 1) Clear stale OPEN suggestions whose signal disappeared this scan.
  const stale = (existing ?? []).filter((e) => e.status === 'open' && !draftKeys.has(e.dedupe_key)).map((e) => e.id);
  if (stale.length > 0) {
    await supabase.from('autopilot_suggestions').delete().in('id', stale).eq('family_id', familyId);
  }

  // 2) Insert genuinely-new drafts; auto-execute the safe high-confidence ones.
  let autoExecuted = 0;
  for (const d of drafts) {
    const prior = existingByKey.get(d.dedupeKey);
    if (prior) continue; // respect prior state (resolved or already-open); avoid churn

    const isAuto = confidenceTier(d.confidence) === 'auto';
    let status: 'open' | 'auto_executed' = 'open';

    if (isAuto && d.actionType === 'create_reminder') {
      const at = (d.payload.at as string) ?? `${today}T09:00:00Z`;
      const { error: remErr } = await supabase.from('reminders').insert({
        family_id: familyId,
        title: (d.payload.title as string) ?? d.title,
        remind_at: at,
        member_id: d.memberId,
        related_type: d.sourceKind === 'appointments' ? 'appointment' : 'renewal',
        related_id: d.sourceId,
        created_by: userId,
      });
      if (!remErr) { status = 'auto_executed'; autoExecuted++; }
    }

    await supabase.from('autopilot_suggestions').insert({
      family_id: familyId,
      member_id: d.memberId,
      kind: d.kind,
      title: d.title,
      detail: d.detail,
      confidence: d.confidence,
      urgency: d.urgency,
      status,
      action_type: d.actionType,
      action_label: d.actionLabel,
      payload: d.payload as never,
      source_kind: d.sourceKind,
      source_id: d.sourceId,
      dedupe_key: d.dedupeKey,
      expires_at: d.expiresAt,
      resolved_at: status === 'auto_executed' ? now.toISOString() : null,
      resolved_by: null,
      created_by: userId,
    });
  }

  return { scanned: drafts.length, autoExecuted, cleared: stale.length };
}
