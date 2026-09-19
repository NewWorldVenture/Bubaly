import 'server-only';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';
import { fenceUntrustedBlock, UNTRUSTED_CONTENT_RULE } from '@/lib/ai/safety/untrusted';
import { resolveInboundEntityContext } from '@/lib/graph/resolve-server';
import type { ServiceScope } from '@/lib/services/types';
import {
  classifyIntent, summarizeInbound, autoReplyText,
  type InboundIntent, type InboundChannel,
} from './routing';

export type ConciergeResult = {
  intent: InboundIntent;
  summary: string;
  reply: string;
  aiUsed: boolean;
};

const INTENTS: InboundIntent[] = ['urgent', 'appointment', 'delivery', 'sales', 'spam', 'personal', 'other'];

/** Internal filing context only. Known household names and aliases are never
 * added to the externally addressed auto-reply prompt below. */
export function resolveConciergeEntities(scope: ServiceScope, input: { text: string; sender?: string | null }) {
  return resolveInboundEntityContext(scope, input);
}

const SYSTEM = `You are the Bubaly Family Operations Center — an AI concierge answering a family's central phone/email line.
For each inbound message, respond with STRICT JSON only (no prose, no code fences):
{"intent": one of ["urgent","appointment","delivery","sales","spam","personal","other"],
 "summary": a one-sentence summary for the family's inbox (<= 140 chars),
 "reply": a short, warm, professional reply to send back to the sender (<= 320 chars)}.
Escalate genuine emergencies as "urgent". Never invent facts or make commitments on the family's behalf.

${UNTRUSTED_CONTENT_RULE}`;

function coerceIntent(v: unknown): InboundIntent {
  return typeof v === 'string' && (INTENTS as string[]).includes(v) ? (v as InboundIntent) : 'other';
}

/**
 * The model is never offered "school" or "sports" (see SYSTEM above), so the
 * best it can say about a permission slip is "other" — and taking that at face
 * value threw away the deterministic front-desk verdict, which is the only
 * thing that files a school notice as school work. It defers ONLY to those two
 * and ONLY when the model reached for the generic bucket; every other answer
 * the model gives still wins, exactly as before.
 */
export function preferFrontDesk(modelIntent: InboundIntent, fallback: InboundIntent): InboundIntent {
  const deskVerdict = fallback === 'school' || fallback === 'sports';
  return modelIntent === 'other' && deskVerdict ? fallback : modelIntent;
}

/**
 * Run the concierge over an inbound message. Uses the AI provider when
 * configured; otherwise (or on any error) falls back to the deterministic
 * routing lib so the line always answers. Never throws.
 */
export async function runConcierge(input: {
  channel: InboundChannel; from?: string; text: string; familyLabel?: string;
}): Promise<ConciergeResult> {
  const familyLabel = input.familyLabel || 'the family';
  const fallbackIntent = classifyIntent(input.text);
  const fallback: ConciergeResult = {
    intent: fallbackIntent,
    summary: summarizeInbound(input.text),
    reply: autoReplyText(fallbackIntent, familyLabel),
    aiUsed: false,
  };

  if (!(await isAIConfigured())) return fallback;
  try {
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system: SYSTEM,
      messages: [{
        role: 'user',
        // The message body and the sender's number come from a stranger — this
        // line answers texts, emails and voicemail transcripts from anyone who
        // knows the family's number. `lib/guardian/scam-ai.ts` handles the same
        // class of input and says so in its own header ("the transcript is
        // ATTACKER-CONTROLLED (an inbound caller / SMS)"), fencing it with a
        // random nonce and telling the model the fence contains data. This did
        // not, and its output is not cosmetic: `summary` is delivered to the
        // family's real phone as "🚨 Urgent at your Bubaly line: …". Audit C1-S7-03.
        content: `Channel: ${input.channel}\nReplying on behalf of: ${familyLabel}\n`
          + `From: ${fenceUntrustedBlock('inbound_from', input.from ?? 'unknown', 64)}\n`
          + `Message:\n${fenceUntrustedBlock('inbound_message', input.text, 2000)}`,
      }],
      tools: [],
      maxTokens: 400,
    });
    const raw = completion.text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(raw) as { intent?: unknown; summary?: unknown; reply?: unknown };
    const intent = preferFrontDesk(coerceIntent(parsed.intent), fallbackIntent);
    return {
      intent,
      summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim().slice(0, 140) : fallback.summary,
      reply: typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim().slice(0, 320) : autoReplyText(intent, familyLabel),
      aiUsed: true,
    };
  } catch (e) {
    console.error('[contact-center] concierge AI failed, using deterministic fallback', e);
    return fallback;
  }
}
