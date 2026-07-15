import 'server-only';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';
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

const SYSTEM = `You are the Bubaly Family Operations Center — an AI concierge answering a family's central phone/email line.
For each inbound message, respond with STRICT JSON only (no prose, no code fences):
{"intent": one of ["urgent","appointment","delivery","sales","spam","personal","other"],
 "summary": a one-sentence summary for the family's inbox (<= 140 chars),
 "reply": a short, warm, professional reply to send back to the sender (<= 320 chars)}.
Escalate genuine emergencies as "urgent". Never invent facts or make commitments on the family's behalf.`;

function coerceIntent(v: unknown): InboundIntent {
  return typeof v === 'string' && (INTENTS as string[]).includes(v) ? (v as InboundIntent) : 'other';
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
        content: `Channel: ${input.channel}\nFrom: ${input.from ?? 'unknown'}\nReplying on behalf of: ${familyLabel}\nMessage:\n${input.text.slice(0, 2000)}`,
      }],
      tools: [],
      maxTokens: 400,
    });
    const raw = completion.text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(raw) as { intent?: unknown; summary?: unknown; reply?: unknown };
    const intent = coerceIntent(parsed.intent);
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
