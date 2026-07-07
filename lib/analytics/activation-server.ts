import 'server-only';

// Server-side activation recording (T10). For value moments that happen inside a
// server action (e.g. importing a calendar feed), record the milestone once per
// (family, milestone). RLS requires the row's user_id to match the caller.
// Telemetry never blocks the action — all failures are swallowed.
import { createServer } from '@/lib/supabase/server';
import { sessionIndexFromMs, type ActivationMilestone } from '@/lib/analytics/activation';

export async function recordActivationServer(opts: {
  userId: string | null;
  familyId: string;
  milestone: ActivationMilestone;
  signupAtIso?: string | null;
}): Promise<void> {
  try {
    const supabase = await createServer();
    // First occurrence only, per (family, milestone).
    const { data: existing } = await supabase
      .from('activation_events')
      .select('id')
      .eq('family_id', opts.familyId)
      .eq('milestone', opts.milestone)
      .limit(1);
    if (existing && existing.length) return;

    const ms = opts.signupAtIso ? Math.max(0, Date.now() - Date.parse(opts.signupAtIso)) : null;
    await supabase.from('activation_events').insert({
      user_id: opts.userId,
      family_id: opts.familyId,
      session_id: opts.familyId,
      milestone: opts.milestone,
      session_index: sessionIndexFromMs(ms),
      ms_since_signup: ms,
    });
  } catch {
    /* telemetry never blocks the action */
  }
}
