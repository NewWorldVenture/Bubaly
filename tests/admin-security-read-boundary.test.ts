import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';

const source = readUiSource('app/(app)/admin/security/page.tsx');

describe('admin security read boundary', () => {
  it('does not render empty account or audit security signals after a required read failure', () => {
    expect(source).toContain('invitesResult.error');
    expect(source).toContain('authUsersResult.error');
    expect(source).toContain('auditLogsResult.error');
    expect(source).toContain('familiesResult.error');
    expect(source).toContain("'error' in actorsResult");
    expect(source).toContain('Could not load security data from Supabase. Refresh and try again.');
    expect(source).toContain('Refresh security overview');
  });
});
