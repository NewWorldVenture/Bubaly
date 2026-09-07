import type { Metadata } from 'next';
import Link from 'next/link';
import { CheckCircle2, XCircle } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settle } from '@/lib/supabase/settle';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { saveSetting } from '../actions';
import { isTwilioConfigured } from '@/lib/guardian/twilio';
import { getAIConfigView, type AIConfigView } from '@/lib/ai/settings';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Marketing · Settings', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';

function providerStatus(ai: AIConfigView) {
  return [
    { name: 'Email (Resend)', ready: !!process.env.RESEND_API_KEY, env: 'RESEND_API_KEY' },
    { name: 'SMS (Twilio)', ready: isTwilioConfigured(), env: 'TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PHONE_NUMBER' },
    { name: 'AI (OpenAI)', ready: ai.openaiKeySet, env: ai.openaiFromEnv ? 'OPENAI_API_KEY' : 'admin console' },
    { name: 'Payments (Stripe)', ready: !!process.env.STRIPE_SECRET_KEY, env: 'STRIPE_SECRET_KEY' },
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
  const [{ data: settings, error: settingsError }, aiConfig] = await Promise.all([
    settle(supabase.from('marketing_settings').select('*')),
    getAIConfigView(supabase),
  ]);
  if (settingsError) {
    console.error('[admin-marketing-settings] settings read failed', settingsError);
    return <AdminMarketingSettingsReadError />;
  }
  const byKey = new Map((settings ?? []).map((s) => [s.key, s.value]));

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <h2 className="mb-3 font-semibold">{t('adminMarketingSettings.channelProviders')}</h2>
        <ul className="space-y-2">
          {providerStatus(aiConfig).map((p) => (
            <li key={p.env} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
              <span>{p.name}</span>
              {p.ready
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
                <button className="h-10 shrink-0 rounded-xl border border-border px-4 text-sm font-medium hover:bg-elevated">{t('settings.save')}</button>
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
