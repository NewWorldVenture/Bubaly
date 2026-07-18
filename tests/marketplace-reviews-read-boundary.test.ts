import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// A-14 §3e slice (agent-05, PLA-0798): the marketplace reviews page read
// `marketplace_reviews` and dropped `error`, so a failed read rendered "No reviews
// received yet" + "None yet" — a member's marketplace REPUTATION/rating appears to
// vanish on a transient failure. The primary read now surfaces a retryable error.

const page = fs.readFileSync('app/(app)/marketplace/reviews/page.tsx', 'utf8');

describe('marketplace reviews surfaces a failed read (A-14 §3e)', () => {
  it('captures the reviews read error', () => {
    expect(page).toContain('error: reviewsError');
  });

  it('returns a retryable ErrorState before deriving reputation from an empty list', () => {
    expect(page).toContain('if (reviewsError)');
    expect(page).toContain('<ErrorState message=');
    // The error early-return must precede the received/given filter derivation.
    expect(page.indexOf('if (reviewsError)')).toBeLessThan(page.indexOf('const received ='));
  });
});
