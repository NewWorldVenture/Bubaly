'use client';

import { useEffect } from 'react';

/**
 * Fires a one-time view beacon on mount, and a conversion beacon when any
 * element marked `data-lp-cta` is clicked. Best-effort (keepalive); never blocks
 * navigation. The API increments the page's counters via the service role.
 */
export function LandingTracker({ slug }: { slug: string }) {
  useEffect(() => {
    const send = (kind: 'view' | 'conversion') => {
      try {
        fetch('/api/lp/track', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slug, kind }),
          keepalive: true,
        }).catch(() => {});
      } catch { /* ignore */ }
    };

    // De-dupe views within a session so refreshes don't over-count.
    const key = `lp-viewed:${slug}`;
    try {
      if (!sessionStorage.getItem(key)) { send('view'); sessionStorage.setItem(key, '1'); }
    } catch { send('view'); }

    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-lp-cta]')) send('conversion');
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [slug]);

  return null;
}
