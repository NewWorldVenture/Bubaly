import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { createServiceClient } from '@/lib/supabase/server';
import { balanceFromLedger, bucketBalances, formatCents, type LedgerEntry, type BucketKind } from '@/lib/wallet/ledger';
import { ArrowLeft, Wallet, Users, Receipt, Clock, CheckCircle2, AlertCircle } from 'lucide-react';

export const metadata: Metadata = { title: 'Family Wallet — Admin' };

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: 'bg-amber-500/10 text-amber-400',
    approved: 'bg-emerald-500/10 text-emerald-400',
    rejected: 'bg-red-500/10 text-red-400',
    completed: 'bg-emerald-500/10 text-emerald-400',
    credit: 'bg-emerald-500/10 text-emerald-400',
    debit: 'bg-red-500/10 text-red-400',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${map[status] ?? 'bg-surface text-muted'}`}>
      {status}
    </span>
  );
}

export default async function AdminWalletFamilyPage({ params }: { params: Promise<{ familyId: string }> }) {
  const { familyId } = await params;
  const supabase = createServiceClient();

  const [
    { data: family },
    { data: wallet },
    { data: childWallets },
    { data: buckets },
    { data: txns },
    { data: members },
    { data: pendingApprovals },
    { data: auditLogs },
  ] = await Promise.all([
    supabase.from('families').select('id, name').eq('id', familyId).maybeSingle(),
    supabase.from('family_wallets').select('id, is_active, mode, created_at').eq('family_id', familyId).maybeSingle(),
    supabase.from('child_wallets').select('id, member_id, is_active').eq('family_id', familyId),
    supabase.from('wallet_buckets').select('id, child_wallet_id, kind').eq('family_id', familyId),
    supabase.from('wallet_transactions')
      .select('id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, created_at')
      .eq('family_id', familyId)
      .order('created_at', { ascending: false })
      .limit(200),
    supabase.from('family_members').select('id, display_name, role').eq('family_id', familyId),
    supabase.from('parent_approvals')
      .select('id, kind, amount_cents, status, created_at')
      .eq('family_id', familyId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false }),
    supabase.from('wallet_audit_logs')
      .select('id, action, detail, actor_user_id, created_at')
      .eq('family_id', familyId)
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  if (!family) return notFound();

  const memberById = new Map((members ?? []).map((m) => [m.id, m]));
  const bucketKindById = new Map((buckets ?? []).map((b) => [b.id, b.kind as BucketKind]));

  const entriesByChild = new Map<string, LedgerEntry[]>();
  for (const t of txns ?? []) {
    if (!t.child_wallet_id) continue;
    const arr = entriesByChild.get(t.child_wallet_id) ?? [];
    arr.push({
      direction: t.direction,
      amount_cents: t.amount_cents,
      status: t.status,
      bucket_kind: t.bucket_id ? bucketKindById.get(t.bucket_id) ?? null : null,
    });
    entriesByChild.set(t.child_wallet_id, arr);
  }

  const childViews = (childWallets ?? []).map((cw) => {
    const entries = entriesByChild.get(cw.id) ?? [];
    const member = memberById.get(cw.member_id);
    return {
      id: cw.id,
      name: member?.display_name ?? 'Child',
      isActive: cw.is_active,
      total: balanceFromLedger(entries),
      buckets: bucketBalances(entries),
    };
  });

  const familyTotal = childViews.reduce((s, c) => s + c.total, 0);
  const recentTxns = (txns ?? []).slice(0, 30);

  return (
    <div className="space-y-8">
      {/* Back + header */}
      <div>
        <Link href="/admin/wallet" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg mb-4">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Wallet Console
        </Link>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-fg">{family.name}</h1>
            <p className="text-sm text-muted font-mono">{familyId}</p>
          </div>
          {wallet && (
            <div className="flex items-center gap-2">
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${wallet.is_active ? 'bg-emerald-500/10 text-emerald-400' : 'bg-surface text-muted'}`}>
                {wallet.is_active ? 'Wallet active' : 'Wallet inactive'}
              </span>
              <span className="rounded-full px-3 py-1 text-xs font-medium bg-surface/50 text-muted capitalize">
                {wallet.mode ?? 'virtual'} mode
              </span>
            </div>
          )}
        </div>
      </div>

      {!wallet && (
        <div className="rounded-xl border border-border bg-surface/50 p-6 text-center text-muted text-sm">
          This family has not activated their wallet yet.
        </div>
      )}

      {wallet && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-border bg-surface/50 p-4">
              <div className="flex items-center gap-2 text-muted mb-1"><Wallet className="h-4 w-4" /><span className="text-xs">Family total</span></div>
              <p className="text-2xl font-bold text-fg">{formatCents(familyTotal)}</p>
            </div>
            <div className="rounded-xl border border-border bg-surface/50 p-4">
              <div className="flex items-center gap-2 text-muted mb-1"><Users className="h-4 w-4" /><span className="text-xs">Child wallets</span></div>
              <p className="text-2xl font-bold text-fg">{childViews.length}</p>
            </div>
            <div className="rounded-xl border border-border bg-surface/50 p-4">
              <div className="flex items-center gap-2 text-muted mb-1"><Receipt className="h-4 w-4" /><span className="text-xs">Transactions</span></div>
              <p className="text-2xl font-bold text-fg">{(txns ?? []).length}</p>
            </div>
            <div className="rounded-xl border border-border bg-surface/50 p-4">
              <div className="flex items-center gap-2 text-muted mb-1"><Clock className="h-4 w-4" /><span className="text-xs">Pending approvals</span></div>
              <p className="text-2xl font-bold text-fg">{(pendingApprovals ?? []).length}</p>
            </div>
          </div>

          {/* Child wallet balances */}
          {childViews.length > 0 && (
            <section className="rounded-xl border border-border bg-surface/50 overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-3 border-b border-border">
                <Users className="h-4 w-4 text-muted" />
                <h2 className="text-sm font-semibold text-fg">Child Wallet Balances</h2>
              </div>
              <div className="divide-y divide-border">
                {childViews.map((c) => (
                  <div key={c.id} className="px-5 py-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-fg">{c.name}</span>
                        {!c.isActive && <span className="text-xs text-muted">(inactive)</span>}
                      </div>
                      <span className="text-lg font-bold text-fg">{formatCents(c.total)}</span>
                    </div>
                    <div className="grid grid-cols-4 gap-2 text-xs">
                      {(['spend', 'save', 'give', 'invest'] as BucketKind[]).map((k) => (
                        <div key={k} className="rounded-lg bg-elevated px-2 py-1.5 text-center">
                          <p className="capitalize text-muted">{k}</p>
                          <p className="font-semibold text-fg mt-0.5">{formatCents(c.buckets[k] ?? 0)}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Pending approvals alert */}
          {(pendingApprovals ?? []).length > 0 && (
            <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-3 border-b border-amber-500/20">
                <AlertCircle className="h-4 w-4 text-amber-400" />
                <h2 className="text-sm font-semibold text-amber-300">Pending Approvals ({(pendingApprovals ?? []).length})</h2>
              </div>
              <div className="divide-y divide-amber-500/10">
                {(pendingApprovals ?? []).map((a) => (
                  <div key={a.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                    <span className="flex-1 font-medium text-fg capitalize">{a.kind.replace(/_/g, ' ')}</span>
                    {a.amount_cents && <span className="text-muted">{formatCents(a.amount_cents)}</span>}
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
              <Receipt className="h-4 w-4 text-muted" />
              <h2 className="text-sm font-semibold text-fg">Recent Transactions (last {recentTxns.length})</h2>
            </div>
            {recentTxns.length === 0 ? (
              <p className="px-5 py-4 text-sm text-muted">No transactions yet.</p>
            ) : (
              <div className="divide-y divide-border">
                {recentTxns.map((t) => {
                  const childMember = t.child_wallet_id
                    ? memberById.get((childWallets ?? []).find((c) => c.id === t.child_wallet_id)?.member_id ?? '')
                    : null;
                  return (
                    <div key={t.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                      <span className={t.direction === 'credit' ? 'font-semibold text-emerald-400 w-20 shrink-0' : 'font-semibold text-red-400 w-20 shrink-0'}>
                        {t.direction === 'credit' ? '+' : '−'}{formatCents(t.amount_cents)}
                      </span>
                      <span className="font-mono text-xs text-brand bg-brand/10 rounded px-1.5 py-0.5 shrink-0">{t.type}</span>
                      <span className="flex-1 truncate text-muted text-xs">{t.description ?? ''}</span>
                      {childMember && <span className="text-xs text-muted shrink-0">{childMember.display_name}</span>}
                      <StatusBadge status={t.status} />
                      <span className="text-xs text-muted shrink-0 whitespace-nowrap">{new Date(t.created_at).toLocaleDateString()}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Family members */}
          {(members ?? []).length > 0 && (
            <section className="rounded-xl border border-border bg-surface/50 overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-3 border-b border-border">
                <Users className="h-4 w-4 text-muted" />
                <h2 className="text-sm font-semibold text-fg">Family Members</h2>
              </div>
              <div className="divide-y divide-border">
                {(members ?? []).map((m) => (
                  <div key={m.id} className="flex items-center justify-between px-5 py-3 text-sm">
                    <span className="font-medium text-fg">{m.display_name}</span>
                    <span className="rounded-full px-2 py-0.5 text-xs bg-surface text-muted capitalize">{m.role}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Audit log */}
          {(auditLogs ?? []).length > 0 && (
            <section className="rounded-xl border border-border bg-surface/50 overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-3 border-b border-border">
                <CheckCircle2 className="h-4 w-4 text-muted" />
                <h2 className="text-sm font-semibold text-fg">Audit Log (last {(auditLogs ?? []).length})</h2>
              </div>
              <div className="divide-y divide-border">
                {(auditLogs ?? []).map((l) => (
                  <div key={l.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                    <span className="font-mono text-xs text-brand bg-brand/10 rounded px-1.5 py-0.5 shrink-0">{l.action}</span>
                    <span className="flex-1 truncate text-muted text-xs">{l.detail?.slice(0, 80)}</span>
                    <span className="text-xs text-muted shrink-0 whitespace-nowrap">{new Date(l.created_at).toLocaleDateString()}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
