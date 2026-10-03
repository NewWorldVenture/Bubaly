// The HTTP answer to a send whose retry key already filed a turn, shared by
// both assistant entry points (`/api/ai` and `/api/ai/chat`) so a retry reads
// the same way on either. See lib/ai/assistant-turn-replay.ts for the lookup.
import 'server-only';
import { NextResponse } from 'next/server';
import { SSE_HEADERS } from '@/lib/ai/assistant-engine';
import type { PriorTurn } from '@/lib/ai/assistant-turn-replay';

/**
 * The answer to a send whose key already filed a turn. An answered turn is
 * replayed in the transport the client asked for — the stream ends with the
 * same `done` (and request id, so speaking it rides on the same exchange) —
 * and everything else is a 409 that counts nothing.
 *
 * A turn whose answer was cut off (`partially_completed`) replays the same
 * way its first attempt ended: the saved half answer, then an `error`, then
 * `done`. In JSON it stays a 200 replay but says `partial: true` with the
 * error, so neither transport presents half an answer as a whole one.
 */
export function answerPriorTurn(
  prior: Exclude<PriorTurn, { kind: 'none' }>,
  opts: { conversationId: string; json: boolean; tr: (key: string) => string },
): Response {
  const { conversationId, json, tr } = opts;
  if (prior.kind === 'unreadable') {
    return NextResponse.json({ error: tr('ai.accountContextIsTemporarilyUnavailable'), code: 'unavailable' }, { status: 503 });
  }
  if (prior.kind === 'mismatch') {
    return NextResponse.json({ error: tr('ai.thatRetryDoesNotMatchThisMessage'), code: 'client_request_id_conflict' }, { status: 409 });
  }
  if (prior.kind === 'in_progress') {
    return NextResponse.json({ error: tr('ai.thisMessageIsAlreadyBeingAnswered'), code: 'turn_in_progress', requestId: prior.requestId }, { status: 409 });
  }
  if (prior.kind === 'failed') {
    return NextResponse.json({ error: tr('ai.thatAttemptDidNotFinish'), code: 'turn_failed', requestId: prior.requestId }, { status: 409 });
  }
  if (prior.content === null) {
    return NextResponse.json({ error: tr('ai.thisMessageWasAlreadyAnswered'), code: 'turn_answered', requestId: prior.requestId }, { status: 409 });
  }
  const cutOff = prior.partial ? tr('ai.thatAnswerWasCutOff') : null;
  if (json) {
    return NextResponse.json({
      conversationId, content: prior.content, actions: [], cards: [], runIds: [], persisted: true,
      replayed: true, requestId: prior.requestId,
      ...(cutOff ? { partial: true, error: cutOff } : {}),
    });
  }
  const encoder = new TextEncoder();
  const events = [
    { type: 'delta', text: prior.content },
    ...(cutOff ? [{ type: 'error', error: cutOff }] : []),
    { type: 'done', content: prior.content, persisted: true, requestId: prior.requestId },
  ];
  return new Response(encoder.encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')), { headers: SSE_HEADERS });
}
