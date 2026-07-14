import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('server action error boundaries', () => {
  it('does not return raw database messages from the audited action surfaces', () => {
    const sources = [
      'lib/ai/actions.ts',
      'lib/family/actions.ts',
      'app/(app)/dashboard/family-signals/actions.ts',
      'lib/intelligence/hard-signals-server.ts',
      'app/(app)/admin/actions.ts',
      'app/(app)/admin/marketplace/reports/actions.ts',
      'app/(app)/dashboard/trust/actions.ts',
      'app/(app)/wallet/actions.ts',
      'lib/wallet/server.ts',
    ];

    for (const path of sources) {
      const source = readFileSync(path, 'utf8');
      expect(source).not.toMatch(/return[^\n]*error:\s*.*(?:error|e|upErr|sourceError|txnErr|wErr)\??\.message/);
      expect(source).toContain('describeActionError');
    }
  });

  it('checks every hard-signal source read before deriving signals', () => {
    const source = readFileSync('lib/intelligence/hard-signals-server.ts', 'utf8');
    expect(source).toContain('[reminders, events, choreRows, routines, budgetsRes, expensesRes]');
    expect(source).toContain('existingError');
  });
});
