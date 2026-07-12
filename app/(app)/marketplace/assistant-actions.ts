'use server';

// The marketplace rail assistant (backlog #11) — server side. Loads the
// family's LIVE market snapshot, then answers in two tiers:
//   1. LLM configured (admin AI engine / key): the model answers with the
//      grounded snapshot digest as its system prompt — real numbers only.
//   2. No key, or any model failure: the deterministic engine
//      (lib/marketplace/assistant.ts) composes the same grounded answer.
// Either way the caller gets a reply + deep links; the UI never breaks on a
// missing key. History is passed through for multi-turn context (LLM tier).
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import {
  answerMarketQuestion, marketSystemPrompt, routeMarketIntent,
  type AssistantLink, type MarketSnapshot,
} from '@/lib/marketplace/assistant';
import { isAIConfigured, resolveProvider, type AIMessage } from '@/lib/ai/provider';

export type MarketAssistantResult = {
  ok: true;
  reply: string;
  links: AssistantLink[];
  /** 'llm' when a configured model answered; 'engine' for the grounded fallback. */
  source: 'llm' | 'engine';
} | { ok: false; error: string };

const MAX_TURNS = 8;

export async function askMarketAssistantAction(
  question: string,
  history: { role: 'user' | 'assistant'; content: string }[] = [],
): Promise<MarketAssistantResult> {
  const q = question.trim().slice(0, 500);
  if (!q) return { ok: false, error: 'Ask me anything about the marketplace' };

  const ctx = await requireUserContext();
  const sb = await createServer();

  const [{ data: listings }, { data: offers }] = await Promise.all([
    sb.from('marketplace_listings')
      .select('id, title, kind, category, condition, price_cents, rent_period, status, member_id')
      .eq('family_id', ctx.active.familyId)
      .limit(600),
    sb.from('marketplace_offers')
      .select('listing_id, status, member_id')
      .eq('family_id', ctx.active.familyId)
      .limit(600),
  ]);

  const snapshot: MarketSnapshot = {
    listings: listings ?? [],
    offers: offers ?? [],
    selfMemberId: ctx.active.member?.id ?? null,
  };

  const grounded = answerMarketQuestion(q, snapshot);

  // Tier 2 (LLM) — best-effort on top of the same snapshot; the deterministic
  // links still ride along so the UI always has somewhere to go.
  try {
    if (await isAIConfigured()) {
      const provider = await resolveProvider();
      const messages: AIMessage[] = [
        ...history.slice(-MAX_TURNS).map((m) => ({ role: m.role, content: m.content } as AIMessage)),
        { role: 'user', content: q },
      ];
      const completion = await provider.complete({
        system: marketSystemPrompt(snapshot),
        messages,
        tools: [],
        maxTokens: 400,
      });
      const text = completion.text.trim();
      if (text) return { ok: true, reply: text, links: grounded.links, source: 'llm' };
    }
  } catch { /* fall through to the grounded engine */ }

  return { ok: true, reply: grounded.reply, links: grounded.links, source: 'engine' };
}

/** Cheap intent preview for analytics/suggestion chips (no data access). */
export async function previewMarketIntentAction(question: string): Promise<string> {
  return routeMarketIntent(question);
}
