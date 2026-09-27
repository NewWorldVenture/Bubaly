import type { Metadata } from 'next';
import { LayoutGrid } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { APP_NAV_GROUPS } from '@/lib/constants/navigation';
import { SERVICE_DESCRIPTIONS } from '@/lib/services/descriptions';
import { readServiceDescriptionOverrides } from '@/lib/services/descriptions-server';
import { ErrorState } from '@/components/ui/states';
import { ServiceDescriptionsEditor, type EditorGroup } from '@/components/admin/service-descriptions-editor';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Admin · Service Catalog', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function AdminServicesPage() {
  const t = await getTranslations();
  // Read strictly. The editor draws a missing override as "using the
  // default", so an editor over a read that failed would show every custom
  // blurb as the default and let a Save overwrite one nobody saw (SRV-001 l5).
  const read = await readServiceDescriptionOverrides(createServiceClient());
  if (!read.ok) console.error('[admin-services] overrides read failed', read.error);

  // Group exactly as the "All Services" catalog, keeping only services that ship
  // with a default (the editable universe), deduped across groups.
  const seen = new Set<string>();
  const groups: EditorGroup[] = APP_NAV_GROUPS.map((group) => ({
    title: group.title,
    items: group.items
      .filter((it) => it.href in SERVICE_DESCRIPTIONS && !seen.has(it.href) && (seen.add(it.href), true))
      .map((it) => ({ key: it.href, label: it.label })),
  })).filter((g) => g.items.length > 0);

  const total = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand/15">
          <LayoutGrid className="h-6 w-6 text-brand-text" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('adminServices.serviceCatalog')}</h1>
          <p className="mt-1 text-sm text-muted">
            The hover tooltip shown for each service in the “All Services” picker. Edit any blurb to
            override the built-in default across the whole app — changes are live for every member. Empty
            or unchanged fields fall back to the shipped copy. {total} services.
          </p>
        </div>
      </div>

      {read.ok
        ? <ServiceDescriptionsEditor groups={groups} overrides={read.overrides} />
        : <ErrorState message={t('adminServices.couldNotLoadTheOverrides')} />}
    </div>
  );
}
