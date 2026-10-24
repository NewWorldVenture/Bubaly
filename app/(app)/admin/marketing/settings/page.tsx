import type { Metadata } from 'next';
import Link from 'next/link';
import { CheckCircle2, CircleAlert, XCircle } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settle } from '@/lib/supabase/settle';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { saveSetting } from '../actions';
import { isTwilioConfigured } from '@/lib/guardian/twilio';
import { getAIConfigView, type AIConfigView } from '@/lib/ai/settings';
import { resolveStripeSecretKey, type StripeKeyResolution } from '@/lib/stripe/settings';
import { getTranslations } from '@/lib/i18n/server';
import { SubmitButton } from '@/components/ui/submit-button';

export const metadata: Metadata = { title: 'Marketing · Settings', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';

/**
 * `ready: null` is a status that was not read: the AI row when the app_settings
 * read failed, the Stripe row when Stripe Setup could not be read. It reads
 * Unavailable, not "Set OPENAI_API_KEY", since the key the app uses may well be
 * stored in the admin console. `env` is what a row that is not ready asks for,
 * so the AI row's is the variable: it used to name the key's source, which for
 * no key at all read "Set admin console". `source`, on a ready row, says where
 * its key came from.
 *
 * Stripe is ready on the key billing uses, Stripe Setup's first and the
 * environment's second (resolveStripeSecretKey); `!!process.env.STRIPE_SECRET_KEY`
 * read a deployment configured in Stripe Setup as "Set STRIPE_SECRET_KEY".
 */
function providerStatus(ai: AIConfigView | null, stripe: StripeKeyResolution, stripeSource: string | null): { name: string; ready: boolean | null; env: string; source?: string | null }[] {
  return [
    { name: 'Email (Resend)', ready: !!process.env.RESEND_API_KEY, env: 'RESEND_API_KEY' },
    { name: 'SMS (Twilio)', ready: isTwilioConfigured(), env: 'TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PHONE_NUMBER' },
    { name: 'AI (OpenAI)', ready: ai ? ai.openaiKeySet : null, env: 'OPENAI_API_KEY' },
    { name: 'Payments (Stripe)', ready: stripe.status === 'unreadable' ? null : stripe.status === 'resolved', env: 'STRIPE_SECRET_KEY', source: stripeSource },
    { name: 'Search Console', ready: !!process.env.GOOGLE_SEARCH_CONSOLE_KEY, env: 'GOOGLE_SEARCH_CONSOLE_KEY' },
  ];
}

const KNOWN_SETTINGS = [
  { key: 'from_name', label: 'Default sender name' },
  { key: 'reply_to', label: 'Reply-to email' },
  { key: 'brand_voice', label: 'Brand voice (for AI copy)' },
];

export default async function MarketingSettingsPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  const [{ data: settings, error: settingsError }, aiConfig, stripe] = await Promise.all([
    settle(supabase.from('marketing_settings').select('*')),
    getAIConfigView(supabase),
    resolveStripeSecretKey(),
  ]);
  if (settingsError) {
    console.error('[admin-marketing-settings] settings read failed', settingsError);
    return <AdminMarketingSettingsReadError />;
  }
  if (aiConfig.error) console.error('[admin-marketing-settings] AI config read failed', aiConfig.error);
  if (stripe.status === 'unreadable') console.error('[admin-marketing-settings] stripe settings read failed', stripe.error);
  const stripeSource = stripe.status === 'resolved'
    ? t(stripe.source === 'setup' ? 'adminSettings.stripeKeyFromSetup' : 'adminSettings.stripeKeyFromEnvironment')
    : null;
  const byKey = new Map((settings ?? []).map((s) => [s.key, s.value]));

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <h2 className="mb-3 font-semibold">{t('adminMarketingSettings.channelProviders')}</h2>
        <ul className="space-y-2">
          {providerStatus(aiConfig.view, stripe, stripeSource).map((p) => (
            <li key={p.name} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
              <span>{p.name}{p.ready && p.source ? <span className="ml-2 text-xs text-muted">{p.source}</span> : null}</span>
              {p.ready === null
                ? <span className="inline-flex items-center gap-1 text-muted"><CircleAlert className="h-4 w-4" />{' '}{t('strategyMetrics.unavailable')}</span>
                : p.ready
                  ? <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 className="h-4 w-4" />{' '}{t('settings.connected')}</span>
                  : <span className="inline-flex items-center gap-1 text-muted"><XCircle className="h-4 w-4" /> Set {p.env}</span>}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">{t('settings.providerStatusReflectsServerEnvironment')}</p>
      </Card>

      <Card>
        <h2 className="mb-3 font-semibold">{t('adminMarketingSettings.marketingSettings')}</h2>
        <div className="space-y-4">
          {KNOWN_SETTINGS.map((s) => {
            const current = byKey.get(s.key) as { text?: string } | undefined;
            return (
              <form key={s.key} action={saveSetting} className="flex items-end gap-2">
                <input type="hidden" name="key" value={s.key} />
                <label className="flex-1 text-sm">{s.label}
                  <input name="value" defaultValue={current?.text ?? ''} className={`mt-1 ${inputCls}`} />
                </label>
                <SubmitButton className="h-10 shrink-0 rounded-xl border border-border px-4 text-sm font-medium hover:bg-elevated">{t('settings.save')}</SubmitButton>
              </form>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

async function AdminMarketingSettingsReadError() {
  const t = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('settings.marketingSettings')}</h1>
        <p className="mt-1 text-sm text-muted">{t('settings.configureProviderStatusAndMarketing')}</p>
      </div>
      <ErrorState message={t('settings.couldNotLoadMarketingSettings')} />
      <Link href="/admin/marketing/settings" className="text-sm font-medium text-brand-text underline">{t('settings.refreshSettings')}</Link>
    </div>
  );
}
