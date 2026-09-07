'use client';

import { useState } from 'react';
import { Sparkles, Copy, Check } from 'lucide-react';
import { useTranslations } from '@/components/i18n/locale-provider';

type Task =
  | 'analyze' | 'campaign_plan' | 'seo_plan' | 'aeo_plan' | 'content_calendar'
  | 'email_draft' | 'sms_draft' | 'ad_copy' | 'landing_copy' | 'next_actions';

const TASKS: { key: Task; label: string; placeholder: string }[] = [
  { key: 'analyze', label: 'Analyze customers', placeholder: 'Optional: focus area…' },
  { key: 'next_actions', label: 'Next best actions', placeholder: 'Optional: a goal…' },
  { key: 'campaign_plan', label: 'Campaign plan', placeholder: 'e.g. win back lapsed families' },
  { key: 'seo_plan', label: 'SEO plan', placeholder: 'Optional: topic focus…' },
  { key: 'aeo_plan', label: 'AEO plan', placeholder: 'Optional: question theme…' },
  { key: 'content_calendar', label: 'Content calendar', placeholder: 'Optional: theme/month…' },
  { key: 'email_draft', label: 'Email draft', placeholder: 'e.g. onboarding welcome for new families' },
  { key: 'sms_draft', label: 'SMS draft', placeholder: 'e.g. reminder to finish setup' },
  { key: 'ad_copy', label: 'Ad copy', placeholder: 'e.g. Meta ad for busy parents' },
  { key: 'landing_copy', label: 'Landing copy', placeholder: 'e.g. back-to-school landing page' },
];

export default function MarketingAssistantPage() {
  const tr = useTranslations();
  const [task, setTask] = useState<Task>('analyze');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [output, setOutput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const current = TASKS.find((t) => t.key === task)!;

  async function generate() {
    if (loading) return;
    setLoading(true); setError(null); setOutput('');
    try {
      const res = await fetch('/api/admin/marketing/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, input }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? tr('assistant.generationFailed')); return; }
      setOutput(json.text ?? '');
    } catch {
      setError(tr('assistant.networkErrorPleaseTryAgain'));
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-brand-text" />
        <h2 className="font-semibold">{tr('adminMarketingAssistant.aiMarketingAssistant')}</h2>
      </div>
      <p className="text-sm text-muted">{tr('adminMarketingAssistant.groundedInYourLiveCustomerSegment')}</p>

      <div className="flex flex-wrap gap-2">
        {TASKS.map((t) => (
          <button
            key={t.key}
            onClick={() => { setTask(t.key); setOutput(''); setError(null); }}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${t.key === task ? 'border-brand/40 bg-brand/15 text-brand-text' : 'border-border text-muted hover:bg-elevated'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="rounded-2xl border border-border bg-surface/40 p-4">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={current.placeholder}
          className="min-h-[80px] w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring"
        />
        <div className="mt-3 flex justify-end">
          <button onClick={generate} disabled={loading} className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-60">
            <Sparkles className="h-4 w-4" /> {loading ? 'Generating…' : `Generate ${current.label.toLowerCase()}`}
          </button>
        </div>
      </div>

      {error && <div className="rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div>}

      {output && (
        <div className="rounded-2xl border border-border bg-surface/40 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">{tr('adminMarketingAssistant.output')}</span>
            <button onClick={copy} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-elevated">
              {copied ? <><Check className="h-3.5 w-3.5" /> {tr('adminMarketingAssistant.copied')}</> : <><Copy className="h-3.5 w-3.5" /> {tr('adminMarketingAssistant.copy')}</>}
            </button>
          </div>
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6">{output}</pre>
        </div>
      )}
    </div>
  );
}
