'use client';

// Header "Blog" launcher — lets a signed-in user pop open the public Bubaly
// blog (/blog) in an in-app modal and explore it without leaving the app. The
// blog is embedded same-origin (see the SAMEORIGIN frame header scoped to
// /blog in next.config.mjs) with an "open in new tab" fallback. The icon uses
// theme tokens (text-muted / text-fg / bg-surface) so it adapts to light + dark.
//
// The modal is PORTALED to <body> (so it escapes the header's backdrop-blur
// containing block, which would otherwise clip a `fixed` overlay) and its left
// edge is inset to the sidebar width on desktop — so it covers and blurs ONLY
// the main content area, leaving the left navigation crisp and usable.
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, ExternalLink, X } from 'lucide-react';

const BLOG_URL = '/blog';

export function BlogLauncher() {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

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
  const close = useCallback(() => setOpen(false), []);

  const modal = (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-3 sm:p-6 lg:left-[var(--sidebar-width)]"
      role="dialog"
      aria-modal="true"
      aria-label="Bubaly Blog"
    >
      {/* Scrim — blurs the main content behind it. Because the overlay's left
          edge is the sidebar width on desktop, the left nav is NOT blurred. */}
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-md animate-fade-in"
        onClick={close}
        aria-hidden
      />

      {/* Panel — `dvh` (dynamic viewport) not `vh`: on mobile Safari/Chrome a
          static `88vh` is measured against the address-bar-retracted viewport, so
          with the URL bar showing the panel is ~as tall as the whole visible area
          and its header (Close button) is pushed behind the browser chrome. `dvh`
          tracks the *visible* viewport, keeping the header + iframe fully on-screen. */}
      <div className="relative flex h-[88dvh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-glass animate-fade-in">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-bg/70 px-4 py-3 backdrop-blur-xl">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand/15 text-brand-text">
              <BookOpen className="h-4 w-4" />
            </span>
            <div className="leading-tight">
              <p className="text-sm font-semibold text-fg">Bubaly Blog</p>
              <p className="text-xs text-muted">Tips, stories &amp; insights for modern families</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* These go icon-only on mobile (text is `hidden sm:inline`), so they
                grow to a >=44px square on touch — Close especially must be an easy
                tap target since it's the modal's escape control on a phone. */}
            <a
              href={BLOG_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted transition coarse:min-h-11 coarse:min-w-11 hover:bg-elevated hover:text-fg"
              title="Open the blog in a new tab"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Open in new tab</span>
            </a>
            {/* Close button — always visible top-right of the pop-up. */}
            <button
              type="button"
              onClick={close}
              aria-label="Close blog"
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-elevated/60 px-2.5 py-1.5 text-xs font-semibold text-fg transition coarse:min-h-11 coarse:min-w-11 hover:bg-elevated"
            >
              <X className="h-4 w-4" />
              <span className="hidden sm:inline">Close</span>
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
  );

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

      {open && mounted ? createPortal(modal, document.body) : null}
    </>
  );
}
