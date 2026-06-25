import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { withStripeTables } from '@/lib/supabase/stripe-tables';
import { isManager } from '@/lib/constants/roles';
import { redirect } from 'next/navigation';
import { MoneyNav } from '@/components/money/money-nav';
import { EMPTY_CAPABILITIES, getOrRefreshCapabilities, capabilityLabel } from '@/lib/stripe/capabilities';
import { ShieldCheck, ExternalLink, CheckCircle2, Clock, AlertCircle, XCircle } from 'lucide-react';

export const metadata: Metadata = { title: 'Settings — Bubaly Money' };

export default async function MoneySettingsPage() {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) redirect('/money');

  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const db = withStripeTables(supabase);

  const { data: account } = await db
    .from('stripe_connected_accounts')
    .select('account_id, status, charges_enabled, payouts_enabled, details_submitted')
    .eq('family_id', familyId)
    .maybeSingle();

  let capabilities = EMPTY_CAPABILITIES;
  try {
    capabilities = await getOrRefreshCapabilities(supabase, familyId, account?.account_id ?? null);
  } catch {}

  const CAP_ROWS = [
    { label: 'Payments',            status: capabilities.payments },
    { label: 'Card issuing',        status: capabilities.issuing },
    { label: 'Virtual cards',       status: capabilities.virtualCards },
    { label: 'Physical cards',      status: capabilities.physicalCards },
    { label: 'Treasury',            status: capabilities.treasury },
    { label: 'ACH transfers',       status: capabilities.ach },
    { label: 'Instant payout',      status: capabilities.instantPayout },
    { label: 'Card personalization',status: capabilities.cardPersonalization },
    { label: 'Real-time auth',      status: capabilities.realtimeAuthorizations },
  ] as const;

  function StatusIcon({ status }: { status: string }) {
    if (status === 'enabled') return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    if (status === 'pending_review') return <Clock className="h-4 w-4 text-amber-500" />;
    if (status === 'action_required') return <AlertCircle className="h-4 w-4 text-red-500" />;
    return <XCircle className="h-4 w-4 text-muted" />;
  }

  return (
    <div className="space-y-6">
      <MoneyNav />

      <div>
        <h1 className="text-2xl font-bold text-fg">Money settings</h1>
        <p className="text-sm text-muted">Stripe account and capability status</p>
      </div>

      {/* Account info */}
      <section className="rounded-xl border border-border bg-surface/50 p-5 space-y-4">
        <h2 className="font-semibold text-fg">Stripe account</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-sm">
          <div>
            <p className="text-xs text-muted">Account ID</p>
            <p className="font-mono text-fg text-xs truncate">{account?.account_id ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs text-muted">Status</p>
            <p className="font-medium text-fg capitalize">{account?.status ?? 'Not set up'}</p>
          </div>
          <div>
            <p className="text-xs text-muted">Charges</p>
            <p className={`font-medium ${account?.charges_enabled ? 'text-green-600' : 'text-muted'}`}>
              {account?.charges_enabled ? 'Enabled' : 'Disabled'}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted">Mode</p>
            <p className={`font-medium ${capabilities.stripeMode === 'live' ? 'text-green-600' : capabilities.stripeMode === 'test' ? 'text-amber-600' : 'text-muted'}`}>
              {capabilities.stripeMode === 'live' ? 'Live' : capabilities.stripeMode === 'test' ? 'Test' : 'Unconfigured'}
            </p>
          </div>
        </div>
        {account && !account.charges_enabled && (
          <div className="flex gap-3">
            <a href="/money/setup"
              className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-fg hover:bg-elevated">
              <ExternalLink className="h-3.5 w-3.5" /> Complete setup
            </a>
          </div>
        )}
      </section>

      {/* Capability matrix */}
      <section className="rounded-xl border border-border bg-surface/50 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="font-semibold text-fg">Capabilities</h2>
          <span className="text-xs text-muted">
            Last checked: {capabilities.lastCheckedAt ? new Date(capabilities.lastCheckedAt).toLocaleString() : 'Never'}
          </span>
        </div>
        <div className="divide-y divide-border">
          {CAP_ROWS.map((row) => (
            <div key={row.label} className="flex items-center justify-between px-5 py-3">
              <p className="text-sm text-fg">{row.label}</p>
              <div className="flex items-center gap-2">
                <StatusIcon status={row.status} />
                <span className="text-xs text-muted">{capabilityLabel(row.status)}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Missing requirements */}
      {capabilities.missingRequirements.length > 0 && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-5 dark:border-amber-800 dark:bg-amber-950/30">
          <h2 className="mb-2 font-semibold text-amber-900 dark:text-amber-100">Action required</h2>
          <ul className="space-y-1">
            {capabilities.missingRequirements.map((req) => (
              <li key={req} className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-300">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="font-mono text-xs">{req}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex items-start gap-3 rounded-xl border border-border bg-surface/50 p-4 text-xs text-muted">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <p>Stripe capabilities are cached and refreshed automatically. To force a refresh, visit <a href="/money" className="text-brand hover:underline">Money overview</a> and click &ldquo;Refresh capabilities&rdquo;.</p>
      </div>
    </div>
  );
}
