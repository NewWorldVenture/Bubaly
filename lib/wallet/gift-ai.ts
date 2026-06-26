// lib/wallet/gift-ai.ts — AI Gift Assistant prompt/parse. PURE + tested.
//
// Helps a relative (often a grandparent) who lands on a public gift link write a
// warm message and pick a thoughtful amount. The route resolves the child +
// occasion + active savings goal, these build the prompt and parse the reply, so
// the logic is unit-tested without a network. No PII beyond the child's first
// name + occasion is ever sent to the model.
import { formatCents } from '@/lib/wallet/ledger';

export type GiftAssistInput = {
  childName: string;
  occasion: string | null;          // birthday | holiday | graduation | just_because | null
  relationship: string | null;      // e.g. "Grandma", "Uncle" — free text from the giver, optional
  goalTitle: string | null;         // the child's top active savings goal, if any
  goalSavedCents: number | null;
  goalTargetCents: number | null;
};

export type GiftSuggestions = {
  /** A few ready-to-send warm messages the giver can tap to use. */
  messages: string[];
  /** Suggested gift amounts in cents (giver can still choose their own). */
  amountsCents: number[];
};

/** Sane bounds so a model can never suggest a weird/huge amount on a public page. */
export const MIN_GIFT_CENTS = 500;       // $5
export const MAX_GIFT_CENTS = 50000;     // $500

function occasionPhrase(occasion: string | null): string {
  switch (occasion) {
    case 'birthday': return 'a birthday';
    case 'holiday': return 'the holidays';
    case 'graduation': return 'a graduation';
    case 'just_because': return 'no special reason — just because';
    default: return 'a gift';
  }
}

export function buildGiftAssistPrompt(input: GiftAssistInput): { system: string; user: string } {
  const system = `You are the Bubaly Gift Assistant. You help someone (often a grandparent or relative) send a warm, personal money gift to a child through a family wallet. Return STRUCTURED JSON only (no markdown, no code fences). Start with { end with }.

Shape:
{
  "messages": ["a short warm note (1-2 sentences) the giver can send", "a second option with a different tone", "a third"],
  "amounts": [number, number, number]
}

Rules:
- 3 message options, each under 220 characters, heartfelt and natural — never corporate.
- Use the child's first name. Reference the occasion. If a savings goal is given, you MAY encourage it kindly ("toward your bike!") but never pressure.
- "amounts" are 3 whole-dollar US amounts (as integers, in dollars) appropriate for the occasion — modest and tasteful, between 5 and 500.
- No financial/investment advice. No promises. Family-friendly.`;

  const goalLine = input.goalTitle && input.goalTargetCents
    ? `Saving toward: "${input.goalTitle}" (${formatCents(input.goalSavedCents ?? 0)} of ${formatCents(input.goalTargetCents)})`
    : 'Saving toward: (no goal shared)';
  const fromLine = input.relationship ? `From: ${input.relationship}` : 'From: a loving relative';

  const user = `Child's first name: ${input.childName}
Occasion: ${occasionPhrase(input.occasion)}
${fromLine}
${goalLine}

Return the gift suggestions JSON now.`;
  return { system, user };
}

function clampDollarsToCents(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n) * 100;
  if (cents < MIN_GIFT_CENTS || cents > MAX_GIFT_CENTS) return null;
  return cents;
}

export function parseGiftSuggestions(raw: string): GiftSuggestions {
  const empty: GiftSuggestions = { messages: [], amountsCents: [] };
  if (!raw || typeof raw !== 'string') return empty;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(match[0]) as Record<string, unknown>; } catch { return empty; }

  const messages = Array.isArray(parsed.messages)
    ? parsed.messages
        .map((m) => (typeof m === 'string' ? m.trim() : ''))
        .filter((m) => m.length > 0 && m.length <= 280)
        .slice(0, 3)
    : [];

  const amountsCents = Array.isArray(parsed.amounts)
    ? Array.from(new Set(parsed.amounts.map(clampDollarsToCents).filter((c): c is number => c !== null))).slice(0, 3)
    : [];

  return { messages, amountsCents };
}
