import type { Metadata } from 'next';
import { Wallet, Receipt, PiggyBank, TrendingDown, CalendarClock, CreditCard } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { StatTile, SectionCard, MiniEmpty } from '@/components/family/shell';
import { fmtDate } from '@/lib/utils/format';

export const metadata: Metadata = { title: 'Family CFO' };
export const dynamic = 'force-dynamic';

const usd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

export default async function FamilyCfoPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';

  const [{ data: accounts }, { data: bills }, { data: goals }, { data: spend }, { data: budgets }] = await Promise.all([
    supabase.from('financial_accounts').select('*').eq('family_id', familyId),
    supabase.from('bills').select('*').eq('family_id', familyId).neq('status', 'paid')
      .gte('due_date', today).lte('due_date', in30).order('due_date'),
    supabase.from('savings_goals').select('*').eq('family_id', familyId).order('created_at'),
    supabase.from('transactions').select('amount, category, type').eq('family_id', familyId)
      .eq('type', 'expense').gte('date', monthStart),
    supabase.from('budgets').select('*').eq('family_id', familyId),
  ]);

  const netWorth = (accounts ?? []).reduce((s, a) => s + (a.type === 'credit' ? -Number(a.balance) : Number(a.balance)), 0);
  const upcomingTotal = (bills ?? []).reduce((s, b) => s + Number(b.amount), 0);
  const monthSpend = (spend ?? []).reduce((s, t) => s + Number(t.amount), 0);
  const byCat = new Map<string, number>();
  for (const t of spend ?? []) byCat.set(t.category ?? 'Other', (byCat.get(t.category ?? 'Other') ?? 0) + Number(t.amount));
  const budgetByCat = new Map((budgets ?? []).map((b) => [b.category, Number(b.amount)]));

  return (
    <div className="space-y-5">
      <PageHeader title="Family CFO" description="Your household's finances at a glance — every figure is live." />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Net position" value={usd(netWorth)} icon={Wallet} accent="bg-emerald-600" href="/dashboard/billing" sublabel="Accounts" />
        <StatTile label="Due in 30 days" value={usd(upcomingTotal)} icon={CalendarClock} accent="bg-orange-500" />
        <StatTile label="Spent this month" value={usd(monthSpend)} icon={TrendingDown} accent="bg-rose-500" />
        <StatTile label="Savings goals" value={goals?.length ?? 0} icon={PiggyBank} accent="bg-violet-600" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard title="Upcoming Bills" description="Next 30 days" viewAllHref="/dashboard/billing">
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
          ) : <MiniEmpty icon={CalendarClock} text="No bills due in the next 30 days." />}
        </SectionCard>

        <SectionCard title="Spending vs Budget" description="This month by category" viewAllHref="/dashboard/billing">
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
          ) : <MiniEmpty icon={CreditCard} text="No spending recorded this month." />}
        </SectionCard>
      </div>

      <SectionCard title="Savings Goals" viewAllHref="/dashboard/billing">
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
        ) : <MiniEmpty icon={PiggyBank} text="No savings goals yet." />}
      </SectionCard>
    </div>
  );
}
