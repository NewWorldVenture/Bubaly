import 'server-only';
import type { createServiceClient } from '@/lib/supabase/server';
import { SERVICE_DESCRIPTION_KEYS } from '@/lib/services/descriptions';

type AdminClient = ReturnType<typeof createServiceClient>;

/**
 * Load the super-admin overrides from `service_descriptions` as a plain map.
 * Best-effort: a missing table / rejected read degrades to `{}` so tooltips
 * simply fall back to the code defaults (safe before the migration is applied).
 */
export async function loadServiceDescriptionOverrides(supabase: AdminClient): Promise<Record<string, string>> {
  try {
    const { data, error } = await supabase
      .from('service_descriptions')
      .select('service_key, description')
      .limit(1000);
    if (error || !data) return {};
    const out: Record<string, string> = {};
    for (const row of data) {
      if (row.service_key && typeof row.description === 'string' && row.description.trim()) {
        out[row.service_key] = row.description.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** True when a key is a real, known service (guards super-admin writes). */
export function isKnownServiceKey(key: string): boolean {
  return SERVICE_DESCRIPTION_KEYS.includes(key);
}
