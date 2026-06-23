// lib/features/server.ts — server-side resolution + writes for feature tiers.
import 'server-only';
import { cache } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createServiceClient } from '@/lib/supabase/server';
import { FEATURE_TIERS, type FeatureOverrides, type FeatureTier } from '@/lib/features/catalog';

type DB = SupabaseClient<Database>;

/**
 * Read the admin's feature-tier overrides as a { key → tier } map. Request-
 * memoized so the route guard and the layout share one query per render.
 * Degrades to {} (code defaults) if the table is missing/unreadable.
 */
export const getFeatureOverrides = cache(async (supabase: DB): Promise<FeatureOverrides> => {
  const { data, error } = await supabase.from('feature_settings').select('key, tier');
  if (error || !data) return {};
  const out: FeatureOverrides = {};
  for (const row of data) {
    if ((FEATURE_TIERS as string[]).includes(row.tier)) out[row.key] = row.tier as FeatureTier;
  }
  return out;
});

/** Persist (or clear) a single feature's tier override. Service-role only. */
export async function setFeatureTier(key: string, tier: FeatureTier, actorId: string | null): Promise<void> {
  const supabase = createServiceClient();
  await supabase.from('feature_settings').upsert(
    { key, tier, updated_by: actorId },
    { onConflict: 'key' },
  );
}
