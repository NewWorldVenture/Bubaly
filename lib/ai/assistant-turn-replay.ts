// A retried assistant turn is the same turn (F19, owner decision on #771 and
// review 5393250792 on #788). The client sends one key per logical send and
// keeps it across retries; the turn's `ai_requests` row stores it under the
// (family_id, client_request_id) unique index from 0255. Before the allowance
// is checked, the route asks here whether that key already filed a turn:
//
//   • none        → a new turn: checked against the allowance and counted.
//   • answered    → replay the saved answer; no model, no tools, no new row.
//   • in_progress → the first attempt is still running; refuse, count nothing.
//   • failed      → the first attempt ended without an answer; refuse, count
//                   nothing. Sending again is a new send with a new key.
//   • mismatch    → the key belongs to another member, conversation, surface
//                   or message; refuse rather than replay someone else's turn.
//
// Two attempts that race past this lookup together are still one turn: the
// unique index lets one INSERT win and `withAiRequest` throws
// `AiRequestDuplicate` for the other before its model call.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { ASSISTANT_TURN_FEATURES } from '@/lib/ai/voice-exchange';

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
  | { kind: 'answered'; requestId: string; content: string | null };

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
  if (ENDED_WITHOUT_ANSWER.has(row.status)) return { kind: 'failed', requestId: row.id };
  if (!ANSWERED.has(row.status)) return { kind: 'in_progress', requestId: row.id };

  // The turn's own exchange, bound to it by `request_id` (0250): the first
  // user and assistant messages saved with this request's id, never a pair
  // found by time or position (#788 release review 5964060680). Rows saved
  // before turns carried the id have none, and read as an unsaved answer.
  const { data: messages, error: messagesError } = await db
    .from('ai_messages')
    .select('role, content, conversation_id')
    .eq('family_id', caller.familyId)
    .eq('request_id', row.id)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(10);
  if (messagesError) {
    console.error('[assistant-turn-replay] saved answer read failed', messagesError);
    return { kind: 'answered', requestId: row.id, content: null };
  }
  const own = (messages ?? []).filter((m) => m.conversation_id === caller.conversationId);
  const asked = own.find((m) => m.role === 'user');
  // The key was sent with different words: not a retry of that turn.
  if (asked && asked.content.trim() !== caller.message.trim()) return { kind: 'mismatch' };
  const answer = own.find((m) => m.role === 'assistant');
  return { kind: 'answered', requestId: row.id, content: answer?.content ?? null };
}
