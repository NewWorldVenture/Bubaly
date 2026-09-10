import 'server-only';
import type { SyncProviderEnum } from '@/lib/database.types';
import { getTranslations } from '@/lib/i18n/server';
import { fail, ok, type ServiceResult, type ServiceScope } from '@/lib/services/types';

export type SyncAccountIdentity = { id: string; family_id: string; user_id: string | null; external_id: string | null };
export type SyncExecutionPolicy =
  | { mode: 'standard'; pull: boolean; push: boolean }
  | { mode: 'onboarding_import'; calendarExternalId: string };
export type SyncPolicyErrorCode = 'notEnabled' | 'directionUnavailable' | 'settingsUnavailable' | 'finishImport';
type SyncPolicyDecision =
  | { ok: true; data: SyncExecutionPolicy }
  | { ok: false; code: SyncPolicyErrorCode; retryable: boolean };
const denied = (code: SyncPolicyErrorCode, retryable = false): SyncPolicyDecision => ({ ok: false, code, retryable });

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** 0018 directions apply before any credential or provider access. A pending
 * onboarding marker stays dormant even if another caller changes direction. */
export function syncExecutionPolicy(row: { sync_direction: unknown; metadata: unknown }): SyncPolicyDecision {
  const direction = row.sync_direction;
  if (direction === 'manual' || direction === 'disabled') return denied('notEnabled');
  if (!['import', 'export', 'two_way'].includes(String(direction))) return denied('directionUnavailable', true);
  const metadata = record(row.metadata);
  if (!metadata) return denied('settingsUnavailable', true);
  if (Object.prototype.hasOwnProperty.call(metadata, 'onboardingCalendar')) {
    const onboarding = record(metadata.onboardingCalendar);
    if (onboarding?.version !== 1 || onboarding.state !== 'import' || direction !== 'import'
      || typeof onboarding.calendarExternalId !== 'string' || !onboarding.calendarExternalId.trim()) {
      return denied('finishImport');
    }
    return { ok: true, data: { mode: 'onboarding_import', calendarExternalId: onboarding.calendarExternalId } };
  }
  return { ok: true, data: { mode: 'standard', pull: direction !== 'export', push: direction !== 'import' } };
}

/** Re-read persisted policy instead of trusting the caller's possibly stale
 * account object. The account, family, requester and provider must all match. */
export async function loadSyncExecutionPolicy(
  db: ServiceScope['db'], account: SyncAccountIdentity, provider: SyncProviderEnum,
): Promise<ServiceResult<SyncExecutionPolicy>> {
  const t = await getTranslations();
  try {
    if (!account.user_id) return fail(t('syncPolicy.ownerUnavailable'), { code: 'ownerUnavailable' });
    const result = await db.from('sync_accounts').select('sync_direction,metadata')
      .eq('id', account.id).eq('family_id', account.family_id).eq('user_id', account.user_id).eq('provider', provider).maybeSingle();
    if (result.error || !result.data) throw result.error ?? new Error('Connected account was unavailable');
    const policy = syncExecutionPolicy(result.data);
    return policy.ok ? ok(policy.data) : fail(t(`syncPolicy.${policy.code}`), { code: policy.code, retryable: policy.retryable });
  } catch (error) {
    console.error('[service:sync] connection policy read failed', error);
    return fail(t('syncPolicy.readFailed'), { code: 'readFailed', retryable: true });
  }
}
