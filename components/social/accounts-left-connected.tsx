import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { AccountRow } from '@/components/social/account-row';
import { PROVIDERS, type SocialPlatform } from '@/lib/social/capabilities';
import type { LeftConnected } from '@/lib/social/left-connected';
import { getTranslations } from '@/lib/i18n/server';

/**
 * A family without Social, and the accounts it still has connected: each with
 * its Disconnect, and the plans when a plan would bring Social back. The social
 * layout renders this in place of the console, and the (app) shell inside its
 * paywall and closed-account gate (lib/social/left-connected.ts).
 */
export async function AccountsLeftConnected({ accounts, plansHref }: LeftConnected) {
  const t = await getTranslations();
  return (
    <Card>
      <h2 className="text-sm font-semibold">{t('socialLeftConnected.title')}</h2>
      <p className="mt-1 text-sm text-muted">{t('socialLeftConnected.body')}</p>
      <div className="mt-3 space-y-2">
        {accounts.map((a) => (
          <AccountRow
            key={a.id}
            id={a.id}
            platform={a.platform as SocialPlatform}
            name={a.display_name ?? a.handle ?? PROVIDERS[a.platform as SocialPlatform].label}
            status={a.status}
            lastError={a.last_error}
            lastSyncedAt={a.last_synced_at}
            // Only a member who holds connect_accounts is shown this list.
            canDisconnect
          />
        ))}
      </div>
      {plansHref && (
        <Link href={plansHref} className="mt-3 inline-flex h-9 items-center rounded-lg bg-brand px-3 text-sm font-medium text-brand-fg">
          {t('socialLeftConnected.seePlans')}
        </Link>
      )}
    </Card>
  );
}
