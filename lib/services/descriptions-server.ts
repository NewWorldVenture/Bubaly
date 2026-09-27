import 'server-only';
import type { createServiceClient } from '@/lib/supabase/server';
import { SERVICE_DESCRIPTION_KEYS } from '@/lib/services/descriptions';

type AdminClient = ReturnType<typeof createServiceClient>;

export type OverridesRead =
  | { ok: true; overrides: Record<string, string> }
  | { ok: false; error: unknown };

/**
 * The super-admin overrides from `service_descriptions`, or a read that FAILED
 * reported as one. The admin editor needs the difference: it used to get `{}`
 * for both, so a failed read drew every blurb as the shipped default under
 * "All using defaults", hid the CUSTOM badges and Reset buttons, and a Save
 * from that screen overwrote a family-wide custom blurb its editor never saw
 * (SRV-001 l5).
 */
export async function readServiceDescriptionOverrides(supabase: AdminClient): Promise<OverridesRead> {
  try {
    const { data, error } = await supabase
      .from('service_descriptions')
      .select('service_key, description')
      .limit(1000);
    if (error) return { ok: false, error };
    const out: Record<string, string> = {};
    for (const row of data ?? []) {
      if (row.service_key && typeof row.description === 'string' && row.description.trim()) {
        out[row.service_key] = row.description.trim();
      }
    }
    return { ok: true, overrides: out };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * The overrides as a plain map, best-effort, for the tooltips every member
 * sees: a missing table or a rejected read degrades to `{}`, so tooltips fall
 * back to the code defaults (safe before the migration is applied). Logged,
 * so a read that keeps failing is visible somewhere.
 */
export async function loadServiceDescriptionOverrides(supabase: AdminClient): Promise<Record<string, string>> {
  const read = await readServiceDescriptionOverrides(supabase);
  if (!read.ok) {
    console.error('[service-descriptions] overrides read failed; serving the shipped defaults', read.error);
    return {};
  }
  return read.overrides;
}

/** True when a key is a real, known service (guards super-admin writes). */
export function isKnownServiceKey(key: string): boolean {
  return SERVICE_DESCRIPTION_KEYS.includes(key);
}
