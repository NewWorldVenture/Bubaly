import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

/**
 * F19, the owner's decision of 2026-10-02: one spoken exchange counts as ONE
 * request — the assistant turn. Transcription admits the exchange (it is
 * refused once the month is spent), the turn files the exchange's only
 * `ai_requests` row, and the spoken answer rides on that row.
 *
 * So a speech call that names the turn it is speaking is not checked against
 * the allowance again: an exchange admitted at 9 of 10 has to be able to finish
 * speaking after its own turn took the count to 10. It is accepted only if the
 * row really is that exchange — this family's, this caller's, an assistant
 * turn, and recent — so the id cannot be replayed into free standalone speech.
 * A retry of the same speech call files nothing, so it cannot count twice.
 */

/** The features that file an assistant turn's row. */
export const ASSISTANT_TURN_FEATURES = ['assistant.stream', 'assistant.turn', 'chat.assistant'] as const;

/** How long after its turn a spoken answer may still ride on it. */
export const EXCHANGE_WINDOW_MS = 15 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function isCountedExchange(
  db: SupabaseClient<Database>,
  caller: { familyId: string; userId: string },
  exchangeId: unknown,
  now: Date = new Date(),
): Promise<boolean> {
  if (typeof exchangeId !== 'string' || !UUID.test(exchangeId)) return false;
  const { data, error } = await db
    .from('ai_requests')
    .select('id, family_id, requested_by, feature, created_at')
    .eq('id', exchangeId)
    .maybeSingle();
  if (error || !data) return false;
  if (data.family_id !== caller.familyId || data.requested_by !== caller.userId) return false;
  if (!(ASSISTANT_TURN_FEATURES as readonly string[]).includes(data.feature ?? '')) return false;
  const created = Date.parse(data.created_at as string);
  if (!Number.isFinite(created)) return false;
  const age = now.getTime() - created;
  return age >= -60_000 && age <= EXCHANGE_WINDOW_MS;
}
