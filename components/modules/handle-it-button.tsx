'use client';

// §51's [Let Bubaly Handle It]. One button, one sentence, one run.
//
// The readiness cards are server-rendered, so this is the only client piece
// they need: it files the request through the SAME path Ask Bubaly uses
// (`submitAIRequest` → POST /api/ai/requests), which means it inherits the
// trust gate, the plan review and the run page rather than being a second,
// quieter way to make Bubaly act. A plan lands on the run page like any other,
// so a person still sees what it intends to do before it does it.
import { useCallback, useState } from 'react';
import { useTranslations } from '@/components/i18n/locale-provider';
import { useRouter } from 'next/navigation';
import { Loader2, Sparkles } from 'lucide-react';
import { submitAIRequest } from '@/lib/ai/chat-request';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';

export function HandleItButton({ request, label = 'Let Bubaly handle it', className }: { request: string; label?: string; className?: string }) {
  const t = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const result = await submitAIRequest({ text: request });
    setBusy(false);
    if (!result.ok) {
      toastError(result.status === 429 && result.retryAfter ? `${result.error} Try again in ${result.retryAfter}s.` : result.error);
      return;
    }
    const data = result.data;
    if (data.outcome === 'plan' && data.redirect) { success(t('handleItButton.bubalyIsOnIt')); router.push(data.redirect); return; }
    // An answer, a question or a recommendation has nowhere to navigate to;
    // the summary is the reply, and saying it is better than a silent button.
    success(data.summary || 'Bubaly had a look.');
  }, [busy, request, router, success, toastError, t]);

  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      className={cn(
        'mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-brand/30 bg-brand/10 px-3 py-2 text-sm font-medium text-brand-text transition hover:border-brand/50 hover:bg-brand/15 disabled:opacity-60',
        className,
      )}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
      {busy ? 'Asking Bubaly…' : label}
    </button>
  );
}
