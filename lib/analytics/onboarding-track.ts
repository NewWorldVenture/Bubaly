'use client';

// Fire-and-forget onboarding telemetry. Onboarding has no family_id yet, so it
// can't use useJourney (family-scoped); this writes to onboarding_events instead,
// grouped by an anonymous per-run session id kept in sessionStorage. Errors are
// swallowed — telemetry must never block or break the flow.
import { createClient } from '@/lib/supabase/client';
import type { OnboardingPhase } from '@/lib/analytics/onboarding';

const SESSION_KEY = 'bubaly.onboarding.session';
const START_KEY = 'bubaly.onboarding.start';

function runId(): { session: string; startedAt: number } {
  if (typeof window === 'undefined') return { session: 'ssr', startedAt: Date.now() };
  let session = sessionStorage.getItem(SESSION_KEY);
  if (!session) {
    session = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    sessionStorage.setItem(SESSION_KEY, session);
    sessionStorage.setItem(START_KEY, String(Date.now()));
  }
  const startedAt = Number(sessionStorage.getItem(START_KEY) ?? Date.now());
  return { session, startedAt };
}

/** Record one onboarding step. `userId` is passed once known (post-signup). */
export function trackOnboarding(step: string, phase: OnboardingPhase, userId: string | null = null): void {
  try {
    const { session, startedAt } = runId();
    void createClient()
      .from('onboarding_events')
      .insert({ user_id: userId, session_id: session, step, phase, duration_ms: Date.now() - startedAt })
      .then(() => {}, () => {}); // swallow
  } catch {
    /* never throw from telemetry */
  }
}
