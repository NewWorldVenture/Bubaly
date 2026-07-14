import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const actions = readFileSync('app/(app)/admin/marketing/loyalty/actions.ts', 'utf8');

describe('marketing loyalty action boundaries', () => {
  it('checks settings, reward, and redemption writes before audit logging', () => {
    expect(actions).toContain('marketingActionFailure');
    expect(actions).toContain(".select('singleton').single()");
    expect(actions).toContain(".select('id').maybeSingle()");
    expect(actions).toContain(".eq('status', 'pending')");
    expect(actions).not.toContain("await supabase.from('loyalty_settings').upsert(row, { onConflict: 'singleton' });");
    expect(actions).not.toContain("await supabase.from('loyalty_rewards').update(row).eq('id', id);");
    expect(actions).not.toContain("await supabase.from('loyalty_redemptions').update({ status: 'cancelled' }).eq('id', id);");
  });

  it('sanitizes failures from the points engine and redemption reads', () => {
    expect(actions).toContain("marketingActionFailure('adjust loyalty points', error)");
    expect(actions).toContain("marketingActionFailure('refund loyalty points', error)");
    expect(actions).toContain('if (readError) marketingActionFailure');
  });
});
