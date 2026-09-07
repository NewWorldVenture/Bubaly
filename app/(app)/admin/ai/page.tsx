import type { Metadata } from 'next';
import { Sparkles } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { getAIConfigView } from '@/lib/ai/settings';
import { AIEngineForm } from './ai-engine-form';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Admin · AI Engine', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function AdminAIPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  const view = await getAIConfigView(supabase);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl"><Sparkles className="h-6 w-6 text-brand-text" /> {t('adminAi.aiEngine')}</h1>
        <p className="mt-1 text-sm text-muted">
          Choose which AI powers Bubaly&apos;s assistant, briefings, and smart features, and link your API keys.
          Applies to every AI feature that uses the shared provider.
        </p>
      </div>

      <Card className="max-w-2xl">
        <AIEngineForm view={view} />
      </Card>

      <p className="max-w-2xl text-xs text-muted">
        {t('adminAi.currentlyActive')} <span className="font-semibold text-fg">{view.provider === 'openai' ? 'ChatGPT (OpenAI)' : 'Claude (Anthropic)'}</span>
        {view.model ? ` · ${view.model}` : ''}.
      </p>
    </div>
  );
}
