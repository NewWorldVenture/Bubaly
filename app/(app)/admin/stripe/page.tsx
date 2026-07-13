import type { Metadata } from 'next';
import { CreditCard, Landmark, ShieldCheck, AlertTriangle, Radio, ToggleLeft, ToggleRight } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getMoneyCapabilities, type MoneyCapabilities } from '@/lib/stripe/capabilities';
import { StripeSetupForm } from '@/components/admin/stripe-setup-form';

export const metadata: Metadata = { title: 'Admin · Money', robots: { index: false } };
export const dynamic = 'force-dynamic';

const MONEY_FLAG_KEYS = [
  'stripe_payments_enabled', 'stripe_connect_enabled', 'stripe_treasury_enabled',
  'stripe_issuing_enabled', 'physical_cards_enabled', 'custom_card_designs_enabled',
];

function Stat({ label, value, icon: Icon, tone = 'neutral' }: {
  label: string; value: string | number; icon: typeof CreditCard; tone?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  const color = tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-danger' : 'text-brand-text';
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-muted"><Icon className={`h-4 w-4 ${color}`} /><span className="text-xs">{label}</span></div>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </Card>
  );
}

function CapRow({ label, on }: { label: string; on: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-border py-2 last:border-0">
      <span className="text-sm">{label}</span>
      <Badge tone={on ? 'success' : 'neutral'}>{on ? 'Available' : 'Off'}</Badge>
    </div>
  );
}

export default async function AdminStripeMoneyPage() {
  const supabase = createServiceClient();
  const caps: MoneyCapabilities = await getMoneyCapabilities(supabase);
  const { data: stripeCfg } = await supabase.from('stripe_settings').select('*').eq('id', 'singleton').maybeSingle();

  const [
    { data: flags }, { data: accounts }, { count: financialCount },
    { data: cards }, { data: auths }, { data: webhooks },
  ] = await Promise.all([
    supabase.from('feature_flags').select('key, enabled').in('key', MONEY_FLAG_KEYS),
    supabase.from('stripe_connected_accounts').select('status'),
    supabase.from('stripe_financial_accounts').select('id', { count: 'exact', head: true }),
    supabase.from('stripe_issuing_cards').select('status'),
    supabase.from('stripe_authorizations').select('outcome, decline_reason, merchant_name, amount_cents, created_at').order('created_at', { ascending: false }).limit(20),
    supabase.from('stripe_webhook_events').select('status'),
  ]);

  const flagOn = new Map((flags ?? []).map((f) => [f.key, f.enabled]));
  const acctRows = accounts ?? [];
  const enabledAccounts = acctRows.filter((a) => a.status === 'enabled').length;
  const cardRows = cards ?? [];
  const activeCards = cardRows.filter((c) => c.status === 'active').length;
  const authRows = auths ?? [];
  const declined = authRows.filter((a) => a.outcome === 'declined');
  const webhookErrors = (webhooks ?? []).filter((w) => w.status === 'error').length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Money — Stripe Financial Mode</h1>
        <p className="mt-1 text-sm text-muted">Platform oversight for Bubaly Money. Capability detection decides ledger vs Stripe mode at runtime.</p>
      </div>

      {/* Configurable Bubaly Stripe account + service fee */}
      <StripeSetupForm
        initial={{
          enabled: stripeCfg?.enabled ?? false,
          publishableKey: stripeCfg?.publishable_key ?? '',
          connectAccountId: stripeCfg?.connect_account_id ?? '',
          serviceFeeCents: stripeCfg?.service_fee_cents ?? 90,
          serviceFeePriceId: stripeCfg?.service_fee_price_id ?? '',
          hasSecret: Boolean(stripeCfg?.secret_key),
          hasWebhook: Boolean(stripeCfg?.webhook_secret),
          envSecretSet: Boolean(process.env.STRIPE_SECRET_KEY),
        }}
      />

      {/* Runtime mode */}
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Radio className="h-5 w-5 text-brand-text" />
            <span className="font-semibold">Runtime mode</span>
          </div>
          <Badge tone={caps.mode === 'stripe' ? 'success' : 'neutral'}>
            {caps.mode === 'stripe' ? 'Stripe mode' : 'Virtual ledger'}
          </Badge>
        </div>
        {caps.reason && <p className="mt-2 text-sm text-muted">{caps.reason}</p>}
        <div className="mt-3 grid gap-x-8 sm:grid-cols-2">
          <div>
            <CapRow label="Funded payments (Checkout)" on={caps.payments} />
            <CapRow label="Parent onboarding" on={caps.connectOnboarding} />
            <CapRow label="Financial accounts" on={caps.treasury} />
          </div>
          <div>
            <CapRow label="Card issuing" on={caps.issuing} />
            <CapRow label="Physical cards" on={caps.physicalCards} />
            <CapRow label="Custom card designs" on={caps.customCardDesigns} />
          </div>
        </div>
      </Card>

      {/* Aggregate stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Onboarded families" value={`${enabledAccounts}/${acctRows.length}`} icon={ShieldCheck} tone="success" />
        <Stat label="Financial accounts" value={financialCount ?? 0} icon={Landmark} />
        <Stat label="Active cards" value={activeCards} icon={CreditCard} />
        <Stat label="Declines (recent)" value={declined.length} icon={AlertTriangle} tone={declined.length ? 'warning' : 'neutral'} />
        <Stat label="Webhook errors" value={webhookErrors} icon={Radio} tone={webhookErrors ? 'danger' : 'success'} />
      </div>

      {/* Feature flags */}
      <Card className="p-5">
        <h2 className="mb-3 font-semibold">Feature flags</h2>
        <div className="space-y-1">
          {MONEY_FLAG_KEYS.map((k) => {
            const on = flagOn.get(k) ?? false;
            return (
              <div key={k} className="flex items-center justify-between border-b border-border py-2 last:border-0">
                <code className="text-xs text-muted">{k}</code>
                {on
                  ? <span className="inline-flex items-center gap-1 text-sm text-success"><ToggleRight className="h-4 w-4" /> on</span>
                  : <span className="inline-flex items-center gap-1 text-sm text-muted"><ToggleLeft className="h-4 w-4" /> off</span>}
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-muted">Toggle these in the database (service role) once your Stripe account has the matching capability approved.</p>
      </Card>

      {/* Recent authorizations */}
      <Card className="p-5">
        <h2 className="mb-3 font-semibold">Recent card authorizations</h2>
        {authRows.length === 0 ? (
          <p className="text-sm text-muted">No authorizations yet.</p>
        ) : (
          <div className="space-y-1">
            {authRows.map((a, i) => (
              <div key={i} className="flex items-center justify-between border-b border-border py-2 text-sm last:border-0">
                <span className="truncate">{a.merchant_name ?? 'Purchase'}</span>
                <span className="flex items-center gap-2">
                  <span className="text-muted">${(a.amount_cents / 100).toFixed(2)}</span>
                  <Badge tone={a.outcome === 'approved' ? 'success' : 'danger'}>
                    {a.outcome === 'approved' ? 'approved' : (a.decline_reason ?? 'declined')}
                  </Badge>
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
