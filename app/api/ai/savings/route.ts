import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { refuseUnlessEntitled } from '@/lib/server/route-feature-gate';
import { settleAll, describeReadError } from '@/lib/supabase/settle';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';
import { requireUserContext } from '@/lib/supabase/auth';
import { isManager } from '@/lib/constants/roles';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { dayKeyIn } from '@/lib/time/zoned';
import { budgetByCategory, periodWindow } from '@/lib/finance/budget-periods';
import type { BudgetPeriod } from '@/lib/database.types';
import { resolveProvider } from '@/lib/ai/provider';
import { summarizeSubscriptions, wastedMonthlyCents, isStale, monthlyCostCents, type SubLike } from '@/lib/finance/subscriptions';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';

export const runtime = 'nodejs';

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** "You're $X over your … budget", in the budget's own period. */
const OVER_BUDGET_DETAIL: Record<BudgetPeriod, string> = {
  weekly: 'savings.overYourWeeklyBudget',
  monthly: 'savings.overYourMonthlyBudget',
  yearly: 'savings.overYourYearlyBudget',
};

/**
 * AI savings suggestions for a family's finances. Reads recent transactions,
 * budgets, upcoming bills and tracked subscriptions (family-scoped via the
 * cookie client + RLS), summarises them deterministically, then asks the AI for
 * concrete, prioritised savings ideas. Degrades to a data-driven fallback when
 * AI is unconfigured — never fabricates numbers.
 */
export async function POST() {
  const tr = await getTranslations();
  const ctx = await requireUserContext();
  const { familyId } = ctx.active;
  // The family's money is the adults': the finance service refuses anyone else
  // and the privacy export withholds `finances` from them. This route reads the
  // same tables through its own queries, and answered a child with the
  // family's overspending and subscriptions.
  if (!isManager(ctx.active.role)) return NextResponse.json({ error: tr('savings.privateToTheAdults') }, { status: 403 });
  const supabase = await createServer();
  // The page in front of this is feature-gated; this endpoint was not, and it
  // calls a model. Same resolver, so the two cannot disagree.
  const refused = await refuseUnlessEntitled(supabase, ctx.active.familyId, ['/dashboard/subscriptions']);
  if (refused) return refused;
  const limited = await enforceAIRateLimit(supabase, `ai-savings:${ctx.user.id}`, { limit: 10 });
  if (!limited.ok) return NextResponse.json(
    { error: tr('savings.tooManySavingsRequestsPlease') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  // The FAMILY's day, not Greenwich's. `new Date().toISOString()` was the UTC
  // month: from 17:00 on the last day of a month Los Angeles read next month's
  // empty window ("no overspending"), and Tokyo kept counting last month until
  // 09:00 on the 1st. And each budget is judged in its OWN period (Sunday to
  // Saturday, the month, the year; lib/finance/hub periodWindow), both ends
  // bounded: a month of spending set against a weekly limit reported $400 of
  // groceries as "$250 over", a yearly limit was never over, and next month's
  // scheduled rows counted. One read starts where the earliest period can (this
  // week, which can begin in December, or 1 January); each budget then counts
  // only the rows inside its own window, end included.
  const today = dayKeyIn(new Date(), ctx.active.family?.timezone || 'UTC');
  const thisWeek = periodWindow('weekly', today), thisYear = periodWindow('yearly', today);
  const readFrom = thisWeek.from < thisYear.from ? thisWeek.from : thisYear.from;
  // And it ends where the latest period can: 31 December, or this week's
  // Saturday when it falls in next year's January.
  const readTo = thisWeek.to > thisYear.to ? thisWeek.to : thisYear.to;
  // All four errors were dropped here, and this route's own docstring above says
  // it "never fabricates numbers". It did. `txns ?? []` empties the category
  // map, so a refused `transactions` read produced no overspending, no stale
  // subscriptions, and the deterministic fallback "On track — No overspending or
  // unused subscriptions detected", at HTTP 200. A parent asking whether they
  // are overspending was told they are fine BECAUSE the database was
  // unavailable.
  //
  // It also reached the model: the `context` block below is built from the same
  // empty collections and states "Over-budget categories this month: none" and
  // "Unpaid bills: 0" as established fact, so the AI was asked to reason from
  // fabricated inputs under a system prompt telling it to use ONLY the data
  // given.
  //
  // The transactions read was additionally unbounded — PostgREST caps it at
  // db-max-rows (1,000) in silence — so a family with a busy month had its
  // over-budget amounts UNDERSTATED and stated as fact. A paged read with a
  // real ceiling fixes that; exceeding the ceiling surfaces as an error here
  // rather than as a quiet prefix, because a truncated read is a failed read.
  // Audit C1-S9-25.
  //
  // Paged on the id, not on offsets (readAllByIdAsQuery): the read spans up to
  // a year, many pages, and a transaction recorded between two of them shifted
  // every offset after it, so one row was summed twice (or one skipped) and a
  // budget read as over by a row it never held (M11-RATCHET).
  const [txnsResult, budgetsResult, billsResult, subsResult] = await settleAll([
    readAllByIdAsQuery<{ id: string; amount: number; category: string | null; type: string; date: string }>((after, limit) => {
      let query = supabase.from('transactions').select('id, amount, category, type, date').eq('family_id', familyId)
        .eq('type', 'expense').gte('date', readFrom).lte('date', readTo);
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: 20_000 }),
    supabase.from('budgets').select('id, category, amount, period, created_at').eq('family_id', familyId),
    supabase.from('bills').select('name, amount, status').eq('family_id', familyId).neq('status', 'paid'),
    supabase.from('subscriptions_tracked').select('name, cost_cents, cadence, status, last_used').eq('family_id', familyId),
  ]);
  const readFailures = ([
    ['transactions', txnsResult], ['budgets', budgetsResult],
    ['bills', billsResult], ['subscriptions', subsResult],
  ] as const).filter(([, r]) => r.error).map(([label, r]) => ({ label, detail: describeReadError(r.error) }));
  if (readFailures.length > 0) {
    // 503, not a cheerful 200. There is no honest answer to "am I overspending?"
    // built on a read that did not happen.
    console.error('[ai/savings] finance read failed', { familyId, failures: readFailures });
    return NextResponse.json({ error: tr('ai.recommendationsAreTemporarilyUnavailable') }, { status: 503 });
  }
  const { data: txns } = txnsResult, { data: budgets } = budgetsResult;
  const { data: bills } = billsResult, { data: subs } = subsResult;

  // One budget per category, the oldest (the one the finance service edits and
  // reports), matched case-insensitively: a "groceries" row is Groceries spend.
  const budgetByCat = budgetByCategory((budgets ?? []).map((b) => ({ ...b, amount: Number(b.amount) })));
  // Spend per budgeted category, inside that budget's own period.
  const byCat = new Map<string, number>();
  for (const [key, b] of budgetByCat) {
    const window = periodWindow(b.period, today);
    let spent = 0;
    for (const t of txns ?? []) {
      if ((t.category ?? '').trim().toLowerCase() !== key || t.date < window.from || t.date > window.to) continue;
      spent += Math.abs(Number(t.amount));
    }
    byCat.set(key, spent);
  }
  const overspent = [...budgetByCat.entries()]
    .map(([key, b]) => ({ cat: b.category, period: b.period, spent: byCat.get(key) ?? 0, budget: b.amount, over: (byCat.get(key) ?? 0) - b.amount }))
    .filter((x) => x.budget > 0 && x.over > 0)
    .sort((a, b) => b.over - a.over);

  const subList = (subs ?? []) as SubLike[];
  const subStats = summarizeSubscriptions(subList);
  // Recorded use is a DATE on the family's wall, counted from the family's day.
  const usageDay = dayKeyIn(new Date(), ctx.active.family?.timezone || 'UTC');
  const wasted = wastedMonthlyCents(subList, 60, usageDay);
  const staleNames = (subs ?? []).filter((s) => isStale(s as SubLike, 60, usageDay)).map((s) => `${s.name} (${usd(monthlyCostCents(s.cost_cents, s.cadence))}/mo)`);

  const context = [
    `Subscriptions: ${subStats.active} active, ${usd(subStats.monthlyCents)}/mo. Unused (60d+): ${staleNames.join(', ') || 'none'} → up to ${usd(wasted)}/mo recoverable.`,
    `Over-budget categories, each in its own budget period: ${overspent.map((o) => `${o.cat} (${o.period} budget) +$${o.over.toFixed(0)}`).join(', ') || 'none'}.`,
    `Unpaid bills: ${(bills ?? []).length}.`,
  ].join('\n');

  // Deterministic fallback suggestions (used if AI is unavailable).
  const fallback: Array<{ title: string; detail: string }> = [];
  if (staleNames.length) fallback.push({ title: `Cancel ${staleNames.length} unused subscription${staleNames.length > 1 ? 's' : ''}`, detail: `Save up to ${usd(wasted)}/mo (${usd(wasted * 12)}/yr): ${staleNames.join(', ')}.` });
  for (const o of overspent.slice(0, 2)) {
    fallback.push({ title: `Trim ${o.cat} spending`, detail: tr(OVER_BUDGET_DETAIL[o.period], { amount: `$${o.over.toFixed(0)}`, category: o.cat }) });
  }
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
