'use client';

import { useMemo, useState } from 'react';
import { History, Search, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { PageHeader } from '@/components/app/page-header';
import { SkeletonList, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import { usd, fmtDueDate } from '@/lib/finance/hub';

type Txn = Tables<'transactions'>;
const FILTERS = ['all', 'income', 'expense', 'transfer'] as const;

export function PaymentsView() {
  const { familyId } = useApp();

  const { data: rows, loading } = useRealtimeQuery<Txn>({
    table: 'transactions', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('transactions').select('*').eq('family_id', familyId).order('date', { ascending: false }).limit(500),
  });

  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const txns = useMemo(() => rows ?? [], [rows]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return txns.filter((t) =>
      (filter === 'all' || t.type === filter) &&
      (!s || t.name.toLowerCase().includes(s) || (t.category?.toLowerCase().includes(s) ?? false)),
    );
  }, [txns, q, filter]);

  const byMonth = useMemo(() => {
    const m = new Map<string, Txn[]>();
    for (const t of filtered) {
      const key = t.date.slice(0, 7);
      const a = m.get(key) ?? []; a.push(t); m.set(key, a);
    }
    return [...m.entries()];
  }, [filtered]);

  return (
    <div className="module-page">
      <PageHeader title="Payment History" description="Every transaction across your family's accounts." />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={cn('rounded-lg px-3 py-1.5 text-xs font-semibold capitalize transition', filter === f ? 'bg-brand/15 text-brand' : 'text-muted hover:bg-elevated hover:text-fg')}>{f}</button>
          ))}
        </div>
        <div className="relative sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search payments"
            className="h-10 w-full rounded-xl border border-border bg-surface/60 pl-9 pr-3 text-sm outline-none focus:border-brand" />
        </div>
      </div>

      {loading ? <SkeletonList /> : filtered.length === 0 ? (
        <EmptyState icon={History} title="No payments" description={q || filter !== 'all' ? 'No transactions match your filters.' : 'Transactions will appear here as they are added.'} />
      ) : (
        <div className="space-y-5">
          {byMonth.map(([month, items]) => (
            <section key={month}>
              <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">
                {new Date(`${month}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
              </h2>
              <div className="space-y-1.5">
                {items.map((t) => {
                  const income = t.type === 'income';
                  return (
                    <div key={t.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5">
                      <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', income ? 'bg-emerald-500/15 text-emerald-400' : 'bg-elevated text-muted')}>
                        {income ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{t.merchant || t.name}</p>
                        <p className="truncate text-xs text-muted">{fmtDueDate(t.date)}{t.category ? ` · ${t.category}` : ''} · <span className="capitalize">{t.status}</span></p>
                      </div>
                      <p className={cn('text-sm font-bold tabular-nums', income ? 'text-emerald-400' : 'text-fg')}>{income ? '+' : '-'}{usd(Math.abs(Number(t.amount)))}</p>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
