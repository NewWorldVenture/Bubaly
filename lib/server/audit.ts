import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

/** Append an entry to the family audit log. Best-effort: never throws into the caller. */
export async function logAudit(
  supabase: SupabaseClient<Database>,
  entry: {
    familyId: string | null;
    actorId?: string | null;
    action: string;
    resource: string;
    resourceId?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    await supabase.from('audit_logs').insert({
      family_id: entry.familyId,
      actor_id: entry.actorId ?? null,
      action: entry.action,
      resource: entry.resource,
      resource_id: entry.resourceId ?? null,
      metadata: (entry.metadata ?? null) as Database['public']['Tables']['audit_logs']['Insert']['metadata'],
    });
  } catch (e) {
    console.error('[audit] failed to write log', e);
  }
}
