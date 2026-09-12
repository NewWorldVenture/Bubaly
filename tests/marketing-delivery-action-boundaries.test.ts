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

  it('claims push campaigns atomically and checks delivery prerequisites', () => {
    expect(push).toContain('marketingActionFailure');
    expect(push).toContain(".eq('status', campaign.status)");
    expect(push).toContain('markFailedAndThrow');
    expect(push).toContain('recipients = await loadPushCampaignAudience(supabase)');
    expect(push.indexOf('await loadPushCampaignAudience(supabase)')).toBeLessThan(push.indexOf('await sendPushToUsers('));
    expect(push).toMatch(/catch \(error\) \{\s*await markFailedAndThrow\(error\)/);
    for (const table of ['push_devices', 'profiles', 'marketing_suppressions']) expect(pushAudience).toContain(`.from('${table}')`);
    expect(pushAudience).toContain('if (result.error || !Array.isArray(result.data)) throw');
    expect(push).toContain(".eq('status', 'sending').select('id').maybeSingle()");
  });
});
