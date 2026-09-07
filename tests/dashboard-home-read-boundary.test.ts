import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/page.tsx', 'utf8');

// This test used to assert the opposite: that a failed preference read rendered
// `<ReadFailure />`. The principle behind it — never swallow a read failure —
// is right and is kept below. What changed is the response.
//
// The read answers one question: "did this user pin the family view?" When it
// fails the honest answer is "we don't know", which is operationally the same
// as "no", and lands them on the default home. Returning an error page instead
// turned an unknown preference into a total outage of the signed-in dashboard —
// so during the CONNECT_TIMEOUT incident that prompted this, a setting most
// users never touch was enough to take their home page away.
//
// Degrading is not swallowing: the failure is still logged with its message.
describe('dashboard home read boundary', () => {
  it('still surfaces a failed preference read to the logs', () => {
    expect(page).toContain('const { data: prefs, error: prefsError }');
    expect(page).toContain('if (prefsError)');
    expect(page).toMatch(/console\.warn\('\[dashboard-home\] preference read failed/);
  });

  it('degrades to the default view rather than replacing the dashboard', () => {
    // The whole point: no early return on the error path.
    expect(page).not.toContain('return <ReadFailure />');
    expect(page).not.toContain('ReadFailure');
    // The default still renders after a failed read.
    expect(page).toContain('return <AiHomeDashboard ctx={ctx} />');
  });

  it('treats an unreadable preference as no preference, not as family', () => {
    // savedView is derived from prefs?.default_dashboard, which is undefined
    // when the read failed — so the family branch cannot be taken by accident.
    expect(page).toContain('isDashboardView(prefs?.default_dashboard)');
    expect(page).toContain("if (savedView === 'family')");
  });
});
