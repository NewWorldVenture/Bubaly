import type { Metadata } from 'next';
import { LayoutGrid } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { APP_NAV_GROUPS } from '@/lib/constants/navigation';
import { SERVICE_DESCRIPTIONS } from '@/lib/services/descriptions';
import { loadServiceDescriptionOverrides } from '@/lib/services/descriptions-server';
import { ServiceDescriptionsEditor, type EditorGroup } from '@/components/admin/service-descriptions-editor';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Admin · Service Catalog', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function AdminServicesPage() {
  const t = await getTranslations();
  const overrides = await loadServiceDescriptionOverrides(createServiceClient());

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

      <ServiceDescriptionsEditor groups={groups} overrides={overrides} />
    </div>
  );
}
