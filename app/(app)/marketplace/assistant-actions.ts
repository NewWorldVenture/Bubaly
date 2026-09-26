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
import { settleAll } from '@/lib/supabase/settle';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import {
  answerMarketQuestion, marketSystemPrompt, routeMarketIntent,
  type AssistantLink, type MarketSnapshot,
} from '@/lib/marketplace/assistant';
import { isAIConfigured, resolveProvider, type AIMessage } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';

export type MarketAssistantResult = {
  ok: true;
  reply: string;
  links: AssistantLink[];
  /** 'llm' when a configured model answered; 'engine' for the grounded fallback. */
  source: 'llm' | 'engine';
} | { ok: false; error: string };

const MAX_TURNS = 8;
/** Matches the inbox intake's budget — see app/(app)/dashboard/inbox/actions.ts. */
const REQUEST_RATE_LIMIT = { limit: 20, windowMs: 60_000 } as const;
/** Each history turn is caller-supplied; the question beside it is capped at 500. */
const MAX_TURN_CHARS = 2_000;

export async function askMarketAssistantAction(
  question: string,
  history: { role: 'user' | 'assistant'; content: string }[] = [],
): Promise<MarketAssistantResult> {
  const t = await getTranslations();
  const q = question.trim().slice(0, 500);
  if (!q) return { ok: false, error: t('assistantActions.askMeAnythingAboutThe') };

  const ctx = await requireUserContext();
  const sb = await createServer();

  // Every one of the 31 API routes that reaches the model is rate-limited, and
  // so is the inbox intake — the same request, filed as an action. This one was
  // not, which made it an unmetered door to a paid provider. Audit C3-S4-01.
  const limited = await enforceAIRateLimit(sb, `ai-requests:${ctx.user.id}`, REQUEST_RATE_LIMIT);
  // Reuses the inbox intake's existing key rather than inventing one across 11
  // catalogues — an unresolved key renders as the raw key on screen.
  if (!limited.ok) return { ok: false, error: t('inboxActions.tooManyRequestsRightNow') };

  const [{ data: listings }, { data: offers }] = await settleAll([
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
      // Two ways this ends at `source: 'engine'` — the provider threw, or it
      // answered with nothing usable — and the shopper sees the same
      // deterministic reply either way, which is also what "no API key" looks
      // like. The wrapper sits inside the swallow so the row separates them.
      const text = await withAiRequest(
        scopeFromUserContext(ctx, sb),
        { feature: 'marketplace.assistant', text: q.slice(0, 200) },
        async (obs) => {
          const provider = await resolveProvider();
          const messages: AIMessage[] = [
            ...history.slice(-MAX_TURNS).map((m) => ({ role: m.role, content: String(m.content ?? '').slice(0, MAX_TURN_CHARS) } as AIMessage)),
            { role: 'user', content: q },
          ];
          const completion = await provider.complete({
            system: marketSystemPrompt(snapshot),
            messages,
            tools: [],
            maxTokens: 400,
          });
          obs.used(provider.model, completion.usage);
          const out = completion.text.trim();
          if (!out) obs.failed(new Error('The marketplace assistant returned nothing; fell back to the grounded engine.'));
          return out;
        },
      );
      if (text) return { ok: true, reply: text, links: grounded.links, source: 'llm' };
    }
  } catch { /* fall through to the grounded engine */ }

  return { ok: true, reply: grounded.reply, links: grounded.links, source: 'engine' };
}

