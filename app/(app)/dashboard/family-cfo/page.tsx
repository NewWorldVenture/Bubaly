import type { Metadata } from 'next';
import { Wallet, Receipt, PiggyBank, TrendingDown, CalendarClock, CreditCard } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { createServer } from '@/lib/supabase/server';
import { isMissingTableError } from '@/lib/supabase/errors';
import { PageHeader } from '@/components/app/page-header';
import { StatTile, SectionCard, MiniEmpty } from '@/components/family/shell';
import { ErrorState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Family CFO' };
export const dynamic = 'force-dynamic';

const usd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

export default async function FamilyCfoPage() {
  const tr = await getTranslations();
  const ctx = await requireUserContext();
  await requireAal2(ctx, 'money', '/dashboard/family-cfo');
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

  return (
    <div className="space-y-5">
      <PageHeader title={tr('dashboardFamilyCfo.familyCfo')} description={tr('familyCfo.yourHouseholdSFinancesAt')} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={tr('dashboardFamilyCfo.netPosition')} value={usd(netWorth)} icon={Wallet} accent="bg-emerald-600" href="/dashboard/billing" sublabel="Accounts" />
        <StatTile label={tr('dashboardFamilyCfo.dueIn30Days')} value={usd(upcomingTotal)} icon={CalendarClock} accent="bg-orange-500" />
        <StatTile label={tr('dashboardFamilyCfo.spentThisMonth')} value={usd(monthSpend)} icon={TrendingDown} accent="bg-rose-500" />
        <StatTile label={tr('dashboardFamilyCfo.savingsGoals')} value={goals?.length ?? 0} icon={PiggyBank} accent="bg-violet-600" />
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <SectionCard title={tr('dashboardFamilyCfo.upcomingBills')} description={tr('familyCfo.next30Days')} viewAllHref="/dashboard/billing">
          {bills && bills.length > 0 ? (
            <ul className="divide-y divide-border">
              {bills.map((b) => (
                <li key={b.id} className="flex items-center gap-3 py-2.5">
                  <Receipt className="h-4 w-4 text-muted" />
                  <span className="min-w-0 flex-1 truncate text-sm">{b.name}</span>
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
                  <p className="mt-2 text-xs text-muted">{usd(Number(g.current_amount))} of {usd(Number(g.target_amount))} · {pct}%</p>
                </div>
              );
            })}
          </div>
        ) : <MiniEmpty icon={PiggyBank} text={tr('familyCfo.noSavingsGoalsYet')} />}
      </SectionCard>
    </div>
  );
}
