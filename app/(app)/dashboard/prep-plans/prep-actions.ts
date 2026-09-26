'use server';

// Prep-plan generation (on-demand) — thin wrapper around the service-callable core
// in lib/planning/prep-server.ts, run against the RLS user client. The model-refresh
// cron calls the same core with the service client, so on-demand and scheduled
// generation share one implementation.

import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { runPrepGeneration } from '@/lib/planning/prep-server';

export type GenerateResult = { ok: boolean; error?: string; plans?: number };

export async function generatePrepPlansAction(): Promise<GenerateResult> {
  const ctx = await requireUserContext();
  const sb = await createServer();
  // The family's zone comes off the context that is already loaded — no second
  // read, and never the server's zone. `ctx.active.family` is the `families`
  // row, so `timezone` is the column 0002 defaults to 'UTC'.
  const res = await runPrepGeneration(sb, ctx.active.familyId, ctx.user.id, ctx.active.family.timezone || 'UTC');
  return res.ok ? { ok: true, plans: res.plans } : { ok: false, error: res.error };
}
