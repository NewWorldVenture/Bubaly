import { Car } from 'lucide-react';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { AutoSubnav } from '@/components/auto/auto-subnav';

export default async function AutoLayout({ children }: { children: React.ReactNode }) {
  await requirePlanLevel(1);
  return (
    <div className="module-page">
      <div className="flex items-center gap-3">
        <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand">
          <Car className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Auto &amp; Vehicles</h1>
          <p className="text-sm text-muted">Licenses, registration, inspections, insurance, rentals — with renewal reminders.</p>
        </div>
      </div>
      <AutoSubnav />
      {children}
    </div>
  );
}
