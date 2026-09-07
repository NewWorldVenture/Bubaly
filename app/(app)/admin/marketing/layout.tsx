import { Megaphone } from 'lucide-react';
import { getTranslations } from '@/lib/i18n/server';
import { MarketingSubnav } from './marketing-subnav';

export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations();
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Megaphone className="h-5 w-5 text-brand-text" />
        <h1 className="text-lg font-bold">{t('marketing.marketing')}</h1>
      </div>
      <MarketingSubnav />
      {children}
    </div>
  );
}
