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
 * turn, and recent — and the text being spoken is that turn's own answer:
 * the assistant message saved with that request's id (0250
 * `ai_messages.request_id`), never one matched by time or by position in the
 * conversation (#788 release review 5964060680). A valid id cannot carry unrelated text: speech of
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

  const answer = await savedAnswerOf(db, { familyId: caller.familyId, conversationId: data.conversation_id }, data.id);
  return answer !== null && prepareSpeechText(answer) === spoken;
}

/**
 * The answer a turn saved, bound to it by `request_id`. The turn saves it
 * before `done` hands the client the id, so the EARLIEST assistant message
 * carrying that id is the genuine one; a row a member inserted later with the
 * same id (members may write their own conversation) cannot displace it. Null
 * when the turn saved no answer: then nothing can ride on it.
 */
export async function savedAnswerOf(
  db: SupabaseClient<Database>,
  turn: { familyId: string; conversationId: string },
  requestId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('ai_messages')
    .select('content, conversation_id')
    .eq('family_id', turn.familyId)
    .eq('request_id', requestId)
    .eq('role', 'assistant')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1);
  if (error || !Array.isArray(data) || !data[0]) return null;
  const [first] = data;
  if (first.conversation_id !== turn.conversationId || typeof first.content !== 'string') return null;
  return first.content;
}
