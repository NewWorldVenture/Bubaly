import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const actions = readFileSync('app/(app)/admin/support-tickets/actions.ts', 'utf8');
const client = readFileSync('components/admin/ticket-row-actions.tsx', 'utf8');

describe('Support Ticket action boundaries', () => {
  it('checks privileged transitions, targets, and ticket creation writes', () => {
    expect(actions).toContain('describeActionError');
    expect(actions).toContain("if (!('supabase' in guarded)) return guarded;");
    expect(actions).toContain(".select('id')");
    expect(actions).toContain("if (!data) return { ok: false, error: 'Ticket not found.' }");
    expect(actions).toContain('if (error) return actionFailure');
    expect(actions).toContain('crypto.randomUUID');
  });

  it('validates ticket inputs and surfaces failures in the client', () => {
    expect(actions).toContain('emailSchema.safeParse');
    expect(actions).toContain('CATEGORIES.has(category)');
    expect(actions).toContain('PRIORITIES.has(priority)');
    expect(client).toContain('toastError');
    expect(client).toContain('success');
    expect(client).toContain('if (!result.ok)');
    expect(client).toContain('Please try again.');
  });
});
