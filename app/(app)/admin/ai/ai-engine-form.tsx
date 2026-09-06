'use client';

import { useState } from 'react';
import { Check, KeyRound, Sparkles, Plug, Loader2, CircleCheck, CircleAlert } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { AI_MODELS, type AIConfigView } from '@/lib/ai/models';
import { saveAIConfigAction, testAIConnectionAction, type TestAIResult } from './actions';
import { useTranslations } from '@/components/i18n/locale-provider';

// OpenAI-only deployment: every AI route uses ChatGPT (OpenAI). The engine is
// fixed; this form configures the OpenAI model + API key.
export function AIEngineForm({ view }: { view: AIConfigView }) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [model, setModel] = useState(view.model && AI_MODELS.openai.includes(view.model) ? view.model : AI_MODELS.openai[0]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestAIResult | null>(null);

  async function onSubmit(formData: FormData) {
    setSaving(true);
    const res = await saveAIConfigAction(formData);
    setSaving(false);
    if (res.ok) success('AI engine updated'); else toastError(res.error ?? 'Could not save');
  }

  async function onTest() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testAIConnectionAction());
    } catch {
      setTestResult({ ok: false, code: 'unknown', message: 'The test could not run. Please try again.', detail: '' });
    } finally {
      setTesting(false);
    }
  }

  return (
    <form action={onSubmit} className="space-y-5">
      <div>
        <label className="mb-2 block text-sm font-semibold">{t('adminAiAiEngineForm.aiEngine')}</label>
        <div className="rounded-2xl border border-brand bg-brand/10 p-4 text-left">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-brand-text" />
            <span className="font-semibold">{t('adminAiAiEngineForm.chatgptOpenai')}</span>
            <Check className="ml-auto h-4 w-4 text-brand-text" />
          </div>
          <p className="mt-1 text-xs text-muted">{t('adminAiAiEngineForm.allAiFeaturesRunOnThe')}</p>
        </div>
        <input type="hidden" name="provider" value="openai" />
      </div>

      <label className="block">
        <span className="text-sm font-semibold">{t('adminAiAiEngineForm.model')}</span>
        <select name="model" value={model} onChange={(e) => setModel(e.target.value)}
          className="mt-1 h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm">
          {AI_MODELS.openai.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>

      <div className="space-y-3 rounded-2xl border border-border bg-surface/40 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold"><KeyRound className="h-4 w-4 text-brand-text" /> {t('adminAiAiEngineForm.apiKey')}</div>
        <p className="text-xs text-muted">
          {t('adminAiAiEngineForm.theKeyIsStoredServerSide')}
          {view.openaiKeySet ? <span className="ml-1 text-emerald-400">{t('adminAiAiEngineForm.openaiKeyIsSet')}{view.openaiFromEnv ? ' (from environment)' : ''}.</span>
            : <span className="ml-1 text-amber-400">{t('adminAiAiEngineForm.noOpenaiKeyConfiguredYet')}</span>}
        </p>
        <label className="block">
          <span className="text-xs text-muted">{t('adminAiAiEngineForm.openaiApiKeySk')}</span>
          <input type="password" name="openaiKey" autoComplete="off" placeholder={view.openaiKeySet ? '•••••••• (set)' : 'sk-…'}
            className="mt-1 h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm" />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={saving} className="rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-60">
          {saving ? 'Saving…' : 'Save AI engine'}
        </button>
        <button type="button" onClick={onTest} disabled={testing}
          className="inline-flex items-center gap-2 rounded-xl border border-border px-5 py-2.5 text-sm font-semibold hover:bg-elevated disabled:opacity-60">
          {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
          {testing ? 'Testing…' : 'Test connection'}
        </button>
      </div>

      {testResult && (
        testResult.ok ? (
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm">
            <p className="flex items-center gap-2 font-semibold text-emerald-300">
              <CircleCheck className="h-4 w-4" /> {t('adminAiAiEngineForm.connectionOk')}
            </p>
            <p className="mt-1 text-xs text-muted">
              {t('adminAiAiEngineForm.model')} <span className="font-mono text-fg">{testResult.model}</span> replied
              <span className="text-fg"> “{testResult.reply}”</span> in {testResult.latencyMs}{t('adminAiAiEngineForm.nbspMsYourAiFeaturesAre')}
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
            <p className="flex items-center gap-2 font-semibold text-amber-300">
              <CircleAlert className="h-4 w-4" /> {testResult.message}
            </p>
            <p className="mt-1 text-xs text-muted">Status: <span className="font-mono text-fg">{testResult.code}</span></p>
            {testResult.detail && (
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-bg/60 p-2 text-[11px] text-muted">{testResult.detail}</pre>
            )}
          </div>
        )
      )}
    </form>
  );
}
