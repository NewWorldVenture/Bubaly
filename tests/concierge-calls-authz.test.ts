import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-13 concierge-calls authorization guard. An outbound AI concierge call places
// REAL bookings/cancellations/confirmations with real businesses on the family's
// behalf and can incur telephony cost. RLS on `concierge_calls` is family-scoped
// (`is_family_member` for ALL ops — migration 0173), and children have real
// logins, so these server actions are the authorization boundary: a child must
// not be able to request, cancel, or re-queue an outbound call. This test asserts
// every mutation action gates on a family manager right after resolving context.
const SRC = 'app/(app)/dashboard/concierge-calls/actions.ts';

describe('A-13 every concierge-calls mutation requires a family manager', () => {
  const src = readFileSync(SRC, 'utf8');
  const lines = src.split('\n');

  it('imports the manager role check', () => {
    expect(src).toMatch(/import\s*\{[^}]*\bisManager\b[^}]*\}\s*from\s*'@\/lib\/constants\/roles'/);
  });

  it('gates every captured-context action on isManager on the very next line', () => {
    const offenders: number[] = [];
    lines.forEach((ln, i) => {
      if (ln.trim() === 'const ctx = await requireUserContext();') {
        // Skip intervening comment/blank lines — the gate must be the first
        // executable statement after the context is resolved.
        let j = i + 1;
        while (j < lines.length && /^\s*(\/\/|$)/.test(lines[j])) j++;
        const next = (lines[j] ?? '').trim();
        if (!/^if \(!isManager\(ctx\.active\.role\)\) return \{ ok: false, error:/.test(next)) {
          offenders.push(i + 1);
        }
      }
    });
    expect(offenders, `concierge-calls actions missing the manager gate at lines: ${offenders.join(', ')}`).toEqual([]);
  });

  it('leaves no ungated action that only awaits context without capturing it', () => {
    // `await requireUserContext();` (result discarded) can never be followed by a
    // role check — every mutation must capture ctx and gate on it.
    expect(src).not.toMatch(/^\s*await requireUserContext\(\);/m);
  });

  it('actually contains guarded mutation actions (not a no-op test)', () => {
    const guards = src.match(/if \(!isManager\(ctx\.active\.role\)\) return \{ ok: false, error:/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(3);
  });

  it('manager check means parent or adult only', () => {
    const roles = readFileSync('lib/constants/roles.ts', 'utf8');
    expect(roles).toMatch(/isManager\s*=\s*\([^)]*\)\s*=>\s*\n?\s*role === 'parent' \|\| role === 'adult'/);
  });
});
