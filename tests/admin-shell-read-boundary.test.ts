import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const layout = readFileSync('app/(app)/admin/layout.tsx', 'utf8');
const shell = readFileSync('components/admin/admin-shell.tsx', 'utf8');

describe('admin shell read boundary', () => {
  it('surfaces independent service-role read failures instead of silently rendering defaults', () => {
    expect(layout).toContain('const [profileRes, invitesRes, notificationsRes]');
    expect(layout).toContain('if (profileRes.error)');
    expect(layout).toContain('if (invitesRes.error)');
    expect(layout).toContain('if (notificationsRes.error)');
    expect(layout).toContain('dataWarnings={dataWarnings}');
  });

  it('renders shell warnings accessibly without replacing the admin console', () => {
    expect(shell).toContain('dataWarnings?: string[]');
    expect(shell).toContain('role="status"');
    expect(shell).toContain('Some admin data is temporarily unavailable.');
  });
});
