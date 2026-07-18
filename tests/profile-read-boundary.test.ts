import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/profile/page.tsx', 'utf8');

// PLA-0810: the Profile page's identity is primary and safely falls back to the
// ctx member, so the page does NOT fail closed. But its contribution stats are a
// secondary enhancement that degrades to 0 on a read failure — a swallowed error
// would make "0 points / 0 chores" indistinguishable from a real failure, so
// each stat read error must be logged for observability.
describe('profile page read observability', () => {
  it('logs each secondary stat read failure (degrade-but-log)', () => {
    expect(page).toContain("console.error('[dashboard/profile] chore-points read failed', { memberId, error: doneQ.error });");
    expect(page).toContain("console.error('[dashboard/profile] upcoming-events read failed', { memberId, error: upcomingQ.error });");
    expect(page).toContain("console.error('[dashboard/profile] milestones read failed', { memberId, error: milestonesQ.error });");
  });

  it('keeps the identity best-effort with a ctx fallback (does not fail closed)', () => {
    expect(page).toContain('member={member ?? ctx.active.member}');
    expect(page).not.toContain('return <ErrorState');
  });
});
