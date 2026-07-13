'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, ArrowUp } from 'lucide-react';
import { buildAssistantUrl } from '@/lib/ai/prefill';

/**
 * Home-screen "ask anything" bar. Routes to the AI Assistant with the question
 * as a deep link (?q=…), which the assistant auto-sends — so a family can ask
 * from the home screen without an extra hop.
 */
export function HomeAskBar() {
  const router = useRouter();
  const [q, setQ] = useState('');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    router.push(buildAssistantUrl(q));
  }

  return (
    <form
      onSubmit={submit}
      className="flex items-center gap-2 rounded-full border border-border bg-surface/60 px-4 py-2.5 shadow-sm transition focus-within:border-brand/50 focus-within:ring-1 focus-within:ring-brand/30"
    >
      <Sparkles className="h-4 w-4 shrink-0 text-brand-text" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Ask Bubaly anything…"
        aria-label="Ask Bubaly anything"
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
