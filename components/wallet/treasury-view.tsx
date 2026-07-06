'use client';

import Link from 'next/link';
import { TrendingUp, PiggyBank, Target, ArrowDownLeft, ArrowUpRight, ChevronRight, Building2, Percent } from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { WalletSubnav } from '@/components/wallet/wallet-subnav';
import { Avatar } from '@/components/ui/avatar';
import { formatCents, type BucketKind } from '@/lib/wallet/ledger';
import { progressBarA11y } from '@/lib/ui/a11y';

export type TreasuryChild = {
  id: string;
  name: string;
  color: string | null;
  total: number;
  buckets: Record<BucketKind, number>;
  activeGoals: number;
  goalSavedCents: number;
  goalTargetCents: number;
  monthlyIn: number;
  monthlyOut: number;
};

const BUCKET_COLORS: Record<BucketKind, string> = {
  spend: '#38bdf8',
  save: '#34d399',
  give: '#fb7185',
  invest: '#a78bfa',
  goal: '#f59e0b',
};

export function TreasuryView({
  familyTotal, wallets, thisMonthIn, thisMonthOut,
  totalGoalSaved, totalGoalTargets, totalActiveGoals, trend, canManage,
}: {
  familyTotal: number;
  wallets: TreasuryChild[];
  thisMonthIn: number;
  thisMonthOut: number;
  totalGoalSaved: number;
  totalGoalTargets: number;
  totalActiveGoals: number;
  trend: { label: string; credits: number; debits: number }[];
  canManage: boolean;
}) {
  const netMonth = thisMonthIn - thisMonthOut;
  const goalPct = totalGoalTargets > 0 ? Math.min(100, Math.round((totalGoalSaved / totalGoalTargets) * 100)) : 0;
  const savingsRate = thisMonthIn > 0
    ? Math.min(100, Math.round(((wallets.reduce((s, c) => s + c.buckets.save, 0)) / Math.max(familyTotal, 1)) * 100))
    : 0;

  return (
    <div className="module-page">
      <PageHeader title="Family Treasury" description="Complete financial picture for your household." />
      <WalletSubnav />

      {/* Hero: total balance */}
      <div className="mb-6 overflow-hidden rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/10 via-brand/5 to-transparent p-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-brand/70">Total Family Balance</p>
            <p className="mt-1 text-4xl font-black tracking-tight">{formatCents(familyTotal)}</p>
            <p className="mt-1 text-sm text-muted">{wallets.length} wallet{wallets.length !== 1 ? 's' : ''} · {totalActiveGoals} active goal{totalActiveGoals !== 1 ? 's' : ''}</p>
          </div>
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-brand/15">
            <Building2 className="h-6 w-6 text-brand" />
          </div>
        </div>
        {/* Mini donut summary */}
        {familyTotal > 0 && (
          <div className="mt-4 flex items-center gap-3">
            <MiniSplitBar wallets={wallets} familyTotal={familyTotal} />
          </div>
        )}
      </div>

      {/* Month stats */}
      <div className="mb-6 grid grid-cols-3 gap-3">
        <StatCard
          label="Month In"
          value={formatCents(thisMonthIn)}
          icon={<ArrowDownLeft className="h-4 w-4 text-emerald-400" />}
          color="text-emerald-400"
        />
        <StatCard
          label="Month Out"
          value={formatCents(thisMonthOut)}
          icon={<ArrowUpRight className="h-4 w-4 text-rose-400" />}
          color="text-rose-400"
        />
        <StatCard
          label="Net"
          value={(netMonth >= 0 ? '+' : '−') + formatCents(Math.abs(netMonth))}
          icon={<TrendingUp className="h-4 w-4 text-brand" />}
          color={netMonth >= 0 ? 'text-emerald-400' : 'text-rose-400'}
        />
      </div>

      {/* Per-child overview */}
      <section className="mb-6">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-muted">
          <PiggyBank className="h-4 w-4" /> Children
        </h2>
        {wallets.length === 0 ? (
          <div className="rounded-2xl border border-border bg-surface/40 p-6 text-center text-sm text-muted">
            No child wallets yet.
          </div>
        ) : (
          <div className="space-y-2">
            {wallets.map((child) => (
              <ChildRow key={child.id} child={child} familyTotal={familyTotal} />
            ))}
          </div>
        )}
      </section>

      {/* Goals summary */}
      {totalActiveGoals > 0 && (
        <section className="mb-6">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-muted">
            <Target className="h-4 w-4" /> Goals Progress
          </h2>
          <div className="rounded-2xl border border-border bg-surface/40 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold">
                  {formatCents(totalGoalSaved)} saved toward {formatCents(totalGoalTargets)}
                </p>
                <p className="text-xs text-muted">{totalActiveGoals} active goal{totalActiveGoals !== 1 ? 's' : ''} across {wallets.filter((c) => c.activeGoals > 0).length} child{wallets.filter((c) => c.activeGoals > 0).length !== 1 ? 'ren' : ''}</p>
              </div>
              <div className="flex items-center gap-1 text-lg font-black text-brand">
                {goalPct}%
              </div>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-border/50" {...progressBarA11y(goalPct, `Family savings goals: ${goalPct}% funded`)}>
              <div
                className="h-full rounded-full bg-gradient-to-r from-brand to-brand/70 transition-all"
                style={{ width: `${goalPct}%` }}
              />
            </div>
            <div className="mt-3 flex justify-end">
              <Link href="/wallet/goals" className="flex items-center gap-1 text-xs font-semibold text-brand hover:underline">
                View all goals <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>
        </section>
      )}

      {/* Savings rate */}
      {familyTotal > 0 && (
        <section className="mb-6">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-muted">
            <Percent className="h-4 w-4" /> Savings Rate
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-border bg-surface/40 p-4">
              <p className="text-xs text-muted">Save bucket</p>
              <p className="mt-1 text-2xl font-black text-emerald-400">
                {formatCents(wallets.reduce((s, c) => s + c.buckets.save, 0))}
              </p>
              <p className="mt-0.5 text-[11px] text-muted">{savingsRate}% of total balance</p>
            </div>
            <div className="rounded-2xl border border-border bg-surface/40 p-4">
              <p className="text-xs text-muted">Give bucket</p>
              <p className="mt-1 text-2xl font-black text-rose-400">
                {formatCents(wallets.reduce((s, c) => s + c.buckets.give, 0))}
              </p>
              <p className="mt-0.5 text-[11px] text-muted">
                {familyTotal > 0 ? Math.round((wallets.reduce((s, c) => s + c.buckets.give, 0) / familyTotal) * 100) : 0}% of total balance
              </p>
            </div>
          </div>
        </section>
      )}

      {/* 6-month trend */}
      <section className="mb-6">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-muted">
          <TrendingUp className="h-4 w-4" /> 6-Month Flow
        </h2>
        <div className="rounded-2xl border border-border bg-surface/40 p-4">
          <TrendChart trend={trend} />
        </div>
      </section>

      {/* Quick links */}
      <section>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-muted">Quick Actions</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { href: '/wallet/allowance', label: 'Allowance', emoji: '📅' },
            { href: '/wallet/goals', label: 'Goals', emoji: '🎯' },
            { href: '/wallet/gift', label: 'Gift Links', emoji: '🎁' },
            { href: '/wallet/activity', label: 'Activity', emoji: '📊' },
          ].map((link) => (
            <Link key={link.href} href={link.href}
              className="flex flex-col items-center gap-2 rounded-2xl border border-border bg-surface/40 p-4 text-center transition hover:border-brand/30 hover:bg-brand/5">
              <span className="text-2xl">{link.emoji}</span>
              <span className="text-sm font-semibold">{link.label}</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, icon, color }: { label: string; value: string; icon: React.ReactNode; color: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-4">
      <div className="mb-1 flex items-center gap-1.5">
        {icon}
        <span className="text-[11px] font-medium text-muted">{label}</span>
      </div>
      <p className={`text-base font-bold ${color}`}>{value}</p>
    </div>
  );
}

function MiniSplitBar({ wallets, familyTotal }: { wallets: TreasuryChild[]; familyTotal: number }) {
  const bucketTotals: Record<BucketKind, number> = { spend: 0, save: 0, give: 0, invest: 0, goal: 0 };
  for (const c of wallets) {
    for (const k of Object.keys(bucketTotals) as BucketKind[]) {
      bucketTotals[k] += c.buckets[k] ?? 0;
    }
  }

  const segments = (Object.entries(bucketTotals) as [BucketKind, number][])
    .filter(([, v]) => v > 0)
    .map(([k, v]) => ({ k, pct: (v / familyTotal) * 100, color: BUCKET_COLORS[k] }));

  return (
    <div className="flex-1">
      <div className="flex h-2 w-full overflow-hidden rounded-full">
        {segments.map(({ k, pct, color }) => (
          <div key={k} style={{ width: `${pct}%`, background: color }} className="transition-all" />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
        {segments.map(({ k, pct }) => (
          <span key={k} className="flex items-center gap-1 text-[10px] text-muted">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: BUCKET_COLORS[k] }} />
            {k.charAt(0).toUpperCase() + k.slice(1)} {Math.round(pct)}%
          </span>
        ))}
      </div>
    </div>
  );
}

function ChildRow({ child, familyTotal }: { child: TreasuryChild; familyTotal: number }) {
  const share = familyTotal > 0 ? Math.round((child.total / familyTotal) * 100) : 0;
  const goalPct = child.goalTargetCents > 0 ? Math.min(100, Math.round((child.goalSavedCents / child.goalTargetCents) * 100)) : null;

  return (
    <Link href={`/wallet/wallets/${child.id}`}
      className="flex items-center gap-3 rounded-2xl border border-border bg-surface/40 p-4 transition hover:border-brand/30 hover:bg-brand/5">
      <Avatar name={child.name} color={child.color ?? undefined} size={40} className="rounded-full flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold">{child.name}</p>
          <p className="text-sm font-bold">{formatCents(child.total)}</p>
        </div>
        {/* Bucket bar */}
        {child.total > 0 && (
          <div className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full">
            {(Object.entries(child.buckets) as [BucketKind, number][])
              .filter(([, v]) => v > 0)
              .map(([k, v]) => (
                <div key={k} style={{ width: `${(v / child.total) * 100}%`, background: BUCKET_COLORS[k] }} />
              ))}
          </div>
        )}
        <div className="mt-1 flex items-center gap-3 text-[11px] text-muted">
          <span>{share}% of family</span>
          {child.activeGoals > 0 && (
            <span className="flex items-center gap-0.5 text-brand">
              <Target className="h-2.5 w-2.5" />
              {goalPct != null ? `${goalPct}% to goal` : `${child.activeGoals} goal${child.activeGoals !== 1 ? 's' : ''}`}
            </span>
          )}
          {child.monthlyIn > 0 && (
            <span className="flex items-center gap-0.5 text-emerald-400">
              +{formatCents(child.monthlyIn)} this month
            </span>
          )}
        </div>
      </div>
      <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted" />
    </Link>
  );
}

function TrendChart({ trend }: { trend: { label: string; credits: number; debits: number }[] }) {
  const maxVal = Math.max(...trend.flatMap((t) => [t.credits, t.debits]), 1);
  return (
    <div className="flex h-32 items-end gap-1.5">
      {trend.map((t, i) => (
        <div key={i} className="flex flex-1 flex-col items-center gap-1">
          <div className="flex w-full flex-col items-center gap-0.5">
            <div
              className="w-full rounded-t bg-emerald-500/30 transition-all"
              style={{ height: `${(t.credits / maxVal) * 80}px` }}
              title={`In: ${formatCents(t.credits)}`}
            />
            <div
              className="w-full rounded-t bg-rose-500/30 transition-all"
              style={{ height: `${(t.debits / maxVal) * 80}px` }}
              title={`Out: ${formatCents(t.debits)}`}
            />
          </div>
          <p className="text-[9px] text-muted">{t.label}</p>
        </div>
      ))}
    </div>
  );
}
