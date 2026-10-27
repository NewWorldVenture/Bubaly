import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { computeCompleteness, statusFromCompleteness, type CompletenessResult, type CompletenessSignals } from '@/lib/onboarding/completeness';

type DB = SupabaseClient<Database>;

/**
 * Durable onboarding lifecycle + marketing signal (migration 0159). One row per
 * account, feeding both the completeness engine (re-onboard / reset detection)
 * and marketing segments. Every write is best-effort and degrades safely before
 * the migration is applied (to_regclass-style guard via a swallowed catch), so it
 * NEVER blocks a user finishing onboarding.
 */

export interface RecordProgressInput {
  userId: string;
  familyId?: string | null;
  source?: 'wizard' | 'auto_provision' | 'import' | 'admin';
  status?: 'in_progress' | 'completed' | 'reset';
  stepsCompleted?: string[];
  valueEngaged?: boolean;
  importSource?: string | null;
  eventsImported?: number;
  timeSavedMinutes?: number;
  goals?: string[];
  referralSource?: string | null;
  householdAdults?: number | null;
  householdChildren?: number | null;
  membersAdded?: number;
  membersInvited?: number;
  hasPin?: boolean;
  marketingOptIn?: boolean;
  /** Pre-computed completeness score (0..100); omit to let callers store their own. */
  completeness?: number;
}

/**
 * Upsert the account's onboarding_progress row. Pass the service-role client —
 * this runs inside best-effort marketing wiring where RLS writes have proven
 * flaky. Returns silently on any error (including a missing table pre-migration).
 */
export async function recordOnboardingProgress(admin: DB, p: RecordProgressInput): Promise<void> {
  try {
    const row: Record<string, unknown> = { user_id: p.userId };
    if (p.familyId !== undefined) row.family_id = p.familyId;
    if (p.source !== undefined) row.source = p.source;
    if (p.status !== undefined) row.status = p.status;
    if (p.stepsCompleted !== undefined) row.steps_completed = p.stepsCompleted;
    if (p.valueEngaged !== undefined) row.value_engaged = p.valueEngaged;
    if (p.importSource !== undefined) row.import_source = p.importSource;
    if (p.eventsImported !== undefined) row.events_imported = p.eventsImported;
    if (p.timeSavedMinutes !== undefined) row.time_saved_minutes = p.timeSavedMinutes;
    if (p.goals !== undefined) row.goals = p.goals;
    if (p.referralSource !== undefined) row.referral_source = p.referralSource;
    if (p.householdAdults !== undefined) row.household_adults = p.householdAdults;
    if (p.householdChildren !== undefined) row.household_children = p.householdChildren;
    if (p.membersAdded !== undefined) row.members_added = p.membersAdded;
    if (p.membersInvited !== undefined) row.members_invited = p.membersInvited;
    if (p.hasPin !== undefined) row.has_pin = p.hasPin;
    if (p.marketingOptIn !== undefined) row.marketing_opt_in = p.marketingOptIn;
    if (p.completeness !== undefined) row.completeness = p.completeness;
    if (p.status === 'completed') row.completed_at = new Date().toISOString();
    // A run that is open again has no completion: left in place, a reset or a
    // re-adopted run still read as a completed setup on /admin/onboarding,
    // and its next completion was timed from the first run's row.
    else if (p.status === 'reset' || p.status === 'in_progress') row.completed_at = null;
    if (p.status === 'reset') row.reset_at = new Date().toISOString();

    const { error } = await admin.from('onboarding_progress').upsert(row as never, { onConflict: 'user_id' });
    if (error) console.error('[onboarding] progress record failed', { userId: p.userId, error });
  } catch (e) {
    console.error('[onboarding] progress record failed', e);
  }
}

export type OnboardingProgressRow = Database['public']['Tables']['onboarding_progress']['Row'];

/**
 * Read the account's onboarding_progress row, saying whether the read answered.
 *
 * `row: null, error: null` is a confirmed absence. `error` set means the read
 * did NOT answer and the row is unknown: finalize used to take that null for
 * "no progress", treat the account as an idempotent re-submit and return
 * success without writing the family details, members, invites or
 * preferences, while the wizard showed Done and deleted the draft.
 */
export async function readOnboardingProgress(
  supabase: DB, userId: string,
): Promise<{ row: OnboardingProgressRow | null; error: unknown }> {
  try {
    const { data, error } = await supabase
      .from('onboarding_progress')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return { row: null, error };
    return { row: (data as OnboardingProgressRow | null) ?? null, error: null };
  } catch (error) {
    return { row: null, error: error ?? new Error('onboarding progress read failed') };
  }
}

/** Read the account's onboarding_progress row (null when absent, pre-migration or unreadable). */
export async function getOnboardingProgress(supabase: DB, userId: string): Promise<OnboardingProgressRow | null> {
  return (await readOnboardingProgress(supabase, userId)).row;
}

/**
 * Resolve an account's live completeness by joining the progress row with the
 * ground-truth facts (does a family_onboarding row exist, how many members,
 * does the profile have a real name). It never throws, but a read that did not
 * answer is named in `readFailures`, so the setup page can say it could not
 * check rather than show a score built on reads that never happened.
 */
export async function resolveCompleteness(
  admin: DB,
  userId: string,
  familyId: string | null,
): Promise<{ result: CompletenessResult; progress: OnboardingProgressRow | null; readFailures: string[] }> {
  const readFailures: string[] = [];
  const progressRead = await readOnboardingProgress(admin, userId);
  if (progressRead.error) readFailures.push('onboarding_progress');
  const progress = progressRead.row;

  let hasName = false;
  let hasQuestionnaire = false;
  let hasGoals = false;
  let memberCount = 0;

  try {
    const { data: profile, error } = await admin
      .from('profiles').select('display_name, full_name').eq('id', userId).maybeSingle();
    if (error) readFailures.push('profiles');
    hasName = !!(profile?.display_name || profile?.full_name);
  } catch { readFailures.push('profiles'); }

  if (familyId) {
    try {
      const { data: fo, error } = await admin
        .from('family_onboarding').select('goals, completed_at').eq('family_id', familyId).maybeSingle();
      if (error) readFailures.push('family_onboarding');
      hasQuestionnaire = !!fo?.completed_at;
      hasGoals = Array.isArray(fo?.goals) && fo!.goals.length > 0;
    } catch { readFailures.push('family_onboarding'); }
    try {
      const { count, error } = await admin
        .from('family_members')
        .select('id', { count: 'exact', head: true })
        .eq('family_id', familyId);
      if (error) readFailures.push('family_members');
      // Discount the account holder themselves.
      memberCount = Math.max(0, (count ?? 1) - 1);
    } catch { readFailures.push('family_members'); }
  }
  if (readFailures.length) console.error('[onboarding] completeness reads failed', { userId, familyId, readFailures });

  const signals: CompletenessSignals = {
    hasName,
    hasFamily: !!familyId,
    hasQuestionnaire,
    hasGoals,
    valueEngaged: !!progress?.value_engaged,
    memberCount,
    hasPin: !!progress?.has_pin,
    source: progress?.source ?? 'auto_provision',
    status: (progress?.status as CompletenessSignals['status']) ?? null,
  };

  const result = computeCompleteness(signals);
  return { result, progress, readFailures };
}

export { statusFromCompleteness };
