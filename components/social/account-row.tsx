'use client';

import { useTransition } from 'react';
import { Loader2, Unplug } from 'lucide-react';
import { disconnectAccountAction } from '@/app/(app)/dashboard/social/actions';
import { PlatformDot } from './platform';
import { Badge } from '@/components/ui/badge';
import type { SocialPlatform } from '@/lib/social/capabilities';
import { useTranslations } from '@/components/i18n/locale-provider';
import { useHydrationSafeFormat } from '@/components/i18n/use-format';
import { useToast } from '@/components/ui/toast';

const STATUS_TONE: Record<string, 'success' | 'neutral' | 'danger' | 'warning'> = {
  connected: 'success', pending: 'warning', requires_setup: 'neutral',
  error: 'danger', expired: 'warning', disconnected: 'neutral', revoked: 'danger',
};

/**
 * One connected account. `canDisconnect` is whether the viewer's social role
 * holds connect_accounts: disconnectAccountAction refuses anyone else, and a
 * read_only member's press landed on the section's error page (household-roles
 * N1-R1), so the button is not drawn for them.
 */
export function AccountRow({
  id, platform, name, status, lastError, lastSyncedAt, canDisconnect,
}: {
  id: string; platform: SocialPlatform; name: string; status: string; lastError: string | null; lastSyncedAt: string | null;
  canDisconnect: boolean;
}) {
  const t = useTranslations();
  const { fmtDateTime } = useHydrationSafeFormat();
  const { error: toastError } = useToast();
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5">
      <PlatformDot platform={platform} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="truncate text-xs text-muted">
          {lastSyncedAt ? `Synced ${fmtDateTime(lastSyncedAt)}` : (lastError ?? 'Not yet authorized')}
        </p>
      </div>
      <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{status.replace(/_/g, ' ')}</Badge>
      {canDisconnect && <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => {
          // requireSocialPermission THROWS SocialAccessError for a member without
          // `connect_accounts`; a disconnect that did not complete (X's tokens
          // not cleared, the account not found) RETURNS { ok: false, error }.
          // Both reach the person who pressed the button: the second used to
          // say nothing, and the family took its tokens for cleared.
          try {
            const result = await disconnectAccountAction(id);
            if (!result.ok) toastError(result.error ?? t('globalError.somethingWentWrong'));
          } catch (err) { toastError(err instanceof Error && err.message ? err.message : t('globalError.somethingWentWrong')); }
        })}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2 text-xs text-muted hover:text-danger disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unplug className="h-3.5 w-3.5" />} {t('accountRow.disconnect')}
      </button>}
    </div>
  );
}
