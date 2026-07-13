'use client';

// R6 — intent-based entry, made primary. A prominent natural-language bar at the
// top of Home. On submit it routes through the SAME pure router the ⌘K command bar
// uses (lib/command-bar/route): a recognized goal ("plan Emma's party", "who's free
// Saturday") jumps straight to the reasoning engine; a page name navigates;
// anything else hands off to the assistant. One input → the system of execution.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, ArrowRight } from 'lucide-react';
import { NAV_CATALOG } from '@/lib/constants/navigation';
import { routeCommand } from '@/lib/command-bar/route';

const NAV_ITEMS = NAV_CATALOG.map((n) => ({ href: n.href, label: n.label }));

const SUGGESTIONS = ["plan Emma's party", "who's free Saturday", "what's for dinner", 'are we ready for Monday?'];

export function AskBar() {
  const router = useRouter();
  const [q, setQ] = useState('');

  function go(text: string) {
    const query = text.trim();
    if (!query) return;
    const [top] = routeCommand(query, NAV_ITEMS);
    if (top && (top.kind === 'navigate' || top.kind === 'intent')) router.push(top.href);
    else router.push(`/dashboard/assistant?q=${encodeURIComponent(query)}`);
  }

  return (
    <section className="rounded-2xl border border-border bg-surface/50 p-3 sm:p-4">
      <form
        onSubmit={(e) => { e.preventDefault(); go(q); }}
        role="search"
        className="flex items-center gap-2 rounded-xl border border-border bg-bg px-3 focus-within:border-brand"
      >
        <Sparkles className="h-5 w-5 shrink-0 text-brand-text" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          enterKeyHint="go"
          aria-label="Tell me what you need"
          placeholder="Tell me what you need — “plan Emma's party”, “who's free Saturday”…"
          className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
        />
        <button
          type="submit"
          disabled={!q.trim()}
          aria-label="Go"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand text-white transition hover:opacity-90 disabled:opacity-40"
        >
          <ArrowRight className="h-4 w-4" />
        </button>
      </form>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => go(s)}
            className="rounded-full border border-border bg-bg/60 px-2.5 py-1 text-xs text-muted transition hover:border-brand/40 hover:text-brand-text"
          >
            {s}
          </button>
        ))}
      </div>
    </section>
  );
}
