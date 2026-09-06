import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';
import fs from 'node:fs';

// A-07 §3e slice (agent-05, PLA-0795): the Family Missions approval queue read
// `chore_submissions` and dropped `error`, so a failed read rendered the
// reassuring "All caught up! 🎉" empty state. This queue is a parent's source of
// truth for pending kid proofs, disputes and AI SAFETY FLAGS — a false-empty could
// hide a safety-flagged submission. The primary read now surfaces a retryable
// error instead of a false-empty queue.

const page = readUiSource('app/(app)/missions/page.tsx');

describe('missions approval queue surfaces a failed read (A-07 §3e)', () => {
  it('captures the chore_submissions read error', () => {
    expect(page).toContain('error: submissionsError');
  });

  it('returns a retryable ErrorState before building the queue / empty state', () => {
    expect(page).toContain('if (submissionsError)');
    expect(page).toContain('<ErrorState message=');
    // The error early-return must precede the "All caught up!" empty-state JSX
    // (match the JSX title, not the code comment that also mentions the phrase).
    expect(page.indexOf('if (submissionsError)')).toBeLessThan(page.indexOf('title="All caught up'));
  });
});
