import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const actions = readFileSync('app/(app)/guardian/actions.ts', 'utf8');
const migration = readFileSync('supabase/migrations/0198_guardian_suggestion_review_transaction.sql', 'utf8');

describe('Guardian safety action boundaries', () => {
  it('sanitizes database failures and checks safety-state writes', () => {
    expect(actions).toContain('describeActionError');
    expect(actions).not.toMatch(/error:\s*[^\n]*\.message/);
    expect(actions).toContain("if (clashError) return actionFailure('check Guardian phone assignments', clashError);");
    expect(actions).toContain("if (auditError) console.error('[guardian-audit]");
    expect(actions).toContain("supabase.rpc('guardian_review_suggestion'");
  });

  it('keeps AI suggestion review authenticated and atomic', () => {
    expect(migration).toContain('create or replace function public.guardian_review_suggestion');
    expect(migration).toContain('public.can_manage_family(v_suggestion.family_id)');
    expect(migration.match(/for update/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(migration).toContain("revoke all on function public.guardian_review_suggestion(uuid, text, text) from public;");
    expect(migration).toContain("grant execute on function public.guardian_review_suggestion(uuid, text, text) to authenticated;");
    expect(migration).toContain("status = p_decision");
    expect(migration).toContain("'suggestion.' || p_decision");
  });
});
