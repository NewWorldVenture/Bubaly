import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// A-07 §3e slice (agent-05, PLA-0800): the kids' "submit your work" proof page read
// the chore assignment + chore and dropped `error`, so `if (!assignment) notFound()`
// / `if (!chore) notFound()` turned a transient read failure into a 404 — telling a
// kid the chore "doesn't exist" mid-submission (a dead end). Both reads now throw on
// a genuine error (retryable 5xx), reserving notFound() for a truly missing row.

const page = fs.readFileSync('app/(app)/kids/submit/[assignmentId]/page.tsx', 'utf8');

describe('kids submit-proof page throws on read error (never 404 a live chore)', () => {
  it('captures + throws on the assignment read error before notFound()', () => {
    expect(page).toContain('data: assignment, error: assignmentError');
    expect(page).toContain('if (assignmentError) throw new Error(');
    expect(page.indexOf('if (assignmentError) throw')).toBeLessThan(page.indexOf('if (!assignment) notFound();'));
  });

  it('captures + throws on the chore read error before notFound()', () => {
    expect(page).toContain('data: chore, error: choreError');
    expect(page).toContain('if (choreError) throw new Error(');
    expect(page.indexOf('if (choreError) throw')).toBeLessThan(page.indexOf('if (!chore) notFound();'));
  });
});
