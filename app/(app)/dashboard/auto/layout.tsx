import { Car } from 'lucide-react';
import { requireFeature } from '@/lib/supabase/auth';
import { AutoSubnav } from '@/components/auto/auto-subnav';
import { getTranslations } from '@/lib/i18n/server';

export default async function AutoLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations();
  await requireFeature('/dashboard/auto');
  return (
    <div className="module-page">
      <div className="flex items-center gap-3">
        <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand-text">
          <Car className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t('dashboardAuto.autoAmpVehicles')}</h1>
          <p className="text-sm text-muted">{t('dashboardAuto.licensesRegistrationInspectionsInsuranceRentalsWith')}</p>
        </div>
      </div>
      <AutoSubnav />
      {children}
    </div>
  );
}
