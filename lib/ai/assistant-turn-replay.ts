// A retried assistant turn is the same turn (F19, owner decision on #771 and
// review 5393250792 on #788). The client sends one key per logical send and
// keeps it across retries; the turn's `ai_requests` row stores it under the
// (family_id, client_request_id) unique index from 0255. Before the allowance
// is checked, the route asks here whether that key already filed a turn:
//
//   • none        → a new turn: checked against the allowance and counted.
//   • answered    → replay the saved answer; no model, no tools, no new row.
//                   `partial` when the answer was cut off (partially_completed),
//                   so the replay can say so as the first attempt did.
//   • in_progress → the first attempt is still running; refuse, count nothing.
//   • failed      → the first attempt ended without an answer; refuse, count
//                   nothing. Sending again is a new send with a new key.
//
// The turn's SAVED EXCHANGE decides before its row's status does (#875 review
// 5970538108). The user and assistant messages are written together, in one
// insert, after every tool has run and the answer is final; the row is
// settled later, by the wrapper. A process that died between the two, or a
// retry that arrived in that window, left an answered turn reading "still
// running" for ever. And a stream that broke and fell back could leave its
// row `failed` over an answer it saved. A matching saved pair is an answer,
// whatever the row says, and is replayed — never run again. Whether it was
// cut off is read from the answer itself (`structured_content.responseError`,
// saved by both transports when a stream breaks).
//   • mismatch    → the key belongs to another member, conversation, surface
//                   or message; refuse rather than replay someone else's turn.
//
// Two attempts that race past this lookup together are still one turn: the
// unique index lets one INSERT win and `withAiRequest` throws
// `AiRequestDuplicate` for the other before its model call.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { ASSISTANT_TURN_FEATURES } from '@/lib/ai/voice-exchange';
import { structuredContentFrom } from '@/lib/ai/result-cards';

type DB = SupabaseClient<Database>;

/** Stored form of a turn key, so it can never match a concierge intake's own key. */
export function assistantTurnRequestKey(key: string): string {
  return `assistant:${key}`;
}

export type PriorTurn =
  | { kind: 'none' }
  | { kind: 'unreadable' }
  | { kind: 'mismatch' }
  | { kind: 'in_progress'; requestId: string }
  | { kind: 'failed'; requestId: string }
  | { kind: 'answered'; requestId: string; content: string | null; partial: boolean };

const ANSWERED = new Set(['completed', 'partially_completed']);
const ENDED_WITHOUT_ANSWER = new Set(['failed', 'cancelled', 'blocked']);

export async function findPriorTurn(
  db: DB,
  caller: { familyId: string; userId: string; conversationId: string; message: string },
  key: string,
): Promise<PriorTurn> {
  const { data: row, error } = await db
    .from('ai_requests')
    .select('id, requested_by, feature, conversation_id, status')
    .eq('family_id', caller.familyId)
    .eq('client_request_id', assistantTurnRequestKey(key))
    .maybeSingle();
  if (error) {
    console.error('[assistant-turn-replay] prior turn read failed', error);
    return { kind: 'unreadable' };
  }
  if (!row) return { kind: 'none' };
  if (row.requested_by !== caller.userId || row.conversation_id !== caller.conversationId
    || !(ASSISTANT_TURN_FEATURES as readonly string[]).includes(row.feature ?? '')) {
    return { kind: 'mismatch' };
  }
  const settled = ANSWERED.has(row.status);
  const unanswered = (): PriorTurn => (ENDED_WITHOUT_ANSWER.has(row.status)
    ? { kind: 'failed', requestId: row.id }
    : { kind: 'in_progress', requestId: row.id });

  // The turn's own exchange, bound to it by `request_id` (0250): the first
  // user and assistant messages saved with this request's id, never a pair
  // found by time or position (#788 release review 5964060680). Rows saved
  // before turns carried the id have none, and read as an unsaved answer.
  const { data: messages, error: messagesError } = await db
    .from('ai_messages')
    .select('role, content, conversation_id, structured_content')
    .eq('family_id', caller.familyId)
    .eq('request_id', row.id)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(10);
  if (messagesError) {
    console.error('[assistant-turn-replay] saved answer read failed', messagesError);
    // Unread is not unsaved: an unsettled turn stays "in progress" (refused,
    // nothing run) rather than being called answered or failed.
    return settled ? { kind: 'answered', requestId: row.id, content: null, partial: row.status === 'partially_completed' } : unanswered();
  }
  const own = (messages ?? []).filter((m) => m.conversation_id === caller.conversationId);
  const asked = own.find((m) => m.role === 'user');
  // The key was sent with different words: not a retry of that turn.
  if (asked && asked.content.trim() !== caller.message.trim()) return { kind: 'mismatch' };
  const answer = own.find((m) => m.role === 'assistant');
  if (asked && answer) {
    const cutOff = Boolean(structuredContentFrom(answer.structured_content).responseError);
    return { kind: 'answered', requestId: row.id, content: answer.content, partial: row.status === 'partially_completed' || cutOff };
  }
  if (!settled) return unanswered();
  // Settled as answered with no saved exchange: a partial row here is a turn
  // whose answer could not be saved (its actions already ran).
  return { kind: 'answered', requestId: row.id, content: answer?.content ?? null, partial: row.status === 'partially_completed' };
}
