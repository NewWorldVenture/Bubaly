import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/calm/page.tsx', 'utf8');

// Two failures, and they were treated identically when they are not alike.
//
// The five inbox reads are the inbox. The reasoning context ADDS graph insights
// to it — and the comment above that call already said "best-effort, so a
// missing graph never breaks the page", while the code immediately below it
// returned an ErrorState and broke the page. The comment was right and the code
// disagreed with it.
//
// Both now degrade, and both are surfaced: the inbox failures by name in the
// banner, the graph by a warning, with the inbox still rendered from whatever
// did load.
describe('Calm dashboard read boundary', () => {
  it('still inspects every inbox read', () => {
    expect(page).toContain('type ReadResult<T> = { data: T[]; error: unknown | null };');
    for (const r of ['agentResult', 'autopilotResult', 'foiResult', 'approvalResult', 'reminderResult']) {
      expect(page).toContain(r);
    }
  });

  it('names the failed inbox reads on screen rather than blanking', () => {
    expect(page).toContain('readFailures');
    expect(page).toContain('PartialReadBanner');
    expect(page).toContain('failures={readFailures}');
    expect(page).not.toContain('return <ErrorState');
  });

  it('honours "best-effort" for the reasoning graph it claims is best-effort', () => {
    expect(page).toMatch(/console\.warn\('\[dashboard-calm\] reasoning context read failed/);
    expect(page).toContain('reasoning = null;');
    // The inbox is still built and rendered when the graph is missing.
    expect(page).toContain('const inbox = buildCalmInbox(items);');
    expect(page).toContain('<CalmModule inbox={inbox} />');
  });
});
