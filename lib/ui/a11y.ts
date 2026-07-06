// lib/ui/a11y.ts — small, pure ARIA helpers so accessibility is consistent and
// testable rather than hand-rolled per component.

/**
 * ARIA props for a determinate progress bar. Spread onto the track element
 * (`<div {...progressBarA11y(pct, 'Savings goal')} …>`) so screen readers
 * announce it as a progress bar with the current percentage. Value is clamped
 * to [0,100] and rounded, so callers can pass a raw ratio-derived number.
 */
export function progressBarA11y(value: number, label: string): {
  role: 'progressbar';
  'aria-valuenow': number;
  'aria-valuemin': number;
  'aria-valuemax': number;
  'aria-label': string;
} {
  const now = Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
  return {
    role: 'progressbar',
    'aria-valuenow': now,
    'aria-valuemin': 0,
    'aria-valuemax': 100,
    'aria-label': label,
  };
}
