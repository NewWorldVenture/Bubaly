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
    if (p.status === 'reset') row.reset_at = new Date().toISOString();

    await admin.from('onboarding_progress').upsert(row as never, { onConflict: 'user_id' });
  } catch (e) {
    console.error('[onboarding] progress record failed', e);
  }
}

export type OnboardingProgressRow = Database['public']['Tables']['onboarding_progress']['Row'];

/** Read the account's onboarding_progress row (null when absent / pre-migration). */
export async function getOnboardingProgress(supabase: DB, userId: string): Promise<OnboardingProgressRow | null> {
  try {
    const { data } = await supabase
      .from('onboarding_progress')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    return (data as OnboardingProgressRow | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve an account's live completeness by joining the progress row with the
 * ground-truth facts (does a family_onboarding row exist, how many members,
 * does the profile have a real name). Degrades safely — any query failure yields
 * a conservative "in_progress" verdict rather than throwing.
 */
export async function resolveCompleteness(
  admin: DB,
  userId: string,
  familyId: string | null,
): Promise<{ result: CompletenessResult; progress: OnboardingProgressRow | null }> {
  const progress = await getOnboardingProgress(admin, userId);

  let hasName = false;
  let hasQuestionnaire = false;
  let hasGoals = false;
  let memberCount = 0;

  try {
    const { data: profile } = await admin
      .from('profiles').select('display_name, full_name').eq('id', userId).maybeSingle();
    hasName = !!(profile?.display_name || profile?.full_name);
  } catch { /* keep default */ }

  if (familyId) {
    try {
      const { data: fo } = await admin
        .from('family_onboarding').select('goals, completed_at').eq('family_id', familyId).maybeSingle();
      hasQuestionnaire = !!fo?.completed_at;
      hasGoals = Array.isArray(fo?.goals) && fo!.goals.length > 0;
    } catch { /* keep default */ }
    try {
      const { count } = await admin
        .from('family_members')
        .select('id', { count: 'exact', head: true })
        .eq('family_id', familyId);
      // Discount the account holder themselves.
      memberCount = Math.max(0, (count ?? 1) - 1);
    } catch { /* keep default */ }
  }

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
  return { result, progress };
}

export { statusFromCompleteness };
