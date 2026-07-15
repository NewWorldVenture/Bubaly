import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chore = readFileSync('app/api/cron/chore-reminders/route.ts', 'utf8');
const weekly = readFileSync('app/api/cron/weekly-digest/route.ts', 'utf8');

describe('scheduled digest read boundaries', () => {
  it('fails chore reminders on family or Auth Admin read failures and reports send failures', () => {
    expect(chore).toContain('familiesError');
    expect(chore).toContain('authUsersError');
    expect(chore).toContain('let failed = 0;');
    expect(chore).toContain('{ status: failed === 0 ? 200 : 502 }');
  });

  it('fails weekly digest on family, member, feature, or send failures', () => {
    expect(weekly).toContain('familiesError');
    expect(weekly).toContain('authUsersError');
    expect(weekly).toContain('familyDataError');
    expect(weekly).toContain('adminMemberError');
    expect(weekly).toContain('{ status: failed === 0 ? 200 : 502 }');
  });
});
