import type { Metadata } from 'next';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { getAIConfigView } from '@/lib/ai/settings';
import { AIEngineForm } from './ai-engine-form';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Admin · AI Engine', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function AdminAIPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  // A failed read is not "no key, default model": the form would preselect the
  // first model over the stored one and its Save would write it. The page says
  // the settings could not be read and offers no form.
  const { view, error } = await getAIConfigView(supabase);
  if (error) console.error('[admin-ai] AI engine settings read failed', error);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl"><Sparkles className="h-6 w-6 text-brand-text" /> {t('adminAi.aiEngine')}</h1>
        <p className="mt-1 text-sm text-muted">
          Choose which AI powers Bubaly&apos;s assistant, briefings, and smart features, and link your API keys.
          Applies to every AI feature that uses the shared provider.
        </p>
      </div>

      {view ? (
        <>
          <Card className="max-w-2xl">
            <AIEngineForm view={view} />
          </Card>

          <p className="max-w-2xl text-xs text-muted">
            {t('adminAi.currentlyActive')} <span className="font-semibold text-fg">{view.provider === 'openai' ? 'ChatGPT (OpenAI)' : 'Claude (Anthropic)'}</span>
            {view.model ? ` · ${view.model}` : ''}.
          </p>
        </>
      ) : (
        <div className="max-w-2xl space-y-3">
          <ErrorState message={t('adminAi.couldNotLoadAiEngineSettings')} />
          <Link href="/admin/ai" className="text-sm font-medium text-brand-text underline">{t('settings.refreshSettings')}</Link>
        </div>
      )}
    </div>
  );
}
