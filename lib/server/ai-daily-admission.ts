// The per-feature daily AI caps (Money Mentor, Money Coach, Relationship
// Helper) count today's usage rows, call the model, and only then write the
// row that counts the call. N requests in flight together all read the same
// count and all went to the model, so the cap held only for requests that
// arrived one at a time. The usage tables are insert-only (0347), so a call
// cannot reserve a row and take it back.
//
// The admission here closes that without a schema change. A request that read
// `usedToday = n` must also win the durable, atomic limiter (`rate_limit_hit`)
// for the key `ai-daily:<counted action>:<family>:<n>`, with a limit of one.
// Racers that read the same count collide on that key: one proceeds and the
// rest are turned away. A later request reads n + 1 only once the winner's
// usage row lands, so the cap is never passed. A winner whose model call
// fails writes no row, and its count's key frees when the window runs out —
// long enough to outlast any one model call.

import { createServiceClient } from '@/lib/supabase/server';
// Through the AI limiter seam, the same durable `rate_limit_hit` every AI
// route's burst limit uses.
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';

/** Longer than any one model call, so a winner still in flight keeps its count. */
export const AI_DAILY_ADMISSION_WINDOW_MS = 5 * 60_000;

/** The limiter key for one observed count. Exported for tests. */
export function aiDailyAdmissionKey(countedAction: string, familyId: string, usedToday: number): string {
  return `ai-daily:${countedAction}:${familyId}:${Math.max(0, Math.trunc(usedToday))}`;
}

/**
 * May this request — which read `usedToday` — be the one that uses the next slot?
 *
 * Evaluated on the SERVICE client. The key names a household, not the caller,
 * and `rate_limit_hit` (0179) refuses a signed-in caller any key that does not
 * name their own id — on the member's session this would fail closed and
 * answer 429 to every request (tests/a-signed-in-rate-limit-key-names-the-
 * caller.test.ts). The service client carries no `auth.uid()` and is exempt.
 */
export function admitDailyAIUse(
  input: { countedAction: string; familyId: string; usedToday: number },
): ReturnType<typeof enforceAIRateLimit> {
  return enforceAIRateLimit(
    createServiceClient(),
    aiDailyAdmissionKey(input.countedAction, input.familyId, input.usedToday),
    { limit: 1, windowMs: AI_DAILY_ADMISSION_WINDOW_MS },
  );
}
