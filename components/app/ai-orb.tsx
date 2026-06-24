'use client';

import { usePathname, useRouter } from 'next/navigation';
import { Sparkles } from 'lucide-react';

/**
 * Global floating "Ask AI" orb. Sits above the Quick Capture FAB on every app
 * page and routes to the full voice-enabled assistant. Hidden on the assistant
 * page itself (you're already there). This is the global entry point into the
 * one AI intelligence layer.
 */
export function AIOrb() {
  const router = useRouter();
  const pathname = usePathname();
  if (pathname?.startsWith('/dashboard/assistant')) return null;

  return (
    <button
      onClick={() => router.push('/dashboard/assistant')}
      aria-label="Ask the AI assistant"
      className="group fixed bottom-36 right-4 z-40 grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-violet-500 to-blue-600 text-white shadow-glow transition hover:brightness-110 active:scale-95 lg:bottom-24 lg:right-6"
    >
      <Sparkles className="h-6 w-6" />
      <span className="pointer-events-none absolute right-16 hidden whitespace-nowrap rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-semibold text-fg shadow-lg group-hover:block lg:block lg:opacity-0 lg:transition-opacity lg:group-hover:opacity-100">
        Ask AI
      </span>
    </button>
  );
}
