'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { Sparkles, X, Loader2 } from 'lucide-react';

// Lazy-load the (large) assistant only when the mobile overlay opens, so the
// globally-mounted orb doesn't ship the assistant bundle on every page.
const AssistantModule = dynamic(
  () => import('@/components/modules/assistant-module').then((m) => m.AssistantModule),
  { ssr: false, loading: () => <div className="grid h-40 place-items-center"><Loader2 className="h-6 w-6 animate-spin text-brand" /></div> },
);

/**
 * Global floating "Ask AI" orb. Sits above the Quick Capture FAB on every app
 * page. On desktop it routes to the full voice-enabled assistant; on mobile it
 * opens the assistant as an overlay sheet *over the current screen* (so you
 * never lose your place). Hidden on the assistant page itself. This is the
 * global entry point into the one AI intelligence layer.
 */
export function AIOrb() {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Lock background scroll while the mobile overlay is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Close the sheet on navigation and on Escape.
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (pathname?.startsWith('/dashboard/assistant')) return null;

  function handleClick() {
    // Desktop → full page; mobile/tablet → overlay over the current screen.
    const isDesktop = typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;
    if (isDesktop) router.push('/dashboard/assistant');
    else setOpen(true);
  }

  return (
    <>
      <button
        onClick={handleClick}
        aria-label="Ask the AI assistant"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="group fixed bottom-36 right-4 z-40 grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-violet-500 to-blue-600 text-white shadow-glow transition hover:brightness-110 active:scale-95 lg:bottom-24 lg:right-6"
      >
        <Sparkles className="h-6 w-6" />
        <span className="pointer-events-none absolute right-16 hidden whitespace-nowrap rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-semibold text-fg shadow-lg group-hover:block lg:block lg:opacity-0 lg:transition-opacity lg:group-hover:opacity-100">
          Ask AI
        </span>
      </button>

      {/* Mobile overlay — the assistant hovers over the current screen. */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="AI assistant">
          <button
            aria-label="Close assistant"
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-x-2 bottom-2 top-14 flex flex-col overflow-hidden rounded-3xl border border-border bg-bg shadow-glass animate-slide-up">
            <div className="flex shrink-0 items-center justify-end p-2">
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="grid h-9 w-9 place-items-center rounded-full bg-elevated text-muted transition hover:text-fg"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              <AssistantModule />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
