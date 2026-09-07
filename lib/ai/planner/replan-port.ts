// lib/ai/planner/replan-port.ts — the executor's re-planning port, as a thin
// adapter that loads the planner only when a replan step actually runs.
//
// `runGraph` takes `replan: replanPortFor(db)`; lib/ai/runs/continue.ts and
// app/api/cron/ai-runs pass it, so a `replan` step plans the rest of the run
// as a new plan version (`replanRun` in ./index.ts) instead of blocking.
//
// WHY lazy: continue.ts sits under every route and server action that files
// or resumes a run — the intake, the run controls, the approvals service, the
// cron — and the planner's import graph is the context builder and every
// slice, the tool registry, the trust engine and the provider routing. Loaded
// statically, each of those paths would pay for re-planning on every request
// when a replan step is the rare case; loaded here, only a run that reaches
// one does. WHY not imported by the executor: the validator already imports
// the executor (`parseNotifyInput`), and a static import back would make the
// two a cycle.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ExecutorPort } from '@/lib/ai/runs/executor';

/**
 * The port over a ledger client. `db` is the service client the caller
 * already holds; without one the store opens its own.
 */
export function replanPortFor(db?: SupabaseClient<Database>): NonNullable<ExecutorPort['replan']> {
  return async (scope, run, step, steps) => {
    const { replanRun } = await import('./index');
    return replanRun(scope, run, step, steps, db ? { db } : {});
  };
}
