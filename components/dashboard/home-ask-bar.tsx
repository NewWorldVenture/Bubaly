'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, ArrowUp } from 'lucide-react';
import { stageAssistantHandoff } from '@/lib/ai/prefill';
import { useTranslations } from '@/components/i18n/locale-provider';

/**
 * Home-screen "ask anything" bar. Hands the question to the AI Assistant as an
 * in-app hand-off (lib/ai/prefill.ts), which the assistant sends on arrival —
 * so a family can ask from the home screen without an extra hop. Not a `?q=`
 * link: those only fill the draft box, because anyone can write one.
 */
export function HomeAskBar() {
  const t = useTranslations();
  const router = useRouter();
  const [q, setQ] = useState('');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    router.push(stageAssistantHandoff(q));
  }

  return (
    <form
      onSubmit={submit}
      className="flex items-center gap-2 rounded-full border border-border bg-surface/60 px-4 py-2.5 shadow-sm transition focus-within:border-brand focus-within:ring-1 focus-within:ring-brand/30"
    >
      <Sparkles className="h-4 w-4 shrink-0 text-brand-text" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('homeAskBar.askBubalyAnything')}
        aria-label={t('homeAskBar.askBubalyAnything')}
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
      />
      <button
        type="submit"
        disabled={!q.trim()}
        aria-label="Ask"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand text-white transition hover:brightness-110 disabled:opacity-40"
      >
        <ArrowUp className="h-4 w-4" />
      </button>
    </form>
  );
}
