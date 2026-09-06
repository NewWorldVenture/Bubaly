import type { Metadata } from 'next';
import { SlidersHorizontal } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { getResolvedFeatureTiers } from '@/lib/server/feature-tiers';
import { TierFeaturesClient } from './tier-features-client';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Admin · Tier & Features', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function TierFeaturesPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  const resolved = await getResolvedFeatureTiers(supabase);

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
      <TierFeaturesClient resolved={resolved} />
    </div>
  );
}
