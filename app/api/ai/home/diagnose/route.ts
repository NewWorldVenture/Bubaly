import { NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';
import { TRADE_FOR_CATEGORY, TRADES } from '@/lib/home/maintenance';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * AI repair diagnosis. Given an appliance/system and a described symptom, returns
 * likely causes, safe DIY checks, an urgency read, and which trade to call. The
 * recommended trade is derived deterministically from the asset category so the
 * "find a pro" hand-off is always reliable. Grounded only in what the user gave.
 */
export async function POST(req: Request) {
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }
  const supabase = await createServer();
  const limited = await enforceAIRateLimit(supabase, `ai-home-diagnose:${ctx.user.id}`, { limit: 15 });
  if (!limited.ok) return NextResponse.json(
    { error: 'Too many diagnosis requests. Please try again shortly.' },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );
  if (!(await isAIConfigured())) {
    return NextResponse.json({ error: 'AI is not configured (OpenAI API key missing).' }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const assetName = String(body.assetName ?? '').slice(0, 120);
  const category = String(body.category ?? '').slice(0, 40);
  const brand = String(body.brand ?? '').slice(0, 60);
  const model = String(body.model ?? '').slice(0, 60);
  const symptom = String(body.symptom ?? '').slice(0, 1500).trim();
  const assetId = typeof body.assetId === 'string' ? body.assetId : null;
  if (!symptom) return NextResponse.json({ error: 'Describe the problem first.' }, { status: 400 });

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
    const completion = await (await resolveProvider()).complete({ system, messages: [{ role: 'user', content: userMsg }], tools: [] });
    text = completion.text.trim();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'AI request failed' }, { status: 503 });
  }

  // Persist for history/audit.
  await supabase.from('home_ai_logs').insert({
    family_id: ctx.active.familyId, user_id: ctx.user.id, asset_id: assetId, kind: 'diagnose',
    input: { assetName, category, brand, model, symptom }, output: { text, trade }, created_by: ctx.user.id,
  });

  return NextResponse.json({ text, recommendedTrade: trade, recommendedTradeLabel: tradeLabel });
}
