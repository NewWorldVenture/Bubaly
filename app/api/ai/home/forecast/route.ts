import { NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * AI maintenance forecasting: a narrative, budget-aware outlook across the home's
 * assets (aging systems, what to plan/save for, seasonal priorities). The exact
 * recurring tasks are scheduled deterministically elsewhere (DEFAULT_CADENCES);
 * this adds the human judgement layer. Grounded only in the asset list provided.
 */
export async function POST(req: Request) {
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }
  const supabase = await createServer();
  const limited = await enforceAIRateLimit(supabase, `ai-home-forecast:${ctx.user.id}`, { limit: 10 });
  if (!limited.ok) return NextResponse.json(
    { error: 'Too many maintenance-forecast requests. Please try again shortly.' },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );
  if (!(await isAIConfigured())) {
    return NextResponse.json({ error: 'AI is not configured (OpenAI API key missing).' }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const assets = Array.isArray(body.assets) ? body.assets.slice(0, 40) : [];
  if (assets.length === 0) return NextResponse.json({ error: 'Add some home assets first to forecast maintenance.' }, { status: 400 });

  const lines = assets.map((a: Record<string, unknown>) => {
    const parts = [String(a.name ?? a.category ?? 'item')];
    if (a.category) parts.push(`[${a.category}]`);
    if (a.ageYears != null) parts.push(`~${a.ageYears}y old`);
    if (a.expectedLife != null) parts.push(`life ~${a.expectedLife}y`);
    if (a.lastServiced) parts.push(`last serviced ${a.lastServiced}`);
    return '- ' + parts.join(' ');
  }).join('\n');

  const system =
    'You are a home-maintenance advisor. Given a homeowner\'s assets with ages and expected lifespans, write a brief, ' +
    'practical 12-month outlook. Sections (plain text):\n' +
    'PLAN & BUDGET: 2–4 bullets on big-ticket items nearing end of life and rough cost ranges to start saving for.\n' +
    'NEXT 90 DAYS: 3–5 concrete maintenance actions, most important first.\n' +
    'WATCH: 1–3 items to keep an eye on.\n' +
    'Use ONLY the assets listed. Don\'t invent brands or exact prices beyond typical ranges.';

  let text: string;
  try {
    const completion = await (await resolveProvider()).complete({ system, messages: [{ role: 'user', content: `Home assets:\n${lines}` }], tools: [] });
    text = completion.text.trim();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'AI request failed' }, { status: 503 });
  }

  await supabase.from('home_ai_logs').insert({
    family_id: ctx.active.familyId, user_id: ctx.user.id, kind: 'forecast',
    input: { count: assets.length }, output: { text }, created_by: ctx.user.id,
  });

  return NextResponse.json({ text });
}
