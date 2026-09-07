import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import {
  summarizeUtilities, deterministicSavingsFindings, utilityLabel, usd,
  type BillLike,
} from '@/lib/home/utilities';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * AI Utility Savings. Grounded server-side in the family's own `utility_bills`
 * history, it (1) always returns deterministic, fact-based findings — real
 * spikes vs the household's typical spend, sharp month-over-month jumps, and the
 * largest line item — and (2) when AI is configured, layers a prioritized,
 * actionable savings narrative on top. It never fabricates a number: the model
 * sees only the computed figures and is told to reuse them verbatim.
 */
export async function POST() {
  const t = await getTranslations();
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: t('utilitySavings.unauthorized') }, { status: 401 }); }

  const supabase = await createServer();
  const limited = await enforceAIRateLimit(supabase, `ai-home-utility-savings:${ctx.user.id}`, { limit: 10 });
  if (!limited.ok) return NextResponse.json(
    { error: t('utilitySavings.tooManyUtilitySavingsRequests') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );
  const { data: rows } = await supabase
    .from('utility_bills')
    .select('kind, period_month, amount_cents')
    .eq('family_id', ctx.active.familyId)
    .order('period_month', { ascending: true })
    .limit(400);

  const bills = (rows ?? []) as BillLike[];
  if (bills.length === 0) {
    return NextResponse.json({ error: t('utilitySavings.addAFewUtilityBills') }, { status: 400 });
  }

  const summary = summarizeUtilities(bills);
  const findings = deterministicSavingsFindings(bills);

  let recommendations: string | null = null;
  let aiUsed = false;

  if (await isAIConfigured()) {
    const factLines = summary.perKind.map((k) => {
      const bits = [`${utilityLabel(k.kind)}: ${usd(k.latestCents)}/mo (${k.months} mo of history)`];
      if (k.baselineCents != null) bits.push(`typical ${usd(k.baselineCents)}`);
      if (k.deltaPct != null) bits.push(`${k.deltaPct >= 0 ? '+' : ''}${k.deltaPct}% vs last month`);
      if (k.spikePct != null) bits.push(`${k.spikePct}% above typical`);
      return '- ' + bits.join(', ');
    }).join('\n');

    const system =
      'You are a household utility-savings advisor. Using ONLY the figures provided, write a short, ' +
      'practical savings plan. Reuse the exact dollar amounts and percentages given — never invent numbers, ' +
      'rates, or appliance specifics. Plain text, these sections:\n' +
      'TOP OPPORTUNITIES: 2–4 bullets, biggest dollar savings first, each tied to a specific utility and figure.\n' +
      'QUICK WINS: 2–3 low-effort actions for this month.\n' +
      'WATCH: 1–2 items where a recent change suggests checking for a leak, fault, or rate increase.\n' +
      'Be encouraging and concrete. If the data is thin, say so honestly.';

    const userMsg =
      `Household monthly utilities: ${usd(summary.monthlyTotalCents)} (~${usd(summary.annualTotalCents)}/yr).\n` +
      `Largest: ${summary.topCostKind ? utilityLabel(summary.topCostKind) : 'n/a'}.\n\n` +
      `Per-utility figures:\n${factLines}\n\n` +
      `Pre-computed flags:\n${findings.map((f) => `- ${f.title}: ${f.detail}`).join('\n') || '- none'}`;

    try {
      // Inside the try that falls back to the deterministic findings, so the
      // failure is on the row before it is swallowed. This route returns 200
      // either way — `aiUsed: false` is the only outward sign, and nobody
      // reading a support ticket can tell it from "AI wasn't configured".
      recommendations = await withAiRequest(
        scopeFromUserContext(ctx, supabase),
        { feature: 'home.utility-savings', text: `Utility savings across ${bills.length} bills` },
        async (obs) => {
          const completion = await (await resolveProvider()).complete({ system, messages: [{ role: 'user', content: userMsg }], tools: [] });
          obs.used(completion.model ?? 'unknown', completion.usage);
          return completion.text.trim() || null;
        },
      );
      aiUsed = true;
    } catch {
      recommendations = null; // fall back to deterministic findings only
    }
  }

  await supabase.from('home_ai_logs').insert({
    family_id: ctx.active.familyId, user_id: ctx.user.id, kind: 'utility_savings',
    input: { bills: bills.length, monthly_cents: summary.monthlyTotalCents },
    output: { findings: findings.length, aiUsed },
    status: aiUsed ? 'succeeded' : 'fallback',
    created_by: ctx.user.id,
  });

  return NextResponse.json({
    findings,
    recommendations,
    aiUsed,
    summary: {
      monthlyTotalCents: summary.monthlyTotalCents,
      annualTotalCents: summary.annualTotalCents,
      topCostKind: summary.topCostKind,
    },
  });
}
