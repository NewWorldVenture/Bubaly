import { NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { resolveProvider } from '@/lib/ai/provider';
import { TRADES } from '@/lib/home/maintenance';

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
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }
  if (!process.env.ANTHROPIC_API_KEY && (process.env.AI_PROVIDER ?? 'anthropic') === 'anthropic') {
    return NextResponse.json({ error: 'AI is not configured (ANTHROPIC_API_KEY missing).' }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const trade = String(body.trade ?? '').slice(0, 40);
  const job = String(body.job ?? '').slice(0, 600).trim();
  const location = String(body.location ?? '').slice(0, 80).trim();
  const tradeLabel = TRADES.find((t) => t.value === trade)?.label ?? trade ?? 'a contractor';
  if (!trade && !job) return NextResponse.json({ error: 'Pick a trade or describe the job.' }, { status: 400 });

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
    const completion = await (await resolveProvider()).complete({ system, messages: [{ role: 'user', content: userMsg }], tools: [] });
    text = completion.text.trim();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'AI request failed' }, { status: 503 });
  }

  // A real, clickable search the user can run to find local, vetted pros.
  const q = encodeURIComponent(`${tradeLabel} ${job ? job + ' ' : ''}near ${location || 'me'}`);
  const searchUrl = `https://www.google.com/search?q=${q}`;

  const supabase = await createServer();
  await supabase.from('home_ai_logs').insert({
    family_id: ctx.active.familyId, user_id: ctx.user.id, kind: 'find_pro',
    input: { trade, job, location }, output: { text }, created_by: ctx.user.id,
  });

  return NextResponse.json({ text, searchUrl, tradeLabel });
}
