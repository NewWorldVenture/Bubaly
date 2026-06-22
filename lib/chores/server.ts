// lib/chores/server.ts
// Server-side gamification engine for Family Missions: XP, levels, streaks, and
// badge awards applied when a chore is approved. Runs as the signed-in family
// member (RLS allows family members to manage kid_progress / member_badges).
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { DIFFICULTY_XP, levelForXp, nextStreak, type Difficulty } from '@/lib/chores/logic';

type DB = SupabaseClient<Database>;
type Progress = Database['public']['Tables']['kid_progress']['Row'];

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Get-or-create the member's progress row. */
export async function ensureProgress(supabase: DB, familyId: string, memberId: string): Promise<Progress> {
  const { data: existing } = await supabase.from('kid_progress').select('*').eq('member_id', memberId).maybeSingle();
  if (existing) return existing;
  const { data, error } = await supabase
    .from('kid_progress')
    .insert({ family_id: familyId, member_id: memberId })
    .select('*')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'Could not create progress');
  return data;
}

export type CompletionResult = { xp: number; level: number; leveledUp: boolean; streak: number; newBadges: string[] };

/**
 * Apply XP, streak, level, and badge changes for an approved chore. Idempotency
 * is the caller's responsibility (call once per approval). Returns what changed
 * so the UI can celebrate.
 */
export async function applyCompletionRewards(
  supabase: DB,
  opts: { familyId: string; memberId: string; difficulty: Difficulty; qualityScore: number | null },
): Promise<CompletionResult> {
  const progress = await ensureProgress(supabase, opts.familyId, opts.memberId);
  const today = todayISO();

  const gainedXp = DIFFICULTY_XP[opts.difficulty] ?? DIFFICULTY_XP.medium;
  const xp = progress.xp + gainedXp;
  const prevLevel = progress.level;
  const level = levelForXp(xp);
  const streak = nextStreak(progress.current_streak, progress.last_activity, today);
  const longest = Math.max(progress.longest_streak, streak);

  await supabase
    .from('kid_progress')
    .update({ xp, level, current_streak: streak, longest_streak: longest, last_activity: today })
    .eq('member_id', opts.memberId);

  // Count this member's approved chores to drive count-based badges.
  const { count } = await supabase
    .from('chore_assignments')
    .select('id', { count: 'exact', head: true })
    .eq('member_id', opts.memberId)
    .eq('status', 'approved');
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
}

/** Insert any not-yet-earned badges; returns the ids actually newly awarded. */
export async function awardBadges(supabase: DB, familyId: string, memberId: string, badgeIds: string[]): Promise<string[]> {
  if (badgeIds.length === 0) return [];
  const { data: have } = await supabase.from('member_badges').select('badge_id').eq('member_id', memberId);
  const owned = new Set((have ?? []).map((b) => b.badge_id));
  const toAdd = [...new Set(badgeIds)].filter((id) => !owned.has(id));
  if (toAdd.length === 0) return [];
  await supabase.from('member_badges').insert(toAdd.map((badge_id) => ({ family_id: familyId, member_id: memberId, badge_id })));
  return toAdd;
}

/** Convenience: log an approval-audit event (best-effort). */
export async function logChoreEvent(
  supabase: DB,
  e: {
    familyId: string; assignmentId?: string | null; submissionId?: string | null; actorId?: string | null;
    action: Database['public']['Tables']['chore_approval_events']['Insert']['action'];
    pointsAwarded?: number | null; cashCents?: number | null; note?: string | null;
  },
): Promise<void> {
  try {
    await supabase.from('chore_approval_events').insert({
      family_id: e.familyId,
      assignment_id: e.assignmentId ?? null,
      submission_id: e.submissionId ?? null,
      actor_id: e.actorId ?? null,
      action: e.action,
      points_awarded: e.pointsAwarded ?? null,
      cash_cents: e.cashCents ?? null,
      note: e.note ?? null,
    });
  } catch (err) {
    console.error('[chore event] failed to log', err);
  }
}
