'use client';

// The app shell's own links (sidebar, top bar, tab bar, the logo) are on screen
// on every page, and Next's <Link> prefetches every link on screen. On ten member
// pages that was 32 to 51 prefetch requests a page load, each one through
// middleware.ts: a Supabase Auth getUser() round trip and an App Lock read, before
// Next renders anything. Loading the ten pages once ran 4,396 database statements;
// with the shell's links prefetching on intent, 1,962 (PERF-001).
//
// An IntentLink prefetches the moment someone may follow it: the pointer over it,
// keyboard focus on it, or a finger down on it. That still leaves a head start
// before the click, the hover pattern Next's own documentation gives for pages
// with many links, and it costs one request instead of one per link per load.

import Link from 'next/link';
import { useState, type ComponentProps } from 'react';

export function IntentLink({ onMouseEnter, onFocus, onTouchStart, ...props }: Omit<ComponentProps<typeof Link>, 'prefetch'>) {
  const [intent, setIntent] = useState(false);
  return (
    <Link
      {...props}
      // null is Next's default ("auto"): once intent is shown, the link prefetches as any other would.
      prefetch={intent ? null : false}
      onMouseEnter={(e) => { setIntent(true); onMouseEnter?.(e); }}
      onFocus={(e) => { setIntent(true); onFocus?.(e); }}
      onTouchStart={(e) => { setIntent(true); onTouchStart?.(e); }}
    />
  );
}
