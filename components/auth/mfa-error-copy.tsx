'use client';

// The words for a Supabase Auth MFA refusal, shared by the Settings › Security
// panel and the step-up page so the same error reads the same in both places.
// Supabase's own message is kept alongside ours: "MFA enroll is disabled for
// TOTP" tells the project owner exactly which switch to flip, and no
// paraphrase would.
import { useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslations } from '@/components/i18n/locale-provider';
import type { ClassifiedMfaError } from '@/lib/auth/mfa';

export function useMfaErrorCopy() {
  const t = useTranslations();
  return useCallback((err: ClassifiedMfaError): { headline: string; detail: string | null } => {
    const headline = ((): string => {
      switch (err.kind) {
        case 'not_enabled': return t('securityPanel.errorNotEnabled');
        case 'invalid_code': return t('securityPanel.errorInvalidCode');
        case 'expired': return t('securityPanel.errorExpired');
        case 'insufficient_aal': return t('securityPanel.errorInsufficientAal');
        case 'name_conflict': return t('securityPanel.errorNameConflict');
        case 'too_many_factors': return t('securityPanel.errorTooMany');
        case 'factor_not_found': return t('securityPanel.errorNotFound');
        case 'rate_limited': return t('securityPanel.errorRateLimited');
        case 'network': return t('securityPanel.errorNetwork');
        default: return t('securityPanel.errorUnknown');
      }
    })();
    // A wrong code needs no quote from Supabase; every other refusal does.
    const detail = err.message && err.kind !== 'invalid_code' ? t('securityPanel.supabaseSaid', { message: err.message }) : null;
    return { headline, detail };
  }, [t]);
}

export function MfaErrorNotice({ error, onRetry }: { error: ClassifiedMfaError; onRetry?: () => void }) {
  const t = useTranslations();
  const copy = useMfaErrorCopy()(error);
  return (
    <div role="alert" className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
      <p>{copy.headline}</p>
      {copy.detail && <p className="mt-1 break-words text-xs opacity-80">{copy.detail}</p>}
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-danger/40 px-3 py-1.5 text-xs font-medium hover:bg-danger/10">
          <RefreshCw className="h-3.5 w-3.5" /> {t('securityPanel.tryAgain')}
        </button>
      )}
    </div>
  );
}
