'use server';

// Twin projection (on-demand) — thin wrapper around the service-callable core in
// lib/twin/project-server.ts, run against the RLS user client. The model-refresh
// cron calls the same core with the service client, so on-demand and scheduled
// refreshes share one implementation.

import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { runTwinProjection } from '@/lib/twin/project-server';

export type ProjectResult = { ok: boolean; error?: string; entities?: number; edges?: number };

export async function projectTwinAction(): Promise<ProjectResult> {
  const ctx = await requireUserContext();
  const sb = await createServer();
  const res = await runTwinProjection(sb, ctx.active.familyId, ctx.user.id);
  return res.ok ? { ok: true, entities: res.entities, edges: res.edges } : { ok: false, error: res.error };
}
