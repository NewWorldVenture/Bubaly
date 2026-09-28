'use client';

import { useState } from 'react';
import { Sparkles, Lightbulb } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslations } from '@/components/i18n/locale-provider';

type Suggestion = { title: string; detail: string };
type SavingsAnswer = { summary: string; suggestions: Suggestion[]; error: string | null };

/**
 * What the card may show for one answer from /api/ai/savings. A refusal (a
 * teen, a caregiver or a guest: "Family finances are private to the adults")
 * and an engine that is not set up both answer `{ error }` with no summary, and
 * the card used to read only `summary` and `suggestions` — so the button's
 * spinner stopped and nothing appeared (page audit B15, P-37). The route's
 * message is already in the reader's language; `fallback` is for an answer
 * that carries none.
 */
export function readSavingsAnswer(ok: boolean, body: unknown, fallback: string): SavingsAnswer {
  const d = (body && typeof body === 'object' ? body : {}) as { summary?: unknown; suggestions?: unknown; error?: unknown };
  if (!ok) return { summary: '', suggestions: [], error: typeof d.error === 'string' && d.error ? d.error : fallback };
  return {
    summary: typeof d.summary === 'string' ? d.summary : '',
    suggestions: Array.isArray(d.suggestions) ? (d.suggestions as Suggestion[]) : [],
    error: null,
  };
}

/**
 * AI Savings Suggestions card — calls /api/ai/savings (which analyses
 * transactions, budgets, bills and subscriptions server-side) and renders
 * prioritised, concrete recommendations. Embeddable on any finance surface.
 */
export function SavingsCoachCard() {
  const t = useTranslations();
  const [state, setState] = useState<({ loading: boolean } & SavingsAnswer) | null>(null);

  async function run() {
    setState({ loading: true, summary: '', suggestions: [], error: null });
    const fallback = t('ai.recommendationsAreTemporarilyUnavailable');
    try {
      const res = await fetch('/api/ai/savings', { method: 'POST' });
      const d = await res.json().catch(() => null);
      setState({ loading: false, ...readSavingsAnswer(res.ok, d, fallback) });
    } catch {
      setState({ loading: false, summary: '', suggestions: [], error: fallback });
    }
  }

  return (
    <div className="rounded-2xl border border-brand/20 bg-brand/5 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-brand-text" /> {t('savingsCoach.aiSavingsSuggestions')}</p>
        <Button variant="secondary" onClick={run} loading={state?.loading}>{t('savingsCoach.analyzeMyFinances')}</Button>
      </div>
      {state && !state.loading && (
        <div className="mt-3 space-y-2 text-sm">
          {state.error && <p role="alert" className="text-danger">{state.error}</p>}
          {state.summary && <p className="text-fg/90">{state.summary}</p>}
          <ul className="space-y-2">
            {state.suggestions.map((s, i) => (
              <li key={i} className="flex items-start gap-2">
                <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <span><span className="font-medium">{s.title}.</span> <span className="text-muted">{s.detail}</span></span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
