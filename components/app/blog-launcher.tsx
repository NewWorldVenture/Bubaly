'use client';

// Header "Blog" launcher — lets a signed-in user pop open the public Bubaly
// blog (/blog) in an in-app modal and explore it without leaving the app. The
// blog is embedded same-origin (see the SAMEORIGIN frame header scoped to
// /blog in next.config.mjs) with an "open in new tab" fallback. The icon uses
// theme tokens (text-muted / text-fg / bg-surface) so it adapts to light + dark.
import { useCallback, useEffect, useState } from 'react';
import { BookOpen, ExternalLink, X } from 'lucide-react';

const BLOG_URL = '/blog';

export function BlogLauncher() {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Close on Escape + lock body scroll while the modal is up.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  const openModal = useCallback(() => { setLoaded(false); setOpen(true); }, []);

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        aria-haspopup="dialog"
        aria-label="Read the Bubaly blog"
        title="Bubaly Blog"
        className="inline-flex h-10 w-10 items-center justify-center rounded-full text-muted transition hover:bg-elevated hover:text-fg"
      >
        <BookOpen className="h-5 w-5" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label="Bubaly Blog"
        >
          {/* Scrim */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in"
            onClick={() => setOpen(false)}
            aria-hidden
          />

          {/* Panel */}
          <div className="relative flex h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-glass animate-fade-in">
            <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-bg/70 px-4 py-3 backdrop-blur-xl">
              <div className="flex items-center gap-2.5">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand/15 text-brand-text">
                  <BookOpen className="h-4.5 w-4.5" />
                </span>
                <div className="leading-tight">
                  <p className="text-sm font-semibold text-fg">Bubaly Blog</p>
                  <p className="text-xs text-muted">Tips, stories &amp; insights for modern families</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <a
                  href={BLOG_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-fg"
                  title="Open the blog in a new tab"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Open in new tab</span>
                </a>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close blog"
                  className="grid h-9 w-9 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-fg"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            {/* Embedded blog — same-origin, fully navigable */}
            <div className="relative flex-1 bg-bg">
              {!loaded && (
                <div className="absolute inset-0 grid place-items-center text-sm text-muted">
                  Loading the blog…
                </div>
              )}
              <iframe
                src={BLOG_URL}
                title="Bubaly Blog"
                onLoad={() => setLoaded(true)}
                className="h-full w-full border-0"
                loading="eager"
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
