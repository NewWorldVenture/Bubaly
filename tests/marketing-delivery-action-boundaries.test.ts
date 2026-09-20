import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const personalization = readFileSync('app/(app)/admin/marketing/personalization/actions.ts', 'utf8');
const push = readFileSync('app/(app)/admin/marketing/push/actions.ts', 'utf8');
const pushAudience = readFileSync('lib/marketing/push-audience.ts', 'utf8');

describe('marketing delivery action boundaries', () => {
  it('checks personalization rule inserts, updates, and deletes', () => {
    expect(personalization).toContain('marketingActionFailure');
    expect(personalization).toContain(".select('id').maybeSingle()");
    expect(personalization).toContain('is(\'deleted_at\', null)');
    expect(personalization).not.toContain("await supabase.from('marketing_personalization_rules').update({ status");
  });

  it('loads the audited complete audience before dispatch', () => {
    // Claim races, failed writes and safe retry decisions execute through the
    // actual action in marketing-push-outcome-execution.test.ts.
    expect(push).toContain('marketingActionFailure');
    expect(push).toContain('recipients = await loadPushCampaignAudience(supabase)');
    expect(push.indexOf('await loadPushCampaignAudience(supabase)')).toBeLessThan(push.indexOf('await sendPushToUsers('));
    for (const table of ['push_devices', 'profiles', 'marketing_suppressions']) expect(pushAudience).toContain(`.from('${table}')`);
    expect(pushAudience).toContain('if (result.error || !Array.isArray(result.data)) throw');
  });
});
