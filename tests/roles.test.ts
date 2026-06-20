import { describe, expect, it } from 'vitest';
import { isManager, isAdmin } from '@/lib/constants/roles';

// UI gating helpers. These mirror the RLS permission matrix; the database is the
// real enforcement boundary, but these guard who sees management controls.
describe('role helpers', () => {
  it('treats only parent/adult as managers', () => {
    expect(isManager('parent')).toBe(true);
    expect(isManager('adult')).toBe(true);
    expect(isManager('teen')).toBe(false);
    expect(isManager('child')).toBe(false);
    expect(isManager('caregiver')).toBe(false);
    expect(isManager('guest')).toBe(false);
  });

  it('treats only parent as admin', () => {
    expect(isAdmin('parent')).toBe(true);
    expect(isAdmin('adult')).toBe(false);
  });

  it('fails closed for missing/unknown roles', () => {
    expect(isManager(null)).toBe(false);
    expect(isManager(undefined)).toBe(false);
    expect(isManager('')).toBe(false);
    expect(isAdmin(null)).toBe(false);
    expect(isManager('superuser')).toBe(false);
  });
});
