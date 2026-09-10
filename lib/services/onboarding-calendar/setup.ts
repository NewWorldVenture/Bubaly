import 'server-only';
import { getTranslations } from '@/lib/i18n/server';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';

export async function verifyCalendarWizard(scope: ServiceScope, options: { allowPendingActivation?: boolean } = {}): Promise<boolean> {
  if (!scope.userId || scope.actorKind !== 'member') return false;
  const [progress, member, family, prefs] = await Promise.all([
    scope.db.from('onboarding_progress').select('family_id, source, status').eq('user_id', scope.userId).maybeSingle(),
    scope.db.from('family_members').select('id, role').eq('user_id', scope.userId).eq('family_id', scope.familyId).eq('is_active', true).maybeSingle(),
    scope.db.from('families').select('created_by').eq('id', scope.familyId).maybeSingle(),
    scope.db.from('user_preferences').select('active_family_id').eq('user_id', scope.userId).maybeSingle(),
  ]);
  if (progress.error || member.error || family.error || prefs.error) throw new Error('Calendar setup ownership read unavailable');
  if (progress.data?.family_id !== scope.familyId || progress.data.source !== 'wizard' || member.data?.role !== 'parent' ||
    family.data?.created_by !== scope.userId || prefs.data?.active_family_id !== scope.familyId) return false;
  if (progress.data.status === 'in_progress') return true;
  if (!options.allowPendingActivation || progress.data.status !== 'completed') return false;
  // Finish can save completion and then fail to activate imports. A reload may
  // recover only the original owner's still-dormant onboarding connection.
  const pending = await scope.db.from('sync_accounts').select('id').eq('user_id', scope.userId).eq('family_id', scope.familyId)
    .eq('sync_direction', 'manual').in('provider', ['google', 'microsoft'])
    .contains('metadata', { onboardingCalendar: { version: 1, state: 'preview' } }).limit(1);
  if (pending.error || !pending.data) throw new Error('Pending calendar activation read unavailable');
  return pending.data.length > 0;
}

/** An explicit Connect action needs a family FK before OAuth. The existing
 * onboarding claim RPC serializes creation and records its resumable wizard. */
export async function prepareCalendarFamily(scope: ServiceScope, input: { name: string; timezone: string; displayName: string }): Promise<ServiceResult<{ familyId: string }>> {
  try {
    if (!scope.userId || scope.actorKind !== 'member') throw new Error('Signed-in owner required');
    const [memberships, progress, preferences] = await Promise.all([
      scope.db.from('family_members').select('family_id, role').eq('user_id', scope.userId).eq('is_active', true),
      scope.db.from('onboarding_progress').select('family_id, source, status').eq('user_id', scope.userId).maybeSingle(),
      scope.db.from('user_preferences').select('user_id, active_family_id').eq('user_id', scope.userId).maybeSingle(),
    ]);
    if (memberships.error || progress.error || preferences.error || !memberships.data) throw new Error('Calendar setup ownership read unavailable');
    if (progress.data?.status === 'completed' || (memberships.data.length &&
      (!progress.data || !['wizard', 'auto_provision'].includes(progress.data.source) ||
        memberships.data.length !== 1 || memberships.data[0].family_id !== progress.data.family_id || memberships.data[0].role !== 'parent'))) throw new Error('Family is already configured');
    const claim = await scope.db.rpc('onboarding_claim_family', { p_user_id: scope.userId, p_name: input.name, p_timezone: input.timezone });
    const familyId = claim.data?.[0]?.family_id;
    if (claim.error || !familyId) throw new Error('Calendar setup family could not be claimed');
    const family = await scope.db.from('families').select('created_by').eq('id', familyId).maybeSingle();
    if (family.error || family.data?.created_by !== scope.userId) throw new Error('Family owner changed');
    const member = await scope.db.from('family_members').select('id, role').eq('family_id', familyId).eq('user_id', scope.userId).maybeSingle();
    if (member.error || (member.data && member.data.role !== 'parent')) throw new Error('Family ownership changed');
    if (!member.data) {
      const created = await scope.db.from('family_members').insert({ family_id: familyId, user_id: scope.userId,
        role: 'parent', display_name: input.displayName, is_active: true }).select('id').maybeSingle();
      if (created.error || !created.data) throw new Error('Family owner could not be saved');
    }
    const currentProgress = await scope.db.from('onboarding_progress').select('family_id, source, status, updated_at').eq('user_id', scope.userId).maybeSingle();
    if (currentProgress.error || currentProgress.data?.family_id !== familyId || currentProgress.data.status === 'completed' ||
      !['wizard', 'auto_provision'].includes(currentProgress.data.source)) throw new Error('Calendar setup was already completed');
    const savedProgress = await scope.db.from('onboarding_progress').update({ source: 'wizard', status: 'in_progress' })
      .eq('user_id', scope.userId).eq('family_id', familyId).eq('updated_at', currentProgress.data.updated_at).neq('status', 'completed').select('user_id').maybeSingle();
    if (savedProgress.error || !savedProgress.data) throw new Error('Calendar setup recovery could not be saved');
    let selected;
    if (preferences.data) {
      const update = scope.db.from('user_preferences').update({ active_family_id: familyId }).eq('user_id', scope.userId);
      selected = await (preferences.data.active_family_id === null ? update.is('active_family_id', null) : update.eq('active_family_id', preferences.data.active_family_id)).select('user_id').maybeSingle();
    } else {
      selected = await scope.db.from('user_preferences').insert({ user_id: scope.userId, active_family_id: familyId }).select('user_id').maybeSingle();
    }
    if (selected.error || !selected.data) throw new Error('Calendar setup family could not be selected');
    return ok({ familyId });
  } catch (error) {
    console.error('[onboarding-calendar] preparation failed', { kind: error instanceof Error ? error.name : 'unavailable' });
    return fail((await getTranslations())('connectedCalendar.unavailable'), { code: SERVICE_CODES.db, retryable: true });
  }
}
