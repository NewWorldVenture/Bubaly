import type { Metadata } from 'next';
import Link from 'next/link';
import { SlidersHorizontal } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { getResolvedFeatureTiers, FeatureTiersUnavailableError } from '@/lib/server/feature-tiers';
import type { FeatureTier } from '@/lib/constants/feature-catalog';
import { ErrorState } from '@/components/ui/states';
import { TierFeaturesClient } from './tier-features-client';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Admin · Tier & Features', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function TierFeaturesPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  // A failed read is not the catalog defaults. With the default
  // 'catalog-defaults' answer, a refused or late read drew every feature at its
  // catalog tier, a stored Off as Free, and offered the tier buttons and Reset
  // over a state nobody had read (review
  // R9-2-TIER-FEATURES-FAILED-READ-IS-CATALOG-DEFAULTS). This page asks for the
  // read's failure, which includes the deadline, and offers no control on it.
  // /pricing and the nav keep the catalog defaults.
  let resolved: Record<string, FeatureTier> | null = null;
  try {
    resolved = await getResolvedFeatureTiers(supabase, { onUnavailable: 'throw' });
  } catch (error) {
    if (!(error instanceof FeatureTiersUnavailableError)) throw error;
    console.error('[admin-tier-features] feature tier read failed', error);
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
          <SlidersHorizontal className="h-6 w-6 text-brand-text" /> {t('adminTierFeatures.tierAmpFeatures')}
        </h1>
        <p className="mt-1 text-sm text-muted">
          Control the global offering: which tier each service belongs to (Off / Free / Basic / Plus).
          This is the single source of truth for what&apos;s locked per tier and what the pricing page shows.
        </p>
      </div>
      {resolved ? (
        <TierFeaturesClient resolved={resolved} />
      ) : (
        <div className="max-w-2xl space-y-3">
          <ErrorState message={t('adminTierFeatures.couldNotLoadFeatureTiers')} />
          <Link href="/admin/tier-features" className="text-sm font-medium text-brand-text underline">{t('settings.refreshSettings')}</Link>
        </div>
      )}
    </div>
  );
}
