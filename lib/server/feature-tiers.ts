import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { cache } from 'react';
import { resolveFeatureTiers, tiersByHref, isFeatureTier, type FeatureOverrides } from '@/lib/features/tiers';
import { FEATURE_CATALOG_BY_KEY, type FeatureTier } from '@/lib/constants/feature-catalog';

type DB = SupabaseClient<Database>;
const KEY = 'feature_tiers';

/** Raw admin overrides from app_settings (may be empty). */
function sanitizeOverrides(value: unknown): FeatureOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const stored = value as Record<string, unknown>;
  const clean: FeatureOverrides = {};
  for (const [k, v] of Object.entries(stored)) {
    if (FEATURE_CATALOG_BY_KEY[k] && typeof v === 'string' && isFeatureTier(v)) clean[k] = v;
  }
  return clean;
}

async function readFeatureOverrides(supabase: DB): Promise<FeatureOverrides> {
  const { data, error } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  if (error) {
    console.error('[feature-tiers] override read failed', error);
    throw error;
  }
  return sanitizeOverrides(data?.value);
}

/** Public reads keep the catalog available during a transient settings outage. */
export async function getFeatureOverrides(supabase: DB): Promise<FeatureOverrides> {
  try {
    return await readFeatureOverrides(supabase);
  } catch {
    return {};
  }
}

/** Catalog defaults merged with admin overrides — the effective tier map. */
export async function getResolvedFeatureTiers(supabase: DB): Promise<Record<string, FeatureTier>> {
  return resolveFeatureTiers(await getFeatureOverrides(supabase));
}

/**
 * Effective tiers keyed by ROUTE href (drives nav gating + `requireFeature`).
 * Request-`cache`d so a layout + the route guard share one query per render.
 */
export const getFeatureTiersByHref = cache(async (supabase: DB): Promise<Record<string, FeatureTier>> => {
  return tiersByHref(await getResolvedFeatureTiers(supabase));
});

/** Sets one feature's tier (or clears it back to default when tier === its default). */
export async function setFeatureTier(supabase: DB, key: string, tier: FeatureTier): Promise<void> {
  const def = FEATURE_CATALOG_BY_KEY[key];
  if (!def || !isFeatureTier(tier)) return;

  const overrides = await readFeatureOverrides(supabase);
  if (tier === def.defaultTier) delete overrides[key];
  else overrides[key] = tier;

  const { error } = await supabase.from('app_settings').upsert(
    { key: KEY, value: overrides as Database['public']['Tables']['app_settings']['Insert']['value'] },
    { onConflict: 'key' },
  );
  if (error) throw error;
}

/** Resets all overrides back to the catalog defaults. */
export async function resetFeatureTiers(supabase: DB): Promise<void> {
  const { error } = await supabase.from('app_settings').upsert(
    { key: KEY, value: {} as Database['public']['Tables']['app_settings']['Insert']['value'] },
    { onConflict: 'key' },
  );
  if (error) throw error;
}
