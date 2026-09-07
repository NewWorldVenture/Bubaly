import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { resolveProvider, isAIConfigured, describeAIError } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { TRADE_FOR_CATEGORY, TRADES } from '@/lib/home/maintenance';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * AI repair diagnosis. Given an appliance/system and a described symptom, returns
 * likely causes, safe DIY checks, an urgency read, and which trade to call. The
 * recommended trade is derived deterministically from the asset category so the
 * "find a pro" hand-off is always reliable. Grounded only in what the user gave.
 */
export async function POST(req: Request) {
  const tr = await getTranslations();
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: tr('diagnose.unauthorized') }, { status: 401 }); }
  const supabase = await createServer();
  const limited = await enforceAIRateLimit(supabase, `ai-home-diagnose:${ctx.user.id}`, { limit: 15 });
  if (!limited.ok) return NextResponse.json(
    { error: tr('diagnose.tooManyDiagnosisRequestsPlease') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );
  if (!(await isAIConfigured())) {
    return NextResponse.json({ error: tr('diagnose.aiIsNotConfiguredOpenai') }, { status: 503 });
  }

  const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_SMALL_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: tr('diagnose.requestBodyIsTooLarge') }, { status: 400 });
  const body = (boundedBody.value ?? {}) as Record<string, unknown>;
  const assetName = String(body.assetName ?? '').slice(0, 120);
  const category = String(body.category ?? '').slice(0, 40);
  const brand = String(body.brand ?? '').slice(0, 60);
  const model = String(body.model ?? '').slice(0, 60);
  const symptom = String(body.symptom ?? '').slice(0, 1500).trim();
  const assetId = typeof body.assetId === 'string' ? body.assetId : null;
  if (!symptom) return NextResponse.json({ error: tr('diagnose.describeTheProblemFirst') }, { status: 400 });

  const trade = TRADE_FOR_CATEGORY[category] ?? 'general';
  const tradeLabel = TRADES.find((t) => t.value === trade)?.label ?? 'General / Handyman';

  const system =
    'You are a seasoned home-systems and appliance repair technician helping a homeowner triage a problem. ' +
    'Be practical and safety-first. Use ONLY the details provided; never invent model specifics. ' +
    'Respond in plain text with these short sections, each on its own lines:\n' +
    'LIKELY CAUSES: 2–4 bullet points (most likely first).\n' +
    'SAFE DIY CHECKS: 2–4 bullets a homeowner can safely try.\n' +
    'URGENCY: one of low / medium / high, plus a 1-line reason.\n' +
    'CALL A PRO IF: 1–2 bullets describing when to stop and call someone.\n' +
    'Never advise unsafe gas, high-voltage, or structural work — defer those to a licensed pro.';

  const userMsg =
    `Item: ${assetName || category || 'home item'}${brand ? ` (${brand}${model ? ' ' + model : ''})` : ''}\n` +
    `Category: ${category || 'unknown'}\nSymptom: ${symptom}`;

  let text: string;
  try {
    text = await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: 'home.diagnose', text: `Diagnose ${assetName || category || 'home item'}` },
      async (obs) => {
        const completion = await (await resolveProvider()).complete({ system, messages: [{ role: 'user', content: userMsg }], tools: [] });
        obs.used(completion.model ?? 'unknown', completion.usage);
        return completion.text.trim();
      },
    );
  } catch (err) {
    console.error('Home diagnosis error:', err);
    return NextResponse.json({ error: describeAIError(err).message }, { status: 503 });
  }

  // Persist for history/audit.
  await supabase.from('home_ai_logs').insert({
    family_id: ctx.active.familyId, user_id: ctx.user.id, asset_id: assetId, kind: 'diagnose',
    input: { assetName, category, brand, model, symptom }, output: { text, trade }, created_by: ctx.user.id,
  });

  return NextResponse.json({ text, recommendedTrade: trade, recommendedTradeLabel: tradeLabel });
}
