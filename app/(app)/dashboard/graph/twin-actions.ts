'use server';

// Twin projection (on-demand) — thin wrapper around the service-callable core in
// lib/twin/project-server.ts, run against the RLS user client. The model-refresh
// cron calls the same core with the service client, so on-demand and scheduled
// refreshes share one implementation.

import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { runTwinProjection } from '@/lib/twin/project-server';
import { describeActionError } from '@/lib/supabase/errors';

export type ProjectResult = { ok: boolean; error?: string; entities?: number; edges?: number };

export async function projectTwinAction(): Promise<ProjectResult> {
  const ctx = await requireUserContext();
  const sb = await createServer();
  const res = await runTwinProjection(sb, ctx.active.familyId, ctx.user.id);
  // The runner returns the database's own text for its cron log; a person gets
  // the described form (SEC-023).
  return res.ok ? { ok: true, entities: res.entities, edges: res.edges } : { ok: false, error: describeActionError(res.error) };
}
