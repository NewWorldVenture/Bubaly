import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';

const source = readUiSource('app/(app)/admin/users/page.tsx');

describe('admin users read boundary', () => {
  it('surfaces super-admin allowlist read failures instead of rendering a silent empty list', () => {
    expect(source).toContain("['super_admins', superAdminsRes]");
    expect(source).toContain('if (res.error) loadErrors.push');
    expect(source).toContain('Some data couldn');
    expect(source).toContain('if (loadErrors.length > 0)');
    expect(source).toContain('Could not load users and family access data from Supabase');
    expect(source).toContain('Refresh users');
  });
});
