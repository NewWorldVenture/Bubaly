import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// A-17 platform-admin authorization guard. The /admin console oversees EVERY
// family (users, families, billing, Stripe keys, bans, password resets, CRM,
// marketing, tiers…). The admin layout gates page RENDERS to super-admins, but a
// Next server action is a directly-invocable RPC endpoint — the layout does NOT
// protect it. So every admin action that touches the privileged service-role
// client MUST independently re-verify super-admin and fail closed. This test
// walks the whole admin actions tree and asserts that invariant, so a newly
// added admin action file can't ship writing platform data without a gate.

const ADMIN_ROOT = 'app/(app)/admin';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/(^|\/)(actions|[a-z-]+-actions)\.ts$/.test(p)) out.push(p);
  }
  return out;
}

const GATE = /isSuperAdmin|requireMarketingAdmin|requireSuperAdmin/;
const PRIVILEGED = /createServiceClient|requireMarketingAdmin/;

describe('A-17 every admin action re-verifies super-admin (layout is not enough)', () => {
  const files = walk(ADMIN_ROOT);

  it('finds a meaningful number of admin action files', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it('every admin actions file using the privileged client references a super-admin gate', () => {
    const violations = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return PRIVILEGED.test(src) && !GATE.test(src);
    });
    expect(violations, `admin action files touching the service client with no super-admin gate:\n${violations.join('\n')}`).toEqual([]);
  });

  it('the /admin layout gates the whole segment to super-admins and redirects others', () => {
    const layout = readFileSync(join(ADMIN_ROOT, 'layout.tsx'), 'utf8');
    expect(layout).toMatch(/isSuperAdmin\(\)/);
    expect(layout).toMatch(/redirect\(/);
  });

  it('requireMarketingAdmin — the gate for the ~78 marketing actions — enforces isSuperAdmin and fails closed', () => {
    const helper = readFileSync('lib/marketing/admin.ts', 'utf8');
    expect(helper).toMatch(/isSuperAdmin\(\)/);
    // must THROW (not just branch) when the caller is not a super-admin
    expect(helper).toMatch(/if\s*\(\s*!ok\s*\)\s*throw/);
  });
});
