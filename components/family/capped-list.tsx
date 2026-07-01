'use client';

// Shared resilience helper for member (or any) chip/pill/tile rows. Large
// families (hundreds of members) must not render hundreds of DOM nodes into a
// wrapping flex/grid — it walls the layout and tanks performance. Cap the
// visible slice and offer a "+N more / Show less" toggle.

import { useState } from 'react';
import { cn } from '@/lib/utils/cn';

/** Default number of chips/tiles shown before collapsing the remainder. */
export const MEMBER_CHIP_CAP = 8;

/**
 * Returns the visible slice of `items` plus toggle state. Call at the top of a
 * component (it uses a hook). When `items.length <= cap` nothing is hidden and
 * `overflow` is 0, so callers can render the toggle unconditionally.
 */
export function useCappedList<T>(items: T[], cap: number = MEMBER_CHIP_CAP) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, cap);
  const overflow = Math.max(0, items.length - cap);
  return { shown, overflow, expanded, toggle: () => setExpanded((v) => !v) };
}

/** Ready-made "+N more / Show less" chip; renders nothing when nothing overflows. */
export function ShowMoreChip({ overflow, expanded, onToggle, className }: {
  overflow: number; expanded: boolean; onToggle: () => void; className?: string;
}) {
  if (overflow <= 0) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'flex items-center gap-1 rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm font-medium text-muted transition hover:text-fg',
        className,
      )}
    >
      {expanded ? 'Show less' : `+${overflow} more`}
    </button>
  );
}
