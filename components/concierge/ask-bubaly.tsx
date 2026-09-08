'use client';

// The shared Ask Bubaly entry (§16 "How can I help your family?").
//
// One component mounted on Home, the dashboard and inside the command bar's
// fallback, so a request filed from any of them goes through the same path:
//   • a page name still navigates (routeCommand, exactly as before);
//   • everything else becomes a request — POST /api/ai/requests — and the
//     person lands on the run page, or sees the answer / question inline.
// A clarifying question is answered right here and continues the SAME run
// (POST /api/ai/runs/[id]/answer), so the person never re-types the request.
//
// Mobile-first on purpose: full-width, a 16px input (no iOS zoom), a 44px
// submit target, suggestion chips that wrap. The look is the Home Ask bar's.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ArrowRight, CheckCircle2, Loader2, MessageCircleQuestion, Sparkles } from 'lucide-react';
import { NAV_CATALOG } from '@/lib/constants/navigation';
import { routeCommand } from '@/lib/command-bar/route';
import { answerAIRequest, submitAIRequest, type AIRequestResponse } from '@/lib/ai/chat-request';
import { moduleFromPathname, suggestedPromptsFor } from '@/lib/concierge/suggested-prompts';
import { MicButton } from '@/components/voice/mic-button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

const NAV_ITEMS = NAV_CATALOG.map((n) => ({ href: n.href, label: n.label }));

export const ASK_BUBALY_PLACEHOLDER = 'How can I help your family?';

export type AskBubalyProps = {
  /** `hero` is the Home command-center block with heading and chips; `compact` is the single row used inside other surfaces. */
  variant?: 'hero' | 'compact';
  /** Link the request to an open concierge conversation. */
  conversationId?: string | null;
  /** Ids of the records the person is looking at (an event, a trip), passed to the planner as context. */
  entityIds?: string[];
  autoFocus?: boolean;
  className?: string;
  /** Called after a request resolves, in addition to the built-in navigation. */
  onOutcome?: (outcome: AIRequestResponse) => void;
};

type Inline =
  | { kind: 'clarification'; runId: string; question: string }
  | { kind: 'answer' | 'recommendation'; text: string; runId: string | null };

export function AskBubaly({ variant = 'hero', conversationId = null, entityIds, autoFocus, className, onOutcome }: AskBubalyProps) {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const { success, error: toastError } = useToast();
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [inline, setInline] = useState<Inline | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const answerRef = useRef<HTMLInputElement>(null);
  const suggestions = useMemo(() => suggestedPromptsFor(pathname), [pathname]);
  const moduleName = useMemo(() => moduleFromPathname(pathname), [pathname]);

  useEffect(() => { if (inline?.kind === 'clarification') answerRef.current?.focus(); }, [inline]);

  const handle = useCallback((result: Awaited<ReturnType<typeof submitAIRequest>>) => {
    if (!result.ok) {
      setError(result.status === 429 && result.retryAfter
        ? `${result.error} Try again in ${result.retryAfter}s.`
        : result.error);
      return;
    }
    const data = result.data;
    onOutcome?.(data);
    setText('');
    setAnswer('');
    switch (data.outcome) {
      case 'plan':
        success(t('askBubaly.bubalyIsOnIt'));
        if (data.redirect) router.push(data.redirect);
        setInline(null);
        break;
      case 'clarification':
        setInline({ kind: 'clarification', runId: data.runId ?? '', question: data.question ?? data.summary });
        break;
      case 'answer':
        setInline({ kind: 'answer', text: data.summary, runId: data.runId });
        break;
      case 'recommendation':
        setInline({ kind: 'recommendation', text: data.summary, runId: data.runId });
        break;
    }
  }, [onOutcome, router, success, t]);

  const submit = useCallback(async (raw: string) => {
    const query = raw.trim();
    if (!query || busy) return;
    // A page name is still a page name; the concierge is for outcomes.
    const [top] = routeCommand(query, NAV_ITEMS);
    if (top && top.kind === 'navigate') { router.push(top.href); setText(''); return; }

    setBusy(true);
    setError(null);
    try {
      handle(await submitAIRequest({
        text: query,
        conversationId,
        context: moduleName || entityIds?.length ? { ...(moduleName ? { module: moduleName } : {}), ...(entityIds?.length ? { entityIds } : {}) } : null,
      }));
    } finally {
      setBusy(false);
    }
  }, [busy, conversationId, entityIds, handle, moduleName, router]);

  // Speaking is asking: the transcript goes straight through the same submit
  // path a typed request takes, so voice is never a second-class entry.
  const onTranscript = useCallback((spoken: string) => {
    setText(spoken);
    void submit(spoken);
  }, [submit]);

  const reply = useCallback(async () => {
    if (inline?.kind !== 'clarification' || !answer.trim() || busy) return;
    if (!inline.runId) { toastError(t('askBubaly.bubalyLostTrackOfThat')); setInline(null); return; }
    setBusy(true);
    setError(null);
    try {
      handle(await answerAIRequest(inline.runId, answer.trim()));
    } finally {
      setBusy(false);
    }
  }, [answer, busy, handle, inline, toastError, t]);

  const hero = variant === 'hero';

  return (
    <section
      className={cn(
        hero ? 'rounded-2xl border border-border bg-surface/50 p-3 sm:p-4' : '',
        className,
      )}
      aria-busy={busy}
    >
      {hero && (
        <h2 className="mb-2 text-base font-semibold text-fg sm:text-lg">{ASK_BUBALY_PLACEHOLDER}</h2>
      )}
      <form
        onSubmit={(e) => { e.preventDefault(); void submit(text); }}
        role="search"
        className="flex items-center gap-2 rounded-xl border border-border bg-bg px-3 focus-within:border-brand"
      >
        <Sparkles className="h-5 w-5 shrink-0 text-brand-text" aria-hidden />
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          enterKeyHint="go"
          autoFocus={autoFocus}
          disabled={busy}
          aria-label={ASK_BUBALY_PLACEHOLDER}
          placeholder={hero ? 'Plan our week, take care of dinner, find a plumber…' : ASK_BUBALY_PLACEHOLDER}
          className="h-12 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted sm:h-11 sm:text-sm"
        />
        <MicButton size="sm" disabled={busy} onTranscript={onTranscript} onError={setMicError} />
        <button
          type="submit"
          disabled={!text.trim() || busy}
          aria-label={t('askBubaly.askBubaly')}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-brand text-brand-fg transition hover:opacity-90 focus-ring disabled:opacity-40 coarse:min-h-11 coarse:min-w-11 sm:h-9 sm:w-9"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ArrowRight className="h-4 w-4" aria-hidden />}
        </button>
      </form>

      {busy && (
        <p className="mt-2 text-xs text-muted" role="status">{t('askBubaly.bubalyIsLookingAtYourFamilys')}</p>
      )}
      {(error || micError) && (
        <p className="mt-2 text-sm text-danger" role="alert">{error ?? micError}</p>
      )}

      {inline?.kind === 'clarification' && (
        <form
          onSubmit={(e) => { e.preventDefault(); void reply(); }}
          className="mt-3 rounded-xl border border-brand/30 bg-brand/5 p-3"
          aria-label={t('askBubaly.bubalyHasAQuestion')}
        >
          <p className="flex items-start gap-2 text-sm text-fg">
            <MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0 text-brand-text" aria-hidden />
            <span>{inline.question}</span>
          </p>
          <div className="mt-2 flex items-center gap-2">
            <input
              ref={answerRef}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              enterKeyHint="send"
              disabled={busy}
              aria-label={t('askBubaly.yourAnswer')}
              placeholder={t('askBubaly.yourAnswer')}
              className="h-12 min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 text-base outline-none focus:border-brand placeholder:text-muted sm:h-11 sm:text-sm"
            />
            <button
              type="submit"
              disabled={!answer.trim() || busy}
              className="inline-flex h-11 items-center justify-center rounded-lg bg-brand px-4 text-sm font-medium text-brand-fg transition hover:opacity-90 focus-ring disabled:opacity-40 coarse:min-h-11"
            >
              {t('askBubaly.answer')}
            </button>
          </div>
        </form>
      )}

      {(inline?.kind === 'answer' || inline?.kind === 'recommendation') && (
        <div className="mt-3 rounded-xl border border-border bg-bg/60 p-3 text-sm text-fg" role="status">
          <p className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-text" aria-hidden />
            <span className="whitespace-pre-wrap">{inline.text}</span>
          </p>
          {inline.kind === 'recommendation' && (
            <p className="mt-2 text-xs text-muted">{t('askBubaly.bubalyLeftThisAsASuggestion')}</p>
          )}
        </div>
      )}

      {hero && (
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label={t('askBubaly.suggestedPrompts')}>
          {suggestions.map((s) => (
            <button
              key={s.text}
              type="button"
              disabled={busy}
              onClick={() => { setText(s.text); void submit(s.text); }}
              className="rounded-full border border-border bg-bg/60 px-2.5 py-1 text-xs text-muted transition hover:border-brand/40 hover:text-brand-text focus-ring disabled:opacity-50 coarse:min-h-11"
            >
              {s.text}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
