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

/**
 * How long one settings read may take. The app shell's nav, the admin listing
 * and every feature gate wait on it, and it had no deadline: a stalled data API
 * held all of them open for as long as the stall lasted.
 */
export const FEATURE_TIER_READ_BUDGET_MS = 3_000;

/**
 * The deadline bounds the WHOLE read, not just the request. An abort signal
 * reaches the fetch (and ends the SDK's retry backoff), but it does not end an
 * access-token lookup the SDK makes before sending, a transport that ignores
 * the signal, or a response body that never finishes (review 5379178080). So
 * the read is raced against the deadline, and the deadline also aborts the
 * request so nothing keeps running behind it. A late answer is discarded.
 */
async function readFeatureOverrides(supabase: DB): Promise<FeatureOverrides> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const timeout = new Error(`The feature-tier read exceeded its ${FEATURE_TIER_READ_BUDGET_MS} ms budget`);
      console.error('[feature-tiers] override read timed out', timeout);
      controller.abort(timeout);
      reject(timeout);
    }, FEATURE_TIER_READ_BUDGET_MS);
  });
  try {
    const { data, error } = await Promise.race([
      supabase.from('app_settings').select('value').eq('key', KEY).abortSignal(controller.signal).maybeSingle(),
      deadline,
    ]);
    if (error) {
      console.error('[feature-tiers] override read failed', error);
      throw error;
    }
    return sanitizeOverrides(data?.value);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** The settings could not be read, or not within the budget. */
export class FeatureTiersUnavailableError extends Error {
  constructor(cause: unknown) {
    super('The feature tiers could not be read.', { cause });
    this.name = 'FeatureTiersUnavailableError';
  }
}

/**
 * What a caller gets when the settings cannot be read:
 *
 *   'catalog-defaults' (the default) — for DISPLAY: /pricing, the nav, the
 *     admin listing. The catalog stays readable through a settings outage.
 *   'throw' — for an ACCESS decision. A failed lookup must never grant a
 *     feature: an admin can make a feature stricter than its catalog default
 *     (free → Plus, or Off), and the default would open what the admin closed.
 *     The caller answers "could not confirm", as it does for an unreadable plan.
 */
export type FeatureTierReadOptions = { onUnavailable?: 'catalog-defaults' | 'throw' };

type OverridesRead = { ok: true; overrides: FeatureOverrides } | { ok: false; error: unknown };

async function overrides(supabase: DB, options?: FeatureTierReadOptions): Promise<FeatureOverrides> {
  const read = await readOverridesOncePerRender(supabase);
  if (read.ok) return { ...read.overrides };
  if (options?.onUnavailable === 'throw') throw new FeatureTiersUnavailableError(read.error);
  return {};
}

/** Admin overrides only (may be empty); `{}` when the settings cannot be read, unless told to throw. */
export async function getFeatureOverrides(supabase: DB, options?: FeatureTierReadOptions): Promise<FeatureOverrides> {
  return overrides(supabase, options);
}

/** Catalog defaults merged with admin overrides — the effective tier map. */
export async function getResolvedFeatureTiers(supabase: DB, options?: FeatureTierReadOptions): Promise<Record<string, FeatureTier>> {
  return resolveFeatureTiers(await overrides(supabase, options));
}

/**
 * `cache` dedupes the settings read across one render, which is where it pays:
 * a layout and the route guard resolve tiers in the same pass. What it caches is
 * the settled read — success or failure — so a display caller and an access
 * caller in the same render share one request and agree about whether it
 * worked; each then applies its own answer to a failure. It only exists
 * inside a React runtime, and this module is now reached from places that have
 * none — a cron route, a server action, and every test that imports one of them
 * — where the import resolves `cache` to undefined and calling it throws. The
 * fallback is the identity wrapper: no dedupe, same answer. Behaviour inside
 * the app is unchanged, because there `cache` is always a function.
 */
const dedupeAcrossRender: <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A) => R =
  typeof cache === 'function' ? cache : (fn) => fn;

const readOverridesOncePerRender = dedupeAcrossRender(async (supabase: DB): Promise<OverridesRead> => {
  try {
    return { ok: true, overrides: await readFeatureOverrides(supabase) };
  } catch (error) {
    return { ok: false, error };
  }
});

/**
 * Effective tiers keyed by ROUTE href (drives nav gating + `requireFeature`).
 * The settings read behind it is request-`cache`d, so a layout + the route
 * guard share one query per render.
 */
export async function getFeatureTiersByHref(supabase: DB, options?: FeatureTierReadOptions): Promise<Record<string, FeatureTier>> {
  return tiersByHref(await getResolvedFeatureTiers(supabase, options));
}

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
