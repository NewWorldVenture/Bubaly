import 'server-only';
import { createServiceClient } from '@/lib/supabase/server';
import { resolveFeatureTiers, type FeatureOverrides } from '@/lib/features/tiers';
import type { FeatureTier } from '@/lib/constants/feature-catalog';
import { withPublicReadBudget } from '@/lib/marketing/public-read';

/**
 * The public comparison matrix has the existing catalog-default fallback.
 * Its deadline is deliberately separate from shared entitlement/admin reads.
 * Neither a failed read nor its fallback is cached as live admin configuration.
 */
export async function getPricingFeatureTiers(): Promise<Record<string, FeatureTier>> {
  try {
    return await withPublicReadBudget(async (signal) => {
      const { data, error } = await createServiceClient()
        .from('app_settings').select('value').eq('key', 'feature_tiers')
        .abortSignal(signal).maybeSingle();
      if (error) throw error;
      const value = data?.value;
      const overrides = value && typeof value === 'object' && !Array.isArray(value)
        ? value as FeatureOverrides : undefined;
      return resolveFeatureTiers(overrides);
    });
  } catch (err) {
    console.error('[marketing-pricing] feature tiers unavailable (using catalog defaults)', err);
    return resolveFeatureTiers(undefined);
  }
}
