'use client';

import { useState } from 'react';
import { Sparkles, Lightbulb } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Suggestion = { title: string; detail: string };

/**
 * AI Savings Suggestions card — calls /api/ai/savings (which analyses
 * transactions, budgets, bills and subscriptions server-side) and renders
 * prioritised, concrete recommendations. Embeddable on any finance surface.
 */
export function SavingsCoachCard() {
  const [state, setState] = useState<{ loading: boolean; summary: string; suggestions: Suggestion[] } | null>(null);

  async function run() {
    setState({ loading: true, summary: '', suggestions: [] });
    try {
      const res = await fetch('/api/ai/savings', { method: 'POST' });
      const d = await res.json();
      setState({ loading: false, summary: d.summary ?? '', suggestions: Array.isArray(d.suggestions) ? d.suggestions : [] });
    } catch {
      setState({ loading: false, summary: 'Could not generate suggestions right now.', suggestions: [] });
    }
  }

  return (
    <div className="rounded-2xl border border-brand/20 bg-brand/5 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-brand" /> AI Savings Suggestions</p>
        <Button variant="secondary" onClick={run} loading={state?.loading}>Analyze my finances</Button>
      </div>
      {state && !state.loading && (
        <div className="mt-3 space-y-2 text-sm">
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
