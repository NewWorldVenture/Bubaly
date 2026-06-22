'use client';

import { useState } from 'react';
import { Check, KeyRound, Sparkles } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { AI_MODELS, type AIConfigView, type AIEngine } from '@/lib/ai/models';
import { saveAIConfigAction } from './actions';

export function AIEngineForm({ view }: { view: AIConfigView }) {
  const { success, error: toastError } = useToast();
  const [provider, setProvider] = useState<AIEngine>(view.provider);
  const [model, setModel] = useState(view.model ?? AI_MODELS[view.provider][0]);
  const [saving, setSaving] = useState(false);

  function onProvider(p: AIEngine) {
    setProvider(p);
    if (!AI_MODELS[p].includes(model)) setModel(AI_MODELS[p][0]);
  }

  async function onSubmit(formData: FormData) {
    setSaving(true);
    const res = await saveAIConfigAction(formData);
    setSaving(false);
    if (res.ok) success('AI engine updated'); else toastError(res.error ?? 'Could not save');
  }

  const keySet = provider === 'openai' ? view.openaiKeySet : view.anthropicKeySet;
  const fromEnv = provider === 'openai' ? view.openaiFromEnv : view.anthropicFromEnv;

  return (
    <form action={onSubmit} className="space-y-5">
      <div>
        <label className="mb-2 block text-sm font-semibold">AI engine</label>
        <div className="grid grid-cols-2 gap-3">
          {([
            { id: 'anthropic' as const, name: 'Claude (Anthropic)', desc: 'Default' },
            { id: 'openai' as const, name: 'ChatGPT (OpenAI)', desc: 'GPT-4o family' },
          ]).map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onProvider(p.id)}
              className={`rounded-2xl border p-4 text-left transition ${provider === p.id ? 'border-brand bg-brand/10' : 'border-border hover:bg-elevated'}`}
            >
              <div className="flex items-center gap-2">
                <Sparkles className={`h-4 w-4 ${provider === p.id ? 'text-brand' : 'text-muted'}`} />
                <span className="font-semibold">{p.name}</span>
                {provider === p.id && <Check className="ml-auto h-4 w-4 text-brand" />}
              </div>
              <p className="mt-1 text-xs text-muted">{p.desc}</p>
            </button>
          ))}
        </div>
        <input type="hidden" name="provider" value={provider} />
      </div>

      <label className="block">
        <span className="text-sm font-semibold">Model</span>
        <select name="model" value={model} onChange={(e) => setModel(e.target.value)}
          className="mt-1 h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm">
          {AI_MODELS[provider].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>

      <div className="space-y-3 rounded-2xl border border-border bg-surface/40 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold"><KeyRound className="h-4 w-4 text-brand" /> API keys</div>
        <p className="text-xs text-muted">
          Keys are stored server-side and never shown again. Leave a field blank to keep the existing key.
          {keySet ? <span className="ml-1 text-emerald-400">{provider === 'openai' ? 'OpenAI' : 'Anthropic'} key is set{fromEnv ? ' (from environment)' : ''}.</span>
            : <span className="ml-1 text-amber-400">No {provider === 'openai' ? 'OpenAI' : 'Anthropic'} key configured yet.</span>}
        </p>
        <label className="block">
          <span className="text-xs text-muted">OpenAI API key (sk-…)</span>
          <input type="password" name="openaiKey" autoComplete="off" placeholder={view.openaiKeySet ? '•••••••• (set)' : 'sk-…'}
            className="mt-1 h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm" />
        </label>
        <label className="block">
          <span className="text-xs text-muted">Anthropic API key (sk-ant-…)</span>
          <input type="password" name="anthropicKey" autoComplete="off" placeholder={view.anthropicKeySet ? '•••••••• (set)' : 'sk-ant-…'}
            className="mt-1 h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm" />
        </label>
      </div>

      <button type="submit" disabled={saving} className="rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-60">
        {saving ? 'Saving…' : 'Save AI engine'}
      </button>
    </form>
  );
}
