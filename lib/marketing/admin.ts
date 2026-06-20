import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import type { Database } from '@/lib/database.types';

type DB = SupabaseClient<Database>;

/**
 * Defense-in-depth guard for every marketing server action / route handler.
 * The admin layout already gates /admin to super admins, but actions must
 * re-verify independently. Returns the service-role client + the actor.
 */
export async function requireMarketingAdmin(): Promise<{
  supabase: DB;
  actorId: string;
  actorEmail: string | null;
}> {
  const user = await getUser();
  if (!user) throw new Error('Not authenticated');
  const ok = await isSuperAdmin();
  if (!ok) throw new Error('Forbidden: admin only');
  return { supabase: createServiceClient(), actorId: user.id, actorEmail: user.email ?? null };
}

export async function logMarketingAudit(
  supabase: DB,
  entry: {
    actorId: string | null;
    actorEmail: string | null;
    action: string;
    resource: string;
    resourceId?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    await supabase.from('marketing_audit_logs').insert({
      actor_id: entry.actorId,
      actor_email: entry.actorEmail,
      action: entry.action,
      resource: entry.resource,
      resource_id: entry.resourceId ?? null,
      metadata: (entry.metadata ?? {}) as Database['public']['Tables']['marketing_audit_logs']['Insert']['metadata'],
    });
  } catch (e) {
    console.error('[marketing audit] failed to write log', e);
  }
}
