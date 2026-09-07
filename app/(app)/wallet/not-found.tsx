import { AppNotFound } from '@/components/app/app-not-found';
import { getTranslations } from '@/lib/i18n/server';

// Renders inside the wallet's AppFrame, so notFound() on a missing child wallet
// keeps the nav chrome.
export default async function WalletNotFound() {
  const t = await getTranslations();
  return (
    <AppNotFound
      title={t('notFound.thatWalletIsnTHere')}
      description={t('notFound.thisChildWalletMayHave')}
      backHref="/wallet"
      backLabel="Back to Wallet"
    />
  );
}
