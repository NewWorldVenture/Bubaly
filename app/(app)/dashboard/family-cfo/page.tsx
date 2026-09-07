import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Wallet, Receipt, PiggyBank, TrendingDown, CalendarClock, CreditCard, ArrowRight, Sparkles, Plane, Truck, Hammer, Repeat, ShieldCheck,
} from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isMissingTableError } from '@/lib/supabase/errors';
import { PageHeader } from '@/components/app/page-header';
import { StatTile, SectionCard, MiniEmpty } from '@/components/family/shell';
import { ErrorState } from '@/components/ui/states';
import { HandleItButton } from '@/components/modules/handle-it-button';
import { AffordabilityScenario } from '@/components/finance/affordability-scenario';
import { fmtDate } from '@/lib/utils/format';
import { getTranslations } from '@/lib/i18n/server';
import { loadMoneyTimelineInput } from '@/lib/finance/timeline-load';
import { buildCashflowTimeline, DEFAULT_BUFFER, money, pretty, type BuildTimelineInput, type PlanSource } from '@/lib/finance/timeline';
import { EXPLAIN_MONTH_REQUEST } from '@/lib/finance/cfo-prompts';

export const metadata: Metadata = { title: 'Family CFO' };
export const dynamic = 'force-dynamic';

const usd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

/** Where each plan-linked commitment comes from, for the forecast list. */
const PLAN_SOURCE: Record<PlanSource, { labelKey: string; icon: typeof Plane; href: string }> = {
  subscription: { labelKey: 'familyCfo.subscription', icon: Repeat, href: '/dashboard/subscriptions' },
  vacation: { labelKey: 'familyCfo.trip', icon: Plane, href: '/dashboard/vacations' },
  move: { labelKey: 'familyCfo.move', icon: Truck, href: '/dashboard/moving' },
  project: { labelKey: 'familyCfo.homeProject', icon: Hammer, href: '/dashboard/projects' },
};

export default async function FamilyCfoPage() {
  const tr = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';

  const [accountsRes, billsRes, goalsRes, spendRes, budgetsRes] = await Promise.all([
    supabase.from('financial_accounts').select('*').eq('family_id', familyId),
    supabase.from('bills').select('*').eq('family_id', familyId).neq('status', 'paid')
      .gte('due_date', today).lte('due_date', in30).order('due_date'),
    supabase.from('savings_goals').select('*').eq('family_id', familyId).order('created_at'),
    supabase.from('transactions').select('amount, category, type').eq('family_id', familyId)
      .eq('type', 'expense').gte('date', monthStart),
    supabase.from('budgets').select('*').eq('family_id', familyId),
  ]);

  // Every figure here is money and the page tells the family so ("every figure
  // is live"). A dropped error would render Net position $0, "Due in 30 days
  // $0", zero spend, and no goals — a reassuring-but-wrong financial picture a
  // family could act on (miss a bill, assume savings vanished). Fail closed on
  // a real read error; a genuinely missing table (unapplied migration) is still
  // tolerated as empty so a partial env degrades rather than hard-fails.
  const financeError = [accountsRes.error, billsRes.error, goalsRes.error, spendRes.error, budgetsRes.error]
    .find((e) => e && !isMissingTableError(e));
  if (financeError) {
    console.error('[dashboard/family-cfo] finance read failed', financeError);
    return <ErrorState message={tr('familyCfo.couldNotLoadYourFamily')} />;
  }

  // The 12-week forecast reads the same money tables plus the plan modules
  // (subscriptions, trips, moves, home projects). The loader throws on a real
  // read failure; a forecast with a trip silently missing is the same false
  // comfort as a $0 net position, so it fails closed here too.
  let forecastInput: BuildTimelineInput;
  try {
    forecastInput = await loadMoneyTimelineInput(supabase, familyId);
  } catch (err) {
    console.error('[dashboard/family-cfo] forecast read failed', err);
    return <ErrorState message={tr('familyCfo.couldNotLoadYourFamily')} />;
  }
  const forecast = buildCashflowTimeline(forecastInput);
  const buffer = forecastInput.buffer ?? DEFAULT_BUFFER;

  const accounts = accountsRes.data;
  const bills = billsRes.data;
  const goals = goalsRes.data;
  const spend = spendRes.data;
  const budgets = budgetsRes.data;

  const netWorth = (accounts ?? []).reduce((s, a) => s + (a.type === 'credit' ? -Number(a.balance) : Number(a.balance)), 0);
  const upcomingTotal = (bills ?? []).reduce((s, b) => s + Number(b.amount), 0);
  const monthSpend = (spend ?? []).reduce((s, t) => s + Number(t.amount), 0);
  const byCat = new Map<string, number>();
  for (const t of spend ?? []) byCat.set(t.category ?? 'Other', (byCat.get(t.category ?? 'Other') ?? 0) + Number(t.amount));
  const budgetByCat = new Map((budgets ?? []).map((b) => [b.category, Number(b.amount)]));

  const { coverage } = forecast;
  // Copy here says "bills" to a family, so it counts DISTINCT BILLS, never
  // occurrences: one monthly bill is three payments inside a 12-week horizon,
  // and "3 of 4 bills" for a household with two of them is a false statement
  // about their money. coverage.*Bills are the distinct-bill counters.
  const coveredBills = coverage.coveredBills + coverage.paidBills;
  const planMoments = forecast.weeks
    .flatMap((w) => w.moments.filter((m) => m.kind === 'plan').map((m) => ({ ...m, weekStart: w.weekStart })))
    .slice(0, 6);
  const lowTone = forecast.lowestBalance < 0 ? 'bg-rose-500' : forecast.lowestBalance < buffer ? 'bg-orange-500' : 'bg-emerald-600';

  return (
    <div className="space-y-5">
      <PageHeader
        title={tr('dashboardFamilyCfo.familyCfo')}
        description={tr('familyCfo.yourHouseholdSFinancesAt')}
        action={
          <HandleItButton
            request={EXPLAIN_MONTH_REQUEST}
            label={tr('familyCfo.explainThisMonth')}
            className="mt-0 w-auto"
          />
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={tr('dashboardFamilyCfo.netPosition')} value={usd(netWorth)} icon={Wallet} accent="bg-emerald-600" href="/dashboard/billing" sublabel={tr('finances.accounts')} />
        <StatTile label={tr('dashboardFamilyCfo.dueIn30Days')} value={usd(upcomingTotal)} icon={CalendarClock} accent="bg-orange-500" />
        <StatTile label={tr('dashboardFamilyCfo.spentThisMonth')} value={usd(monthSpend)} icon={TrendingDown} accent="bg-rose-500" />
        <StatTile label={tr('dashboardFamilyCfo.savingsGoals')} value={goals?.length ?? 0} icon={PiggyBank} accent="bg-violet-600" />
      </div>

      {/* The forward view — the same forecast as /dashboard/money-timeline, with
          plan-linked commitments and coverage, summarised on the CFO surface. */}
      <SectionCard
        title={tr('familyCfo.next12Weeks')}
        description={tr('familyCfo.billsGoalSetAsidesAndThe')}
        viewAllHref="/dashboard/money-timeline"
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label={tr('familyCfo.projectedLow')}
            value={money(forecast.lowestBalance)}
            icon={TrendingDown}
            accent={lowTone}
            href="/dashboard/money-timeline"
            sublabel={forecast.lowestBalanceWeek ? tr('familyCfo.wkOf', { week: pretty(forecast.lowestBalanceWeek) }) : tr('familyCfo.staysFlat')}
          />
          <StatTile label={tr('familyCfo.dueNext12Wks')} value={money(forecast.totalOutflow)} icon={CalendarClock} accent="bg-orange-500" href="/dashboard/money-timeline" />
          <StatTile label={tr('familyCfo.planLinked')} value={money(forecast.planOutflow)} icon={Plane} accent="bg-sky-600" sublabel={tr('familyCfo.tripsMovesProjectsSubscriptions')} />
          <StatTile
            label={tr('familyCfo.covered')}
            value={money(coverage.coveredAmount + coverage.paidAmount)}
            icon={ShieldCheck}
            accent="bg-emerald-600"
            sublabel={tr('familyCfo.nOfMBills', { n: coveredBills, m: coverage.totalBills })}
          />
        </div>

        <p className="mt-4 text-sm text-muted">
          {coverage.totalBills === 0
            ? tr('familyCfo.noBillsFallInsideThe')
            : coverage.openBills === 0
              ? tr('familyCfo.everyBillInTheNext12', { n: coverage.totalBills })
              : tr('familyCfo.nBillsAreCoveredAutopay', { covered: coveredBills, open: coverage.openBills, amount: money(coverage.openAmount) })}
        </p>

        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{tr('familyCfo.planLinkedCommitments')}</h3>
          {planMoments.length > 0 ? (
            <ul className="mt-2 divide-y divide-border">
              {planMoments.map((m, i) => {
                const src = PLAN_SOURCE[m.source ?? 'project'];
                return (
                  <li key={`${m.label}-${m.date}-${i}`} className="flex items-center gap-3 py-2.5">
                    <src.icon className="h-4 w-4 shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate text-sm">{m.label}</span>
                    <Link href={src.href} className="hidden rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted hover:text-fg sm:inline">{tr(src.labelKey)}</Link>
                    <span className="text-xs text-muted">{tr('familyCfo.wkOf', { week: pretty(m.weekStart) })}</span>
                    <span className="text-sm font-semibold tabular-nums">{money(m.amount)}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">{tr('familyCfo.noTripMoveProjectOr')}</p>
          )}
        </div>

        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
          <Link href="/dashboard/money-timeline" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-text hover:underline">
            <Sparkles className="h-4 w-4" /> {tr('familyCfo.openTheMoneyTimeline')} <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <Link href="/dashboard/family-digital-twin" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-text hover:underline">
            {tr('familyCfo.simulateASpendInThe')} <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </SectionCard>

      <AffordabilityScenario buffer={buffer} />

      <div className="grid gap-5 md:grid-cols-2">
        <SectionCard title={tr('dashboardFamilyCfo.upcomingBills')} description={tr('familyCfo.next30Days')} viewAllHref="/dashboard/billing">
          {bills && bills.length > 0 ? (
            <ul className="divide-y divide-border">
              {bills.map((b) => (
                <li key={b.id} className="flex items-center gap-3 py-2.5">
                  <Receipt className="h-4 w-4 text-muted" />
                  <span className="min-w-0 flex-1 truncate text-sm">{b.name}</span>
                  {b.autopay && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-500">
                      <ShieldCheck className="h-2.5 w-2.5" /> {tr('familyCfo.coveredAutopay')}
                    </span>
                  )}
                  <span className="text-xs text-muted">{fmtDate(b.due_date)}</span>
                  <span className="text-sm font-semibold tabular-nums">{usd(Number(b.amount))}</span>
                </li>
              ))}
            </ul>
          ) : <MiniEmpty icon={CalendarClock} text={tr('familyCfo.noBillsDueInThe')} />}
        </SectionCard>

        <SectionCard title={tr('dashboardFamilyCfo.spendingVsBudget')} description={tr('familyCfo.thisMonthByCategory')} viewAllHref="/dashboard/billing">
          {byCat.size > 0 ? (
            <ul className="space-y-3">
              {[...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([cat, amt]) => {
                const budget = budgetByCat.get(cat) ?? 0;
                const pct = budget > 0 ? Math.min(100, Math.round((amt / budget) * 100)) : 0;
                return (
                  <li key={cat}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="capitalize">{cat}</span>
                      <span className="tabular-nums text-muted">{usd(amt)}{budget > 0 && ` / ${usd(budget)}`}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-white/5">
                      <div className={`h-full rounded-full ${pct >= 100 ? 'bg-rose-500' : pct >= 80 ? 'bg-orange-400' : 'bg-emerald-500'}`} style={{ width: `${budget > 0 ? pct : 100}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : <MiniEmpty icon={CreditCard} text={tr('familyCfo.noSpendingRecordedThisMonth')} />}
        </SectionCard>
      </div>

      <SectionCard title={tr('dashboardFamilyCfo.savingsGoals')} viewAllHref="/dashboard/billing">
        {goals && goals.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {goals.map((g) => {
              const pct = Number(g.target_amount) > 0 ? Math.min(100, Math.round((Number(g.current_amount) / Number(g.target_amount)) * 100)) : 0;
              return (
                <div key={g.id} className="rounded-2xl border border-border bg-surface/40 p-4">
                  <div className="flex items-center gap-2"><span className="text-xl">{g.emoji ?? '🎯'}</span><span className="font-semibold">{g.name}</span></div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/5"><div className="h-full rounded-full bg-violet-500" style={{ width: `${pct}%` }} /></div>
                  <p className="mt-2 text-xs text-muted">{tr('familyCfo.currentOfTargetPct', { current: usd(Number(g.current_amount)), target: usd(Number(g.target_amount)), pct })}</p>
                </div>
              );
            })}
          </div>
        ) : <MiniEmpty icon={PiggyBank} text={tr('familyCfo.noSavingsGoalsYet')} />}
      </SectionCard>
    </div>
  );
}
