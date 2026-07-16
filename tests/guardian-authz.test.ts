import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-12 child-safety authorization guard. Guardian settings (routing rules,
// contacts, trust levels, guardian phone, member profiles) govern how a child's
// calls and messages are screened. RLS on the guardian tables is family-scoped
// (`is_family_member` for ALL ops — see migration 0137), and children have real
// logins, so these server actions are the authorization boundary: a child must
// not be able to disable/delete their own safety rules. This test asserts every
// mutation action gates on a family manager immediately after resolving context.
const SRC = 'app/(app)/guardian/actions.ts';

describe('A-12 every guardian mutation requires a family manager', () => {
  const src = readFileSync(SRC, 'utf8');
  const lines = src.split('\n');

  it('imports the manager role check', () => {
    expect(src).toMatch(/import\s*\{[^}]*\bisManager\b[^}]*\}\s*from\s*'@\/lib\/constants\/roles'/);
  });

  it('gates every captured-context action on isManager on the very next line', () => {
    const offenders: number[] = [];
    lines.forEach((ln, i) => {
      if (ln.trim() === 'const ctx = await requireUserContext();') {
        const next = (lines[i + 1] ?? '').trim();
        if (next !== 'if (!isManager(ctx.active.role)) return guardianForbidden();') {
          offenders.push(i + 1);
        }
      }
    });
    expect(offenders, `guardian actions missing the manager gate at lines: ${offenders.join(', ')}`).toEqual([]);
  });

  it('actually contains guarded mutation actions (not a no-op test)', () => {
    const guards = src.match(/if \(!isManager\(ctx\.active\.role\)\) return guardianForbidden\(\);/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(9);
  });

  it('manager check means parent or adult only', () => {
    const roles = readFileSync('lib/constants/roles.ts', 'utf8');
    expect(roles).toMatch(/isManager\s*=\s*\([^)]*\)\s*=>\s*\n?\s*role === 'parent' \|\| role === 'adult'/);
  });
});
