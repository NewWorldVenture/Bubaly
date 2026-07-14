import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const personalization = readFileSync('app/(app)/admin/marketing/personalization/actions.ts', 'utf8');
const push = readFileSync('app/(app)/admin/marketing/push/actions.ts', 'utf8');

describe('marketing delivery action boundaries', () => {
  it('checks personalization rule inserts, updates, and deletes', () => {
    expect(personalization).toContain('marketingActionFailure');
    expect(personalization).toContain(".select('id').maybeSingle()");
    expect(personalization).toContain('is(\'deleted_at\', null)');
    expect(personalization).not.toContain("await supabase.from('marketing_personalization_rules').update({ status");
  });

  it('claims push campaigns atomically and checks delivery prerequisites', () => {
    expect(push).toContain('marketingActionFailure');
    expect(push).toContain(".eq('status', campaign.status)");
    expect(push).toContain('markFailedAndThrow');
    expect(push).toContain('deviceError');
    expect(push).toContain('profileError');
    expect(push).toContain('suppressionError');
    expect(push).toContain(".eq('status', 'sending').select('id').maybeSingle()");
  });
});
