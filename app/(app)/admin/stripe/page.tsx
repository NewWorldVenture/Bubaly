import type { Metadata } from 'next';
import { createServiceClient } from '@/lib/supabase/server';
import { detectPlatformCapabilities, capabilityLabel } from '@/lib/stripe/capabilities';
import { CheckCircle2, Clock, AlertCircle, XCircle, CreditCard, Users, Zap } from 'lucide-react';

export const metadata: Metadata = { title: 'Stripe Admin — Bubaly' };

export default async function AdminStripePage() {
  const supabase = createServiceClient();
  const db = supabase as unknown as Record<'from', (t: string) => ReturnType<typeof supabase.from>>;

  const [
    { data: accounts, count: accountCount },
    { data: cards, count: cardCount },
    { data: checkouts },
    { data: webhookEvents },
    { data: recentAuths },
    platformCaps,
  ] = await Promise.all([
    db.from('stripe_connected_accounts').select('family_id, status, charges_enabled, payouts_enabled, created_at', { count: 'exact' }).order('created_at', { ascending: false }).limit(20),
    db.from('stripe_issuing_cards').select('id', { count: 'exact', head: true }).neq('status', 'canceled'),
    db.from('stripe_checkout_sessions').select('id, type, status, amount_cents, created_at').order('created_at', { ascending: false }).limit(10),
    db.from('stripe_webhook_events').select('id, type, status, created_at').order('created_at', { ascending: false }).limit(20),
    db.from('stripe_authorizations').select('id, status, decision, amount_cents, merchant_name, authorized_at').order('authorized_at', { ascending: false }).limit(10),
    detectPlatformCapabilities(),
  ]);

  const approvedAccounts = ((accounts ?? []) as Array<{ charges_enabled: boolean }>).filter((a) => a.charges_enabled).length;

  function StatusBadge({ status }: { status: string }) {
    const colors: Record<string, string> = {
      enabled: 'bg-green-100 text-green-700',
      pending_review: 'bg-amber-100 text-amber-700',
      action_required: 'bg-red-100 text-red-700',
      unavailable: 'bg-surface text-muted',
      disabled: 'bg-surface text-muted',
      processed: 'bg-green-100 text-green-700',
      failed: 'bg-red-100 text-red-700',
      pending: 'bg-amber-100 text-amber-700',
      active: 'bg-green-100 text-green-700',
      approved: 'bg-green-100 text-green-700',
      declined: 'bg-red-100 text-red-700',
    };
    return (
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${colors[status] ?? 'bg-surface text-muted'}`}>
        {status}
      </span>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-fg">Stripe Console</h1>
        <p className="text-sm text-muted">Platform-wide Stripe integration status</p>
      </div>

      {/* Platform capabilities */}
      <section className="rounded-xl border border-border bg-surface/50 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="font-semibold text-fg">Platform capabilities</h2>
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${
            platformCaps.stripeMode === 'live' ? 'bg-green-100 text-green-700'
            : platformCaps.stripeMode === 'test' ? 'bg-amber-100 text-amber-700'
            : 'bg-surface text-muted'
          }`}>
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {platformCaps.stripeMode}
          </span>
        </div>
        <div className="grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-3">
          {([
            ['Payments', platformCaps.payments],
            ['Issuing', platformCaps.issuing],
            ['Treasury', platformCaps.treasury],
            ['Virtual cards', platformCaps.virtualCards],
            ['Physical cards', platformCaps.physicalCards],
            ['ACH', platformCaps.ach],
          ] as const).map(([label, cap]) => (
            <div key={label} className="px-5 py-3">
              <p className="text-xs text-muted">{label}</p>
              <p className="mt-0.5 text-sm font-medium text-fg">{capabilityLabel(cap)}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-border bg-surface/50 p-4">
          <div className="mb-1 flex items-center gap-2 text-muted"><Users className="h-4 w-4" /><span className="text-xs">Connect accounts</span></div>
          <p className="text-2xl font-bold text-fg">{accountCount ?? 0}</p>
          <p className="text-xs text-muted">{approvedAccounts} approved</p>
        </div>
        <div className="rounded-xl border border-border bg-surface/50 p-4">
          <div className="mb-1 flex items-center gap-2 text-muted"><CreditCard className="h-4 w-4" /><span className="text-xs">Active cards</span></div>
          <p className="text-2xl font-bold text-fg">{cardCount ?? 0}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface/50 p-4">
          <div className="mb-1 flex items-center gap-2 text-muted"><Zap className="h-4 w-4" /><span className="text-xs">Webhook events</span></div>
          <p className="text-2xl font-bold text-fg">{(webhookEvents ?? []).length}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface/50 p-4">
          <div className="mb-1 flex items-center gap-2 text-muted"><CheckCircle2 className="h-4 w-4" /><span className="text-xs">Checkouts</span></div>
          <p className="text-2xl font-bold text-fg">{(checkouts ?? []).length}</p>
        </div>
      </div>

      {/* Connect accounts */}
      <section>
        <h2 className="mb-3 text-base font-semibold text-fg">Connect accounts</h2>
        <div className="rounded-xl border border-border bg-surface/50 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-elevated">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted">Family</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted">Status</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted">Charges</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted">Payouts</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {((accounts ?? []) as Array<{ family_id: string; status: string; charges_enabled: boolean; payouts_enabled: boolean; created_at: string }>).map((a) => (
                <tr key={a.family_id}>
                  <td className="px-4 py-2 font-mono text-xs text-muted">{a.family_id.slice(0, 8)}…</td>
                  <td className="px-4 py-2"><StatusBadge status={a.status} /></td>
                  <td className="px-4 py-2"><StatusBadge status={a.charges_enabled ? 'active' : 'pending'} /></td>
                  <td className="px-4 py-2"><StatusBadge status={a.payouts_enabled ? 'active' : 'pending'} /></td>
                  <td className="px-4 py-2 text-xs text-muted">{new Date(a.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
              {(accounts ?? []).length === 0 && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-xs text-muted">No Connect accounts yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Recent webhook events */}
      <section>
        <h2 className="mb-3 text-base font-semibold text-fg">Recent webhook events</h2>
        <div className="rounded-xl border border-border bg-surface/50 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-elevated">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted">Type</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted">Status</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {((webhookEvents ?? []) as Array<{ id: string; type: string; status: string; created_at: string }>).map((e) => (
                <tr key={e.id}>
                  <td className="px-4 py-2 font-mono text-xs">{e.type}</td>
                  <td className="px-4 py-2"><StatusBadge status={e.status} /></td>
                  <td className="px-4 py-2 text-xs text-muted">{new Date(e.created_at).toLocaleString()}</td>
                </tr>
              ))}
              {(webhookEvents ?? []).length === 0 && (
                <tr><td colSpan={3} className="px-4 py-6 text-center text-xs text-muted">No webhook events yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Recent authorizations */}
      {(recentAuths ?? []).length > 0 && (
        <section>
          <h2 className="mb-3 text-base font-semibold text-fg">Recent card authorizations</h2>
          <div className="rounded-xl border border-border bg-surface/50 divide-y divide-border">
            {((recentAuths ?? []) as Array<{ id: string; status: string; decision: string | null; amount_cents: number; merchant_name: string | null; authorized_at: string }>).map((auth) => (
              <div key={auth.id} className="flex items-center gap-3 px-4 py-3">
                <StatusBadge status={auth.decision ?? auth.status} />
                <p className="flex-1 truncate text-sm text-fg">{auth.merchant_name ?? 'Unknown'}</p>
                <p className="text-sm font-semibold text-fg">${(auth.amount_cents / 100).toFixed(2)}</p>
                <p className="text-xs text-muted">{new Date(auth.authorized_at).toLocaleDateString()}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
