import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { prepareSpeechText } from '@/lib/ai/voice';

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
 * turn, and recent — and the text being spoken is that turn's own answer, as
 * saved in its conversation. A valid id cannot carry unrelated text: speech of
 * anything else is standalone and checked against the allowance like any other.
 * A retry of the same spoken answer files nothing, so it cannot count twice.
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
  speech: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (typeof exchangeId !== 'string' || !UUID.test(exchangeId)) return false;
  const spoken = prepareSpeechText(speech);
  if (!spoken) return false;
  const { data, error } = await db
    .from('ai_requests')
    .select('id, family_id, requested_by, feature, conversation_id, created_at')
    .eq('id', exchangeId)
    .maybeSingle();
  if (error || !data) return false;
  if (data.family_id !== caller.familyId || data.requested_by !== caller.userId) return false;
  if (!(ASSISTANT_TURN_FEATURES as readonly string[]).includes(data.feature ?? '')) return false;
  if (!data.conversation_id) return false;
  const created = Date.parse(data.created_at as string);
  if (!Number.isFinite(created)) return false;
  const age = now.getTime() - created;
  if (age < -60_000 || age > EXCHANGE_WINDOW_MS) return false;

  // The turn's own answer: an assistant message saved in that conversation
  // since the turn began. If the answer was not saved, nothing can be matched
  // and the speech is standalone — the safe side of a failed persist.
  const { data: answers, error: answersError } = await db
    .from('ai_messages')
    .select('content')
    .eq('family_id', caller.familyId)
    .eq('conversation_id', data.conversation_id)
    .eq('role', 'assistant')
    .gte('created_at', new Date(created - 60_000).toISOString())
    .limit(5);
  if (answersError || !Array.isArray(answers)) return false;
  return answers.some((a) => typeof a.content === 'string' && prepareSpeechText(a.content) === spoken);
}
