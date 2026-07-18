import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A-09 RBAC invariant. Every billing mutation route (checkout, change-plan,
// cancel, portal, and any future sibling) starts or alters a paid subscription,
// so each MUST authenticate the caller and gate on family-admin (parent) role
// before touching Stripe. A route that forgets the gate would let a teen/child
// member start, change, or cancel the family's billing. This test discovers the
// routes on disk so a newly added billing route cannot silently skip the gate.
const BILLING_DIR = 'app/api/billing';

function billingRoutes(): string[] {
  if (!existsSync(BILLING_DIR)) return [];
  return readdirSync(BILLING_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(BILLING_DIR, d.name, 'route.ts'))
    .filter((p) => existsSync(p));
}

describe('A-09 every billing route enforces auth + family-admin RBAC', () => {
  const routes = billingRoutes();

  it('discovers the billing mutation routes', () => {
    expect(routes.length).toBeGreaterThanOrEqual(4);
    for (const name of ['checkout', 'change-plan', 'cancel', 'portal']) {
      expect(routes.some((r) => r.split(/[\\/]/).includes(name))).toBe(true);
    }
  });

  it.each(billingRoutes())('%s authenticates the caller', (route) => {
    const src = readFileSync(route, 'utf8');
    expect(src, `${route} must call requireUserContext()`).toContain('requireUserContext');
  });

  it.each(billingRoutes())('%s gates on family-admin and returns 403 otherwise', (route) => {
    const src = readFileSync(route, 'utf8');
    expect(src, `${route} must gate on isAdmin(...)`).toMatch(/isAdmin\(/);
    expect(src, `${route} must return 403 for non-admins`).toContain('status: 403');
  });
});
