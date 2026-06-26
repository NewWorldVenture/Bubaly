import type { Metadata } from 'next';
import { createServiceClient } from '@/lib/supabase/server';
import { Wallet, Users, TrendingUp, Clock, CheckCircle2, AlertCircle, Receipt } from 'lucide-react';

export const metadata: Metadata = { title: 'Wallet Admin — Bubaly' };

function StatCard({ label, value, icon: Icon, sub }: { label: string; value: string | number; icon: React.ElementType; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface/50 p-4">
      <div className="flex items-center gap-2 text-muted mb-1">
        <Icon className="h-4 w-4" />
        <span className="text-xs font-medium">{label}</span>
      </div>
      <p className="text-2xl font-bold text-fg">{value}</p>
      {sub && <p className="text-xs text-muted mt-0.5">{sub}</p>}
    </div>
  );
}

export default async function AdminWalletPage() {
  const supabase = createServiceClient();

  const [
    { count: familyWalletCount },
    { count: childWalletCount },
    { count: txnCount, data: recentTxns },
    { data: pendingApprovals },
    { data: recentAuditLogs },
    { data: topFamilies },
  ] = await Promise.all([
    supabase.from('family_wallets').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('child_wallets').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('wallet_transactions').select('id, amount_cents, direction, status, created_at', { count: 'exact' })
      .eq('status', 'completed').order('created_at', { ascending: false }).limit(10),
    supabase.from('parent_approvals').select('id, family_id, kind, amount_cents, status, created_at')
      .eq('status', 'pending').order('created_at', { ascending: false }).limit(20),
    supabase.from('wallet_audit_logs').select('id, family_id, action, detail, created_at')
      .order('created_at', { ascending: false }).limit(25),
    supabase.from('wallet_transactions').select('family_id').eq('status', 'completed').limit(5000),
  ]);

  // Tally total volume
  const totalCreditCents = (recentTxns ?? []).filter((t) => t.direction === 'credit').reduce((s, t) => s + t.amount_cents, 0);

  // Count activity per family for top families
  const familyActivity = new Map<string, number>();
  for (const t of topFamilies ?? []) {
    familyActivity.set(t.family_id, (familyActivity.get(t.family_id) ?? 0) + 1);
  }
  const topFamilyList = Array.from(familyActivity.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  function StatusBadge({ status }: { status: string }) {
    const map: Record<string, string> = {
      pending: 'bg-amber-500/10 text-amber-400',
      approved: 'bg-emerald-500/10 text-emerald-400',
      rejected: 'bg-red-500/10 text-red-400',
      completed: 'bg-emerald-500/10 text-emerald-400',
    };
    return (
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${map[status] ?? 'bg-surface text-muted'}`}>
        {status}
      </span>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-fg">Wallet Console</h1>
        <p className="text-sm text-muted">Platform-wide family wallet status and activity</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Active family wallets" value={familyWalletCount ?? 0} icon={Wallet} />
        <StatCard label="Child wallets" value={childWalletCount ?? 0} icon={Users} />
        <StatCard label="Completed transactions" value={txnCount ?? 0} icon={Receipt} />
        <StatCard label="Pending approvals" value={pendingApprovals?.length ?? 0} icon={Clock} sub="Require parent action" />
      </div>

      {/* Pending approvals */}
      {(pendingApprovals?.length ?? 0) > 0 && (
        <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-3 border-b border-amber-500/20">
            <AlertCircle className="h-4 w-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-amber-300">Pending Parent Approvals ({pendingApprovals?.length})</h2>
          </div>
          <div className="divide-y divide-amber-500/10">
            {(pendingApprovals ?? []).map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                <div className="flex-1">
                  <span className="font-medium text-fg capitalize">{a.kind.replace(/_/g, ' ')}</span>
                  {a.amount_cents && (
                    <span className="ml-2 text-muted">${(a.amount_cents / 100).toFixed(2)}</span>
                  )}
                </div>
                <StatusBadge status={a.status} />
                <span className="text-xs text-muted">{new Date(a.created_at).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recent transactions */}
      <section className="rounded-xl border border-border bg-surface/50 overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border">
          <TrendingUp className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold text-fg">Recent Transactions</h2>
        </div>
        {(recentTxns ?? []).length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted">No transactions yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {(recentTxns ?? []).map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                <span className={t.direction === 'credit' ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'}>
                  {t.direction === 'credit' ? '+' : '−'}${(t.amount_cents / 100).toFixed(2)}
                </span>
                <span className="flex-1 text-muted">{t.status}</span>
                <span className="text-xs text-muted">{new Date(t.created_at).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Top families by activity */}
      <section className="rounded-xl border border-border bg-surface/50 overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border">
          <CheckCircle2 className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold text-fg">Most Active Families</h2>
        </div>
        {topFamilyList.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted">No activity yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {topFamilyList.map(([familyId, count]) => (
              <div key={familyId} className="flex items-center justify-between px-5 py-3 text-sm">
                <span className="font-mono text-xs text-muted">{familyId.slice(0, 8)}…</span>
                <span className="font-semibold text-fg">{count} txns</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Audit log */}
      <section className="rounded-xl border border-border bg-surface/50 overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border">
          <Receipt className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold text-fg">Recent Audit Log</h2>
        </div>
        <div className="divide-y divide-border">
          {(recentAuditLogs ?? []).map((l) => (
            <div key={l.id} className="flex items-center gap-3 px-5 py-3 text-sm">
              <span className="font-mono text-xs text-brand rounded px-1.5 py-0.5 bg-brand/10">{l.action}</span>
              <span className="flex-1 truncate text-muted text-xs">{l.detail?.slice(0, 60)}</span>
              <span className="text-xs text-muted whitespace-nowrap">{new Date(l.created_at).toLocaleDateString()}</span>
            </div>
          ))}
          {(recentAuditLogs ?? []).length === 0 && (
            <p className="px-5 py-4 text-sm text-muted">No audit entries yet.</p>
          )}
        </div>
      </section>
    </div>
  );
}
