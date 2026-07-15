import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/(app)/admin/actions.ts', 'utf8');
const action = source.slice(source.indexOf('export async function adminCreateFamilyAction'));

describe('admin family creation boundary', () => {
  it('checks owner lookup failures and explicitly reconciles membership', () => {
    expect(action).toContain('error: ownerLookupError');
    expect(action).toContain('if (ownerLookupError) return actionFailure');
    expect(action).toContain(".from('family_members').upsert({");
    expect(action).toContain("onConflict: 'family_id,user_id'");
    expect(action).toContain('if (memberError)');
  });

  it('ensures a trial and cleans up the newly-created family on required-write failure', () => {
    expect(action).toContain(".from('subscriptions').select('id')");
    expect(action).toContain("status: 'trialing'");
    expect(action).toContain(".from('families').delete().eq('id', family.id)");
    expect(action).toContain('if (subscriptionError)');
  });
});
