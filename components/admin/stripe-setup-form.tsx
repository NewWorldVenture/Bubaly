'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CreditCard, KeyRound, Percent, Save, Plug, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Input, Field } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { saveStripeSettingsAction, testStripeConnectionAction } from '@/app/(app)/admin/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

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
  const t = useTranslations();
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
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    const res = await testStripeConnectionAction();
    setTesting(false);
    if (!res.ok) { setTestResult({ ok: false, text: res.error }); return; }
    const d = res.data!;
    setTestResult({ ok: true, text: `Connected · ${d.livemode ? 'LIVE' : 'test'} mode · ${d.currencies} settlement currenc${d.currencies === 1 ? 'y' : 'ies'}` });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const dollars = Number(feeDollars);
    if (!Number.isFinite(dollars) || dollars < 0) { toastError(t('stripeSetupForm.enterAValidServiceFee')); return; }
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
    success(t('stripeSetupForm.stripeSetupSaved'));
    setSecretKey(''); setWebhookSecret('');
    router.refresh();
  }

  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center gap-2">
        <CreditCard className="h-4 w-4 text-brand-text" />
        <h2 className="font-semibold">{t('stripeSetup.stripeSetup')}</h2>
      </div>
      <p className="mb-4 text-sm text-muted">{t('stripeSetupForm.configureTheBubalyStripeAccount')}</p>

      <form onSubmit={save} className="space-y-4">
        {/* Enable + service fee */}
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 rounded border-border" />
            {t('stripeSetup.chargeTheServiceFeeOnTransactions')}
          </label>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('stripeSetup.serviceFeePerTransaction')} required>
            {(id) => (
              <div className="relative">
                <Percent className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <Input id={id} type="number" min={0} step="0.01" value={feeDollars}
                  onChange={(e) => setFeeDollars(e.target.value)} className="pl-9" placeholder="0.90" />
              </div>
            )}
          </Field>
          <Field label={t('stripeSetup.serviceFeeStripePriceId')} hint={t('stripeSetupForm.aOneTimePriceIn')}>
            {(id) => <Input id={id} value={feePriceId} onChange={(e) => setFeePriceId(e.target.value)} placeholder="price_…" />}
          </Field>
        </div>

        {/* Account credentials */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('stripeSetup.publishableKey')}>
            {(id) => <Input id={id} value={publishableKey} onChange={(e) => setPublishableKey(e.target.value)} placeholder="pk_live_…" />}
          </Field>
          <Field label={t('stripeSetup.connectPlatformAccountId')} hint={t('stripeSetupForm.bubalyPlatformAccountForRouting')}>
            {(id) => <Input id={id} value={connectAccountId} onChange={(e) => setConnectAccountId(e.target.value)} placeholder="acct_…" />}
          </Field>
          <Field label={t('stripeSetup.secretKey')} hint={initial.hasSecret ? 'Saved — leave blank to keep.' : initial.envSecretSet ? 'Using env STRIPE_SECRET_KEY — enter to override.' : 'Not set.'}>
            {(id) => <Input id={id} type="password" autoComplete="off" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} placeholder={initial.hasSecret ? '•••••••• saved' : 'sk_live_…'} />}
          </Field>
          <Field label={t('stripeSetup.webhookSigningSecret')} hint={initial.hasWebhook ? 'Saved — leave blank to keep.' : 'Not set.'}>
            {(id) => <Input id={id} type="password" autoComplete="off" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder={initial.hasWebhook ? '•••••••• saved' : 'whsec_…'} />}
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button type="submit" disabled={saving} className="gap-1.5">
            {saving ? 'Saving…' : <><Save className="h-4 w-4" /> {t('stripeSetup.saveStripeSetup')}</>}
          </Button>
          <Button type="button" variant="outline" onClick={testConnection} disabled={testing} className="gap-1.5">
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />} {t('stripeSetup.testConnection')}
          </Button>
        </div>

        {testResult && (
          <p className={`flex items-center gap-1.5 text-sm ${testResult.ok ? 'text-success' : 'text-danger'}`}>
            {testResult.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
            {testResult.text}
          </p>
        )}

        <p className="inline-flex items-center gap-1 text-xs text-muted"><KeyRound className="h-3.5 w-3.5" />{' '}{t('stripeSetupForm.secretsAreStoredServerSide')}</p>
      </form>
    </Card>
  );
}
