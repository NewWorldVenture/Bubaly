import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { refuseUnlessEntitled } from '@/lib/server/route-feature-gate';
import { resolveProvider, isAIConfigured, describeAIError } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { TRADES } from '@/lib/home/maintenance';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * AI contractor-sourcing guidance. We do NOT have a live contractor marketplace
 * API, so we never fabricate specific businesses. Instead we return expert
 * guidance for hiring the right pro: questions to ask, typical cost range, red
 * flags, and how to verify licensing/insurance — plus a ready-to-use search query.
 * The user can then save real contractors they find into home_contractors.
 */
export async function POST(req: Request) {
  const tr = await getTranslations();
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: tr('findPro.unauthorized') }, { status: 401 }); }
  const supabase = await createServer();
  // The page in front of this is feature-gated; this endpoint was not, and it
  // calls a model. Same resolver, so the two cannot disagree.
  const refused = await refuseUnlessEntitled(supabase, ctx.active.familyId, ['/dashboard/home']);
  if (refused) return refused;
  const limited = await enforceAIRateLimit(supabase, `ai-home-find-pro:${ctx.user.id}`, { limit: 15 });
  if (!limited.ok) return NextResponse.json(
    { error: tr('findPro.tooManyContractorGuidanceRequests') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );
  if (!(await isAIConfigured())) {
    return NextResponse.json({ error: tr('findPro.aiIsNotConfiguredOpenai') }, { status: 503 });
  }

  const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_SMALL_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: tr('findPro.requestBodyIsTooLarge') }, { status: 400 });
  const body = (boundedBody.value ?? {}) as Record<string, unknown>;
  const trade = String(body.trade ?? '').slice(0, 40);
  const job = String(body.job ?? '').slice(0, 600).trim();
  const location = String(body.location ?? '').slice(0, 80).trim();
  const tradeLabel = TRADES.find((t) => t.value === trade)?.label ?? trade ?? 'a contractor';
  if (!trade && !job) return NextResponse.json({ error: tr('findPro.pickATradeOrDescribe') }, { status: 400 });

  const system =
    'You are a savvy homeowner advocate helping someone hire a contractor. Never invent specific company names, ' +
    'phone numbers, or reviews — you do not have live local data. Give plain-text guidance with sections:\n' +
    'WHAT TO LOOK FOR: 2–3 bullets (licensing, insurance, specialization).\n' +
    'QUESTIONS TO ASK: 3–4 bullets.\n' +
    'TYPICAL COST RANGE: a rough national range with the caveat it varies by region.\n' +
    'RED FLAGS: 2–3 bullets.\n' +
    'Keep it tight and actionable.';

  const userMsg = `Trade: ${tradeLabel}\nJob: ${job || 'general work'}${location ? `\nArea: ${location}` : ''}`;

  let text: string;
  try {
    text = await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: 'home.find-pro', text: `Hire ${tradeLabel}` },
      async (obs) => {
        const completion = await (await resolveProvider()).complete({ system, messages: [{ role: 'user', content: userMsg }], tools: [] });
        obs.used(completion.model ?? 'unknown', completion.usage);
        return completion.text.trim();
      },
    );
  } catch (err) {
    console.error('Find-a-pro assistant error:', err);
    return NextResponse.json({ error: describeAIError(err).message }, { status: 503 });
  }

  // A real, clickable search the user can run to find local, vetted pros.
  const q = encodeURIComponent(`${tradeLabel} ${job ? job + ' ' : ''}near ${location || 'me'}`);
  const searchUrl = `https://www.google.com/search?q=${q}`;

  // Its result used to be discarded outright — not even the error bound. Best-effort, so logged rather than raised. Audit C1-S9-76.
  const { error: homeAiLogsWriteError } = await supabase.from('home_ai_logs').insert({
    family_id: ctx.active.familyId, user_id: ctx.user.id, kind: 'find_pro',
    input: { trade, job, location }, output: { text }, created_by: ctx.user.id,
  });
  if (homeAiLogsWriteError) console.error('[home-find-pro] home_ai_logs insert failed', homeAiLogsWriteError);

  return NextResponse.json({ text, searchUrl, tradeLabel });
}
