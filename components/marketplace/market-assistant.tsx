'use client';

// The real AI Marketplace Assistant rail panel (backlog #11). Replaces the old
// stub that prompt-routed to the generic assistant: questions are answered IN
// the rail, grounded in the family's live board (comparable prices, matching
// listings, open requests, your own offers) via askMarketAssistantAction —
// deterministic engine by default, real LLM automatically when the admin AI
// engine is configured. Every reply carries deep links into the marketplace.
import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { ArrowRight, Loader2, Sparkles } from 'lucide-react';
import { askMarketAssistantAction } from '@/app/(app)/marketplace/assistant-actions';
import type { AssistantLink } from '@/lib/marketplace/assistant';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

type Turn = {
  role: 'user' | 'assistant';
  content: string;
  links?: AssistantLink[];
  source?: 'llm' | 'engine';
};

const SUGGESTIONS = [
  'What should I charge for a kids bike?',
  "What's in demand right now?",
  'How are my listings doing?',
  'Find toys under $20',
];

export function MarketAssistant({ firstName }: { firstName: string }) {
  const tr = useTranslations();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [pending, startTransition] = useTransition();
  const scrollRef = useRef<HTMLDivElement>(null);

  const ask = (question: string) => {
    const q = question.trim();
    if (!q || pending) return;
    setInput('');
    setTurns((t) => [...t, { role: 'user', content: q }]);
    const history = turns.map((t) => ({ role: t.role, content: t.content }));
    startTransition(async () => {
      const res = await askMarketAssistantAction(q, history);
      setTurns((t) => [
        ...t,
        res.ok
          ? { role: 'assistant', content: res.reply, links: res.links, source: res.source }
          : { role: 'assistant', content: res.error },
      ]);
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 99999, behavior: 'smooth' }));
    });
  };

  return (
    <section className="rounded-2xl border border-brand/25 bg-brand/[0.04] p-4">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <Sparkles className="h-4 w-4 text-brand-text" /> {tr('marketAssistant.aiMarketplaceAssistant')}
      </p>

      {turns.length === 0 ? (
        <>
          <p className="mt-1.5 text-xs text-muted">
            Hi {firstName}{tr('marketAssistant.askMePricesDemandYourListings')}
          </p>
          <div className="mt-2 space-y-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => ask(s)}
                disabled={pending}
                className="block w-full rounded-lg border border-border bg-surface/70 px-2.5 py-1.5 text-left text-xs text-muted transition hover:border-brand/40 hover:text-fg disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div ref={scrollRef} className="mt-2 max-h-72 space-y-2 overflow-y-auto pr-0.5">
          {turns.map((t, i) => (
            <div key={i} className={cn('flex', t.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div className={cn(
                'max-w-[92%] rounded-xl px-2.5 py-1.5 text-xs leading-relaxed',
                t.role === 'user' ? 'bg-brand/15 text-fg' : 'border border-border bg-surface/80',
              )}>
                <p>{t.content}</p>
                {t.links && t.links.length > 0 && (
                  <span className="mt-1.5 flex flex-wrap gap-1">
                    {t.links.map((l) => (
                      <Link
                        key={`${l.href}-${l.label}`}
                        href={l.href}
                        className="inline-flex items-center gap-0.5 rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-bold text-brand-text transition hover:bg-brand/20"
                      >
                        {l.label} <ArrowRight className="h-2.5 w-2.5" />
                      </Link>
                    ))}
                  </span>
                )}
              </div>
            </div>
          ))}
          {pending && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted">
              <Loader2 className="h-3 w-3 animate-spin" /> {tr('marketAssistant.checkingTheBoard')}
            </div>
          )}
        </div>
      )}

      <form
        className="mt-2.5 flex items-center gap-1.5"
        onSubmit={(e) => { e.preventDefault(); ask(input); }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={500}
          placeholder={tr('marketAssistant.askAnything')}
          aria-label={tr('marketAssistant.askTheMarketplaceAssistant')}
          className="h-9 min-w-0 flex-1 rounded-xl border border-border bg-bg px-3 text-xs outline-none placeholder:text-muted/70 focus:border-brand"
        />
        <button
          type="submit"
          disabled={pending || !input.trim()}
          aria-label={tr('marketAssistant.send')}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand text-brand-fg transition hover:opacity-90 disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
        </button>
      </form>
    </section>
  );
}
