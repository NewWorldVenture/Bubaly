// lib/chores/server.ts
// Server-side gamification engine for Family Missions: XP, levels, streaks, and
// badge awards applied when a chore is approved. Runs as the signed-in family
// member (RLS allows family members to manage kid_progress / member_badges).
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createServiceClient } from '@/lib/supabase/server';
import { dayKeyInTz } from '@/lib/services/scope';
import { DIFFICULTY_XP, type Difficulty } from '@/lib/chores/logic';

type DB = SupabaseClient<Database>;
type Progress = Database['public']['Tables']['kid_progress']['Row'];

/**
 * Get-or-create the member's progress row.
 *
 * This is a READ path. The award itself no longer goes through it: a total
 * computed from a row read here would be computed outside the lock that makes
 * it true (0341), so `applyCompletionRewards` does its own get-or-create inside
 * `kid_progress_apply_completion`.
 */
export async function ensureProgress(supabase: DB, familyId: string, memberId: string): Promise<Progress> {
  const { data: existing, error: lookupError } = await supabase
    .from('kid_progress').select('*').eq('family_id', familyId).eq('member_id', memberId).maybeSingle();
  if (lookupError) throw new Error('Could not read chore progress');
  if (existing) return existing;
  const { data, error } = await supabase
    .from('kid_progress')
    .insert({ family_id: familyId, member_id: memberId })
    .select('*')
    .single();
  if (error || !data) throw new Error('Could not create chore progress');
  return data;
}

/**
 * What `kid_progress_apply_completion` (0341) hands back: the row as this award
 * left it, and what it found before touching it. The `previous_*` half is not
 * decoration — it is what lets ONE award be taken back without taking back an
 * approval that landed beside it.
 */
type AppliedCompletion = {
  xp: number;
  level: number;
  currentStreak: number;
  longestStreak: number;
  lastActivity: string | null;
  previousLevel: number;
  previousStreak: number;
  previousLongestStreak: number;
  previousLastActivity: string | null;
};

/** Read the RPC's jsonb, or null if it failed or came back a shape we cannot trust. */
function readAppliedCompletion(data: unknown): AppliedCompletion | null {
  if (!data || typeof data !== 'object') return null;
  const row = data as Record<string, unknown>;
  if (row.ok !== true) return null;
  const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const day = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
  const xp = num(row.xp);
  const level = num(row.level);
  const currentStreak = num(row.current_streak);
  const longestStreak = num(row.longest_streak);
  const previousLevel = num(row.previous_level);
  const previousStreak = num(row.previous_streak);
  const previousLongestStreak = num(row.previous_longest_streak);
  if (xp === null || level === null || currentStreak === null || longestStreak === null
    || previousLevel === null || previousStreak === null || previousLongestStreak === null) return null;
  return {
    xp, level, currentStreak, longestStreak,
    lastActivity: day(row.last_activity),
    previousLevel, previousStreak, previousLongestStreak,
    previousLastActivity: day(row.previous_last_activity),
  };
}

/**
 * Take back ONE award when the badge work after it fails.
 *
 * This used to write the pre-award row back absolutely, which is the same lost
 * update pointing the other way: an approval that landed in between would be
 * erased by the rollback of an unrelated one. `kid_progress_revert_completion`
 * subtracts under the same row lock the award was applied under, and restores
 * the streak only while the row still carries what this award wrote.
 */
async function revertCompletionRewards(
  supabase: DB,
  opts: { familyId: string; memberId: string },
  gainedXp: number,
  applied: AppliedCompletion,
): Promise<void> {
  const { error } = await supabase.rpc('kid_progress_revert_completion', {
    p_family_id: opts.familyId,
    p_member_id: opts.memberId,
    p_gained_xp: gainedXp,
    p_applied_streak: applied.currentStreak,
    p_applied_longest_streak: applied.longestStreak,
    p_applied_last_activity: applied.lastActivity,
    p_previous_streak: applied.previousStreak,
    p_previous_longest_streak: applied.previousLongestStreak,
    p_previous_last_activity: applied.previousLastActivity,
  });
  if (error) console.error('[chore rewards] progress rollback failed', error);
}

export type CompletionResult = { xp: number; level: number; leveledUp: boolean; streak: number; newBadges: string[] };

/**
 * Apply XP, streak, level, and badge changes for an approved chore. Idempotency
 * is the caller's responsibility (call once per approval). Returns what changed
 * so the UI can celebrate.
 *
 * That idempotency rule is about ONE approval being submitted twice, and it is
 * unchanged. It never covered two DIFFERENT approvals for the same child
 * arriving together — no caller can prevent those, and both are supposed to
 * count. 0341 is what makes them both count.
 */
export async function applyCompletionRewards(
  supabase: DB,
  opts: {
    familyId: string; memberId: string; difficulty: Difficulty; qualityScore: number | null;
    /** The family's IANA zone. Required, and deliberately not defaulted. */
    tz: string;
    /** The instant the approval happened. Required, so this module reads no clock. */
    now: Date;
  },
): Promise<CompletionResult> {
  // The day this approval is FILED against, on the family's kitchen wall.
  //
  // This used to be the day at Greenwich, and `last_activity` is a DATE column
  // (00430) — a column that already means the family's day, so a Greenwich key
  // written into it is simply the wrong day for a large, predictable slice of
  // every day. A chore approved at 17:00 in Los Angeles was filed against
  // TOMORROW: `last_activity` disagreed with the day the child actually did the
  // chore, and 0341's streak arm (`p_today - v_row.last_activity = 1`) then
  // credited the next day's streak a day early. East of Greenwich the error runs
  // the other way, and a child who did a chore at 08:00 in Tokyo was filed
  // against YESTERDAY, so the following day looked like a two-day gap and the
  // streak reset to 1.
  //
  // The SQL side is untouched and must stay untouched: `p_today` is a `date`
  // parameter and every comparison 0341 makes with it is date-to-date
  // arithmetic, which is whole-calendar-day arithmetic and therefore DST-proof.
  // What was wrong was never the comparison; it was which day TypeScript named.
  const today = dayKeyInTz(opts.now, opts.tz);
  const gainedXp = DIFFICULTY_XP[opts.difficulty] ?? DIFFICULTY_XP.medium;

  // 0341. This used to read the row, add the XP in TypeScript, and write the
  // total back by id — so two approvals for one child at the same moment both
  // read xp=100 and both wrote 120, and one award was silently lost. The level
  // and both streak columns came off that same stale read, so they were lost in
  // the same statement. `kid_progress_apply_completion` takes the row FOR
  // UPDATE and does all four sums against what is THERE. Do not put the
  // arithmetic back on this side of the wire.
  const { data, error } = await supabase.rpc('kid_progress_apply_completion', {
    p_family_id: opts.familyId,
    p_member_id: opts.memberId,
    p_gained_xp: gainedXp,
    p_today: today,
  });
  const applied = error ? null : readAppliedCompletion(data);
  if (!applied) throw new Error('Could not save chore progress');

  const { xp, level, currentStreak: streak, previousLevel: prevLevel } = applied;

  try {
    // Count this member's approved chores to drive count-based badges.
    const { count, error: historyError } = await supabase
      .from('chore_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('family_id', opts.familyId)
      .eq('member_id', opts.memberId)
      .eq('status', 'approved');
    if (historyError) throw new Error('Could not read chore history');
    const approvedCount = count ?? 0;

    const earn: string[] = [];
    if (approvedCount >= 1) earn.push('first_chore');
    if (approvedCount >= 10) earn.push('ten_done');
    if (streak >= 3) earn.push('streak_3');
    if (streak >= 7) earn.push('streak_7');
    if (opts.qualityScore === 100) earn.push('perfect_score');
    if (level >= 5) earn.push('level_5');

    const newBadges = await awardBadges(supabase, opts.familyId, opts.memberId, earn);

    return { xp, level, leveledUp: level > prevLevel, streak, newBadges };
  } catch {
    await revertCompletionRewards(supabase, opts, gainedXp, applied);
    throw new Error('Could not apply chore rewards');
  }
}

/** Insert any not-yet-earned badges; returns the ids actually newly awarded. */
export async function awardBadges(supabase: DB, familyId: string, memberId: string, badgeIds: string[]): Promise<string[]> {
  if (badgeIds.length === 0) return [];
  const { data: have, error: lookupError } = await supabase
    .from('member_badges').select('badge_id').eq('family_id', familyId).eq('member_id', memberId);
  if (lookupError) throw new Error('Could not read earned badges');
  const owned = new Set((have ?? []).map((b) => b.badge_id));
  const toAdd = [...new Set(badgeIds)].filter((id) => !owned.has(id));
  if (toAdd.length === 0) return [];
  const { data: inserted, error: insertError } = await supabase.from('member_badges').upsert(
    toAdd.map((badge_id) => ({ family_id: familyId, member_id: memberId, badge_id })),
    { onConflict: 'member_id,badge_id', ignoreDuplicates: true },
  ).select('badge_id');
  if (insertError) throw new Error('Could not save earned badges');
  return (inserted ?? []).map((badge) => badge.badge_id);
}

/**
 * Convenience: log an approval-audit event (best-effort).
 *
 * chore_approval_events is an append-only audit trail that is SELECT-only for
 * family members (0043: "written by the service-role engine") — there is no
 * authenticated INSERT policy, so this MUST write under the service role. The
 * callers run in a mix of child and manager sessions; passing any of those
 * user sessions here previously left every non-auto-approve event silently
 * RLS-denied (the trail only recorded auto-approvals). Derive the service
 * client internally so every event lands regardless of who triggered it.
 */
export async function logChoreEvent(
  e: {
    familyId: string; assignmentId?: string | null; submissionId?: string | null; actorId?: string | null;
    action: Database['public']['Tables']['chore_approval_events']['Insert']['action'];
    pointsAwarded?: number | null; cashCents?: number | null; note?: string | null;
  },
): Promise<void> {
  try {
    const supabase = createServiceClient();
    const { error } = await supabase.from('chore_approval_events').insert({
      family_id: e.familyId,
      assignment_id: e.assignmentId ?? null,
      submission_id: e.submissionId ?? null,
      actor_id: e.actorId ?? null,
      action: e.action,
      points_awarded: e.pointsAwarded ?? null,
      cash_cents: e.cashCents ?? null,
      note: e.note ?? null,
    });
    if (error) console.error('[chore event] failed to log', error);
  } catch (err) {
    console.error('[chore event] failed to log', err);
  }
}
