// Guardian routing rules run on the family's clock, not New York's.
//
// Every inbound call, SMS and WhatsApp goes through runDecisionPipeline, which
// built its rule context without a timezone; buildRuleContext then fell back
// to 'America/New_York'. A Los Angeles parent's "unknown callers 22:00–07:00 →
// silent" ran 19:00–04:00 Pacific — so unknown callers rang through between
// 04:00 and 07:00 while the parent believed they were screened, and a family
// in Tokyo was off by thirteen hours. Day-of-week conditions shifted the same
// way. families.timezone existed and was never read here.
//
// Now the zone is a fourth required policy read, and the rule context refuses
// to guess one.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRuleContext } from '@/lib/guardian/rules';
import { GuardianPolicyUnavailableError, runDecisionPipeline } from '@/lib/guardian/pipeline';

type Canned = Record<string, { data: unknown; error: unknown }>;
const FAMILY = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const RULE = '44444444-4444-4444-8444-444444444444';

function mockSupabase(tables: Canned) {
  return {
    from(table: string) {
      const canned = tables[table] ?? { data: null, error: null };
      const data = canned.data === null ? [] : Array.isArray(canned.data) ? canned.data : [canned.data];
      const result = { data, error: canned.error, count: data.length };
      const chain: Record<string, unknown> = {
        select: () => chain, eq: () => chain, or: () => chain, order: () => chain, limit: () => chain,
        abortSignal: () => chain, retry: () => chain,
        then: (f: (v: unknown) => unknown) => Promise.resolve(result).then(f),
      };
      return chain;
    },
  } as never;
}
const noRows = { data: [], error: null };
const noRow = { data: null, error: null };
const base = { contactId: null, trustLevel: 'unknown' as const, callerPhone: '+15125550142', callerName: null, memberContext: 'normal' };
const rule = (overrides: Record<string, unknown>) => ({
  id: RULE, family_id: FAMILY, member_id: MEMBER, name: 'Quiet hours', priority: 1, is_active: true,
  condition_contact_id: null, condition_trust_levels: ['unknown'], condition_time_start: null, condition_time_end: null,
  condition_days_of_week: null, condition_contexts: null, condition_caller_pattern: null, action_routing_mode: 'silent_handling', action_notify_members: null,
  ...overrides,
});
const input = { callerPhone: '+15125550142', callerName: null, familyId: FAMILY, memberId: MEMBER };
const inZone = (timezone: string, rules: unknown[]) => mockSupabase({
  families: { data: { id: FAMILY, timezone }, error: null }, guardian_contacts: noRow, guardian_member_profiles: noRow, guardian_routing_rules: { data: rules, error: null },
});

afterEach(() => { vi.useRealTimers(); });

describe('buildRuleContext', () => {
  // 2026-01-15T05:30Z is Thursday 05:30 UTC: Wednesday 21:30 in Los Angeles, Thursday 14:30 in Tokyo.
  const instant = new Date('2026-01-15T05:30:00Z');

  it('reads the hour, minute and weekday in the family\'s zone', () => {
    expect(buildRuleContext({ ...base, timezone: 'America/Los_Angeles', now: instant })).toMatchObject({ localHour: 21, localMinute: 30, dayOfWeek: 3 });
    expect(buildRuleContext({ ...base, timezone: 'Asia/Tokyo', now: instant })).toMatchObject({ localHour: 14, localMinute: 30, dayOfWeek: 4 });
    expect(buildRuleContext({ ...base, timezone: 'UTC', now: instant })).toMatchObject({ localHour: 5, localMinute: 30, dayOfWeek: 4 });
  });

  it('refuses to guess a zone', () => {
    // The old default. A family that never set one is not in New York.
    expect(() => buildRuleContext({ ...base, timezone: '', now: instant })).toThrow(/timezone/);
    expect(() => buildRuleContext({ ...base, timezone: 'Mars/Olympus_Mons', now: instant })).toThrow(/timezone/);
    expect(() => buildRuleContext({ ...base, timezone: undefined as unknown as string, now: instant })).toThrow(/timezone/);
  });
});

describe('runDecisionPipeline evaluates the family\'s rules on the family\'s clock', () => {
  const quietHours = rule({ condition_time_start: '22:00', condition_time_end: '07:00' });

  it('a 22:00–07:00 screen matches at 01:00 in Tokyo and not at 08:00 in Los Angeles — the same instant', async () => {
    // 16:00Z: 01:00 Friday in Tokyo, 08:00 Thursday in Los Angeles, 11:00 in New York.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'));
    // The defect: evaluated on New York's 11:00, this rule did not match and
    // an unknown caller rang a Tokyo child at one in the morning.
    await expect(runDecisionPipeline(inZone('Asia/Tokyo', [quietHours]), input)).resolves.toMatchObject({ routingMode: 'silent_handling', ruleId: RULE });
    await expect(runDecisionPipeline(inZone('America/Los_Angeles', [quietHours]), input)).resolves.toMatchObject({ routingMode: 'ai_handle_first', ruleId: null });
  });

  it('a Los Angeles 22:00–07:00 screen holds at 05:00 Pacific, which New York\'s clock read as 08:00', async () => {
    // 13:00Z: 05:00 in Los Angeles, 08:00 in New York. Under the old default
    // the window had already "ended" and unknown callers rang through.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-15T13:00:00Z'));
    await expect(runDecisionPipeline(inZone('America/Los_Angeles', [quietHours]), input)).resolves.toMatchObject({ routingMode: 'silent_handling', ruleId: RULE });
  });

  it('a day-of-week condition is the family\'s weekday', async () => {
    // 12:00Z Thursday: already Friday 01:00 in Auckland, still Thursday 04:00 in Los Angeles.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
    const fridays = rule({ condition_days_of_week: [5] });
    await expect(runDecisionPipeline(inZone('Pacific/Auckland', [fridays]), input)).resolves.toMatchObject({ routingMode: 'silent_handling', ruleId: RULE });
    await expect(runDecisionPipeline(inZone('America/Los_Angeles', [fridays]), input)).resolves.toMatchObject({ routingMode: 'ai_handle_first', ruleId: null });
  });

  it('does not route at all without a usable family zone', async () => {
    const missing = mockSupabase({ guardian_contacts: noRow, guardian_member_profiles: noRow, guardian_routing_rules: noRows });
    await expect(runDecisionPipeline(missing, input)).rejects.toEqual(new GuardianPolicyUnavailableError('timezone'));
    await expect(runDecisionPipeline(inZone(null as unknown as string, []), input)).rejects.toEqual(new GuardianPolicyUnavailableError('timezone'));
    await expect(runDecisionPipeline(inZone('Mars/Olympus_Mons', []), input)).rejects.toEqual(new GuardianPolicyUnavailableError('timezone'));
    const refused = mockSupabase({ families: { data: null, error: { message: 'permission denied' } }, guardian_contacts: noRow, guardian_member_profiles: noRow, guardian_routing_rules: noRows });
    await expect(runDecisionPipeline(refused, input)).rejects.toEqual(new GuardianPolicyUnavailableError('timezone'));
  });

  it('the pipeline never names New York', () => {
    for (const file of ['lib/guardian/pipeline.ts', 'lib/guardian/rules.ts']) {
      expect(readFileSync(file, 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''), file).not.toContain('America/New_York');
    }
  });
});
