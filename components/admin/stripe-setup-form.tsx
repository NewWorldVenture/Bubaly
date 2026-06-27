'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CreditCard, KeyRound, Percent, Save } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Input, Field } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { saveStripeSettingsAction } from '@/app/(app)/admin/actions';

export type StripeSetupInitial = {
  enabled: boolean;
  publishableKey: string;
  connectAccountId: string;
  serviceFeeCents: number;
  serviceFeePriceId: string;
  hasSecret: boolean;
  hasWebhook: boolean;
  envSecretSet: boolean;
};

export function StripeSetupForm({ initial }: { initial: StripeSetupInitial }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);

  const [enabled, setEnabled] = useState(initial.enabled);
  const [feeDollars, setFeeDollars] = useState((initial.serviceFeeCents / 100).toFixed(2));
  const [feePriceId, setFeePriceId] = useState(initial.serviceFeePriceId);
  const [publishableKey, setPublishableKey] = useState(initial.publishableKey);
  const [connectAccountId, setConnectAccountId] = useState(initial.connectAccountId);
  const [secretKey, setSecretKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const dollars = Number(feeDollars);
    if (!Number.isFinite(dollars) || dollars < 0) { toastError('Enter a valid service fee'); return; }
    setSaving(true);
    const res = await saveStripeSettingsAction({
      enabled,
      publishableKey: publishableKey || null,
      secretKey: secretKey || null,         // blank = keep existing
      webhookSecret: webhookSecret || null, // blank = keep existing
      connectAccountId: connectAccountId || null,
      serviceFeeCents: Math.round(dollars * 100),
      serviceFeePriceId: feePriceId || null,
    });
    setSaving(false);
    if (!res.ok) return toastError(res.error);
    success('Stripe Setup saved');
    setSecretKey(''); setWebhookSecret('');
    router.refresh();
  }

  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center gap-2">
        <CreditCard className="h-4 w-4 text-brand" />
        <h2 className="font-semibold">Stripe Setup</h2>
      </div>
      <p className="mb-4 text-sm text-muted">
        Configure the Bubaly Stripe account and the per-transaction service fee paid to Bubaly. These override the environment defaults at runtime.
      </p>

      <form onSubmit={save} className="space-y-4">
        {/* Enable + service fee */}
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 rounded border-border" />
            Charge the service fee on transactions
          </label>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Service fee ($ per transaction)" required>
            {(id) => (
              <div className="relative">
                <Percent className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <Input id={id} type="number" min={0} step="0.01" value={feeDollars}
                  onChange={(e) => setFeeDollars(e.target.value)} className="pl-9" placeholder="0.90" />
              </div>
            )}
          </Field>
          <Field label="Service fee Stripe Price ID" hint="A one-time Price in the Bubaly account, added to checkout invoices.">
            {(id) => <Input id={id} value={feePriceId} onChange={(e) => setFeePriceId(e.target.value)} placeholder="price_…" />}
          </Field>
        </div>

        {/* Account credentials */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Publishable key">
            {(id) => <Input id={id} value={publishableKey} onChange={(e) => setPublishableKey(e.target.value)} placeholder="pk_live_…" />}
          </Field>
          <Field label="Connect / platform account ID" hint="Bubaly platform account for routing application fees.">
            {(id) => <Input id={id} value={connectAccountId} onChange={(e) => setConnectAccountId(e.target.value)} placeholder="acct_…" />}
          </Field>
          <Field label="Secret key" hint={initial.hasSecret ? 'Saved — leave blank to keep.' : initial.envSecretSet ? 'Using env STRIPE_SECRET_KEY — enter to override.' : 'Not set.'}>
            {(id) => <Input id={id} type="password" autoComplete="off" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} placeholder={initial.hasSecret ? '•••••••• saved' : 'sk_live_…'} />}
          </Field>
          <Field label="Webhook signing secret" hint={initial.hasWebhook ? 'Saved — leave blank to keep.' : 'Not set.'}>
            {(id) => <Input id={id} type="password" autoComplete="off" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder={initial.hasWebhook ? '•••••••• saved' : 'whsec_…'} />}
          </Field>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button type="submit" disabled={saving} className="gap-1.5">
            {saving ? 'Saving…' : <><Save className="h-4 w-4" /> Save Stripe Setup</>}
          </Button>
          <span className="inline-flex items-center gap-1 text-xs text-muted"><KeyRound className="h-3.5 w-3.5" /> Secrets are stored server-side and never sent back to the browser.</span>
        </div>
      </form>
    </Card>
  );
}
