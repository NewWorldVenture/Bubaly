import { NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { resolveProvider } from '@/lib/ai/provider';
import { summarizeSubscriptions, wastedMonthlyCents, isStale, monthlyCostCents, type SubLike } from '@/lib/finance/subscriptions';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';

export const runtime = 'nodejs';

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * AI savings suggestions for a family's finances. Reads recent transactions,
 * budgets, upcoming bills and tracked subscriptions (family-scoped via the
 * cookie client + RLS), summarises them deterministically, then asks the AI for
 * concrete, prioritised savings ideas. Degrades to a data-driven fallback when
 * AI is unconfigured — never fabricates numbers.
 */
export async function POST() {
  const ctx = await requireUserContext();
  const { familyId } = ctx.active;
  const supabase = await createServer();
  const limited = await enforceAIRateLimit(supabase, `ai-savings:${ctx.user.id}`, { limit: 10 });
  if (!limited.ok) return NextResponse.json(
    { error: 'Too many savings requests. Please try again shortly.' },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  const monthStart = new Date().toISOString().slice(0, 8) + '01';
  const [{ data: txns }, { data: budgets }, { data: bills }, { data: subs }] = await Promise.all([
    supabase.from('transactions').select('amount, category, type, date').eq('family_id', familyId).eq('type', 'expense').gte('date', monthStart),
    supabase.from('budgets').select('category, amount, period').eq('family_id', familyId),
    supabase.from('bills').select('name, amount, status').eq('family_id', familyId).neq('status', 'paid'),
    supabase.from('subscriptions_tracked').select('name, cost_cents, cadence, status, last_used').eq('family_id', familyId),
  ]);

  // Spend by category this month.
  const byCat = new Map<string, number>();
  for (const t of txns ?? []) byCat.set(t.category ?? 'Other', (byCat.get(t.category ?? 'Other') ?? 0) + Number(t.amount));
  const budgetByCat = new Map((budgets ?? []).map((b) => [b.category, Number(b.amount)]));
  const overspent = [...byCat.entries()]
    .map(([cat, spent]) => ({ cat, spent, budget: budgetByCat.get(cat) ?? 0, over: spent - (budgetByCat.get(cat) ?? 0) }))
    .filter((x) => x.budget > 0 && x.over > 0)
    .sort((a, b) => b.over - a.over);

  const subList = (subs ?? []) as SubLike[];
  const subStats = summarizeSubscriptions(subList);
  const wasted = wastedMonthlyCents(subList);
  const staleNames = (subs ?? []).filter((s) => isStale(s as SubLike)).map((s) => `${s.name} (${usd(monthlyCostCents(s.cost_cents, s.cadence))}/mo)`);

  const context = [
    `Subscriptions: ${subStats.active} active, ${usd(subStats.monthlyCents)}/mo. Unused (60d+): ${staleNames.join(', ') || 'none'} → up to ${usd(wasted)}/mo recoverable.`,
    `Over-budget categories this month: ${overspent.map((o) => `${o.cat} +$${o.over.toFixed(0)}`).join(', ') || 'none'}.`,
    `Unpaid bills: ${(bills ?? []).length}.`,
  ].join('\n');

  // Deterministic fallback suggestions (used if AI is unavailable).
  const fallback: Array<{ title: string; detail: string }> = [];
  if (staleNames.length) fallback.push({ title: `Cancel ${staleNames.length} unused subscription${staleNames.length > 1 ? 's' : ''}`, detail: `Save up to ${usd(wasted)}/mo (${usd(wasted * 12)}/yr): ${staleNames.join(', ')}.` });
  for (const o of overspent.slice(0, 2)) fallback.push({ title: `Trim ${o.cat} spending`, detail: `You're $${o.over.toFixed(0)} over your ${o.cat} budget this month.` });
  if (fallback.length === 0) fallback.push({ title: 'On track', detail: 'No overspending or unused subscriptions detected. Set category budgets to unlock sharper suggestions.' });

  try {
    const result = await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: 'finances.savings', text: 'Savings suggestions' },
      async (obs) => {
        const provider = await resolveProvider();
        const completion = await provider.complete({
          system: 'You are a practical family financial coach. Use ONLY the data given; never invent numbers. Reply ONLY as compact JSON: {"summary": string (1-2 sentences), "suggestions": [{"title": string, "detail": string}] (up to 4, most impactful first)}.',
          messages: [{ role: 'user', content: `Family finance snapshot:\n${context}\n\nGive prioritised, concrete savings suggestions.` }],
          tools: [],
          maxTokens: 600,
        });
        obs.used(completion.model ?? 'unknown', completion.usage);
        const m = completion.text.match(/\{[\s\S]*\}/);
        const parsed = m ? JSON.parse(m[0]) : {};
        const suggestions = Array.isArray(parsed.suggestions)
          ? parsed.suggestions.filter((s: unknown) =>
            s !== null && typeof s === 'object'
            && 'title' in s && typeof s.title === 'string' && s.title.trim().length > 0
            && 'detail' in s && typeof s.detail === 'string' && s.detail.trim().length > 0,
          ).slice(0, 4)
          : [];
        const hasSummary = typeof parsed.summary === 'string' && parsed.summary.trim().length > 0;
        if (!hasSummary && suggestions.length === 0) {
          obs.failed(new Error('The savings response contained no usable summary or suggestions.'));
        }
        return {
          summary: hasSummary ? parsed.summary : 'Here are the biggest opportunities to save.',
          suggestions: suggestions.length ? suggestions : fallback,
          wastedMonthlyCents: wasted,
        };
      },
    );
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ summary: 'AI is not configured — here are data-driven suggestions from your finances.', suggestions: fallback, wastedMonthlyCents: wasted });
  }
}
