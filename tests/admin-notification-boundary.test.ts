import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Super Admin notification delivery boundary', () => {
  it('checks Supabase errors when recording an admin notification', () => {
    const source = readFileSync('lib/admin/notify.ts', 'utf8');
    expect(source).toContain('const { error } = await admin.from(\'admin_notifications\').insert');
    expect(source).toContain("if (error) console.error('[admin-notify] insert failed', error)");
  });

  it('keeps mark-read mutations privileged and sanitized', () => {
    const source = readFileSync('app/(app)/admin/notifications-actions.ts', 'utf8');
    expect(source).toContain('if (!(await isSuperAdmin()))');
    expect(source).toContain('describeActionError');
    expect(source).toContain("if (error) return { ok: false, error: describeActionError(error, t('notificationsActions.couldNotUpdateNotifications')) }");
  });

  it('does not refresh the UI after a failed mark-read mutation', () => {
    for (const path of [
      'components/admin/admin-notifications-list.tsx',
      'components/admin/admin-notification-bell.tsx',
    ]) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).toContain('if (!result.ok)');
      expect(source, path).toContain('setError(result.error)');
      expect(source, path).toContain('router.refresh();');
    }
  });
});
