'use client';

// A world-class "back to top" affordance for the long marketing pages. Appears
// only after the visitor has scrolled past the fold, sits bottom-right, and
// smooth-scrolls to the top (instant when the visitor prefers reduced motion).
// Accessible: real <button> with an aria-label, focus-visible ring, min 44px
// tap target, removed from the tab order while hidden, and it restores focus to
// the top of <main> for keyboard / screen-reader users. Uses theme tokens so it
// looks right in both light and dark, and lifts above the one-time cookie notice
// (bottom-right on desktop) so the two never overlap.

import { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

const COOKIE_KEY = 'bubaly-cookie-consent';

export function BackToTop({ threshold = 400 }: { threshold?: number }) {
  const [visible, setVisible] = useState(false);
  const [raised, setRaised] = useState(false); // lift above the cookie banner

  useEffect(() => {
    const cookiePending = () => {
      try { return !localStorage.getItem(COOKIE_KEY); } catch { return false; }
    };
    const onScroll = () => {
      setVisible(window.scrollY > threshold);
      setRaised(cookiePending());
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [threshold]);

  const toTop = () => {
    const reduce = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    // Restore focus to the top of the page for keyboard / screen-reader users.
    const main = document.getElementById('main-content');
    if (main) {
      main.setAttribute('tabindex', '-1');
      main.focus({ preventScroll: true });
    }
  };

  return (
    <button
      type="button"
      onClick={toTop}
      aria-label="Back to top"
      title="Back to top"
      tabIndex={visible ? 0 : -1}
      aria-hidden={!visible}
      className={cn(
        'group fixed right-5 z-40 grid h-11 w-11 place-items-center rounded-full',
        'border border-border bg-surface/85 text-fg shadow-lg backdrop-blur',
        'transition-all duration-300 ease-out',
        'hover:-translate-y-0.5 hover:border-brand/50 hover:bg-elevated hover:text-brand',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
        raised ? 'bottom-28 sm:bottom-24' : 'bottom-6',
        visible ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0',
      )}
      style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
    >
      <ArrowUp className="h-5 w-5 transition-transform duration-300 group-hover:-translate-y-0.5" aria-hidden />
    </button>
  );
}
