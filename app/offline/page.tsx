import { WifiOff } from 'lucide-react';
import { getTranslations } from '@/lib/i18n/server';

export const metadata = { title: 'Offline' };

export default async function OfflinePage() {
  const t = await getTranslations();
  return (
    <div className="flex min-h-[70dvh] flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-brand/10 text-brand-text">
        <WifiOff className="h-7 w-7" />
      </div>
      <h1 className="text-2xl font-semibold">{t('offline.youReOffline')}</h1>
      <p className="mt-2 max-w-sm text-sm text-muted">{t('offline.checkYourConnectionBubalyWill')}</p>
    </div>
  );
}
