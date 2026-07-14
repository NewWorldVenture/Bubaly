import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const actionFiles = [
  'app/(app)/feedback/actions.ts',
  'app/(app)/marketplace/actions.ts',
  'app/(app)/marketplace/alerts/actions.ts',
  'app/(app)/marketplace/community/actions.ts',
  'app/(app)/marketplace/report/actions.ts',
  'app/(app)/marketplace/handoff/actions.ts',
  'app/(app)/marketplace/negotiations/actions.ts',
];
const handoffMigration = readFileSync('supabase/migrations/0199_marketplace_handoff_completion.sql', 'utf8');

describe('Marketplace and Feedback action boundaries', () => {
  it('does not return raw database messages to callers', () => {
    for (const file of actionFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('describeActionError');
      expect(source, file).not.toMatch(/return \{ ok: false, error: [^\n}]*\.message/);
    }
  });

  it('fails closed on required marketplace reads before mutating', () => {
    const marketplace = readFileSync('app/(app)/marketplace/actions.ts', 'utf8');
    const handoff = readFileSync('app/(app)/marketplace/handoff/actions.ts', 'utf8');
    expect(marketplace).toContain("if (readError) return actionFailure('check the saved listing', readError);");
    expect(marketplace).toContain("if (orderError) return actionFailure('load the order', orderError);");
    expect(marketplace).toContain("if (listingError) return actionFailure('load the listing', listingError);");
    expect(handoff).toContain("if (orderError) return actionFailure('load the order', orderError);");
    expect(handoff).toContain("if (handoffError) return actionFailure('load the pickup', handoffError);");
  });

  it('keeps expected duplicate and domain messages explicit', () => {
    const feedback = readFileSync('app/(app)/feedback/actions.ts', 'utf8');
    const community = readFileSync('app/(app)/marketplace/community/actions.ts', 'utf8');
    const marketplace = readFileSync('app/(app)/marketplace/actions.ts', 'utf8');
    expect(feedback).toContain("error.code !== '23505'");
    expect(community).toContain('No circle found with that code');
    expect(marketplace).toContain('You already reviewed this exchange');
  });

  it('completes the hand-off and order in one authorized transaction', () => {
    const handoff = readFileSync('app/(app)/marketplace/handoff/actions.ts', 'utf8');
    expect(handoff).toContain("'marketplace_complete_handoff'");
    expect(handoffMigration).toContain('create or replace function public.marketplace_complete_handoff');
    expect(handoffMigration).toContain('public.is_family_member(v_order.family_id)');
    expect(handoffMigration.match(/for update/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(handoffMigration).toContain("revoke all on function public.marketplace_complete_handoff(uuid, text) from public;");
    expect(handoffMigration).toContain("grant execute on function public.marketplace_complete_handoff(uuid, text) to authenticated;");
    expect(handoffMigration).toContain("set status = 'completed'");
  });
});
