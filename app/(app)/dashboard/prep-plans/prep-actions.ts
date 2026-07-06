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
  const res = await runPrepGeneration(sb, ctx.active.familyId, ctx.user.id);
  return res.ok ? { ok: true, plans: res.plans } : { ok: false, error: res.error };
}
