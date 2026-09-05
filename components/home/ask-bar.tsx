'use client';

// R6 — intent-based entry, made primary. The natural-language bar at the top
// of Home is the shared Ask Bubaly component (§16): a page name still
// navigates through the same pure router the ⌘K bar uses; everything else
// becomes a concierge request and lands on its run page. One input → the
// system of execution.

import { AskBubaly } from '@/components/concierge/ask-bubaly';

export function AskBar() {
  return <AskBubaly variant="hero" />;
}
