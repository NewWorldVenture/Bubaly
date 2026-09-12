import { describe, expect, it } from 'vitest';
import { GuardianPolicyUnavailableError, runDecisionPipeline, type MemberProfile } from '@/lib/guardian/pipeline';

// A-12 guardian decision pipeline — the core child-safety routing that decides how
// every inbound call/message to a screened line is handled. Previously untested.
// runDecisionPipeline takes the Supabase client as a parameter, so we pass a tiny
// per-table mock and assert the ROUTING PRECEDENCE (matching rule > member profile
// > trust-based default) and the intended emergency escalation. (The emergency-vs-
// explicit-block precedence is a separate open product decision — PLA-0772 — and is
// deliberately NOT pinned here so fixing it won't fight this test.)

type Canned = Record<string, { data: unknown; error: unknown }>;
const FAMILY = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const RULE = '44444444-4444-4444-8444-444444444444';

/** Minimal Supabase stand-in: from(table) → a chain resolving to that table's canned result. */
function mockSupabase(tables: Canned) {
  return {
    from(table: string) {
      const canned = tables[table] ?? { data: null, error: null };
      const data = canned.data === null ? [] : Array.isArray(canned.data) ? canned.data : [canned.data];
      const result = { data, error: canned.error, count: data.length };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        or: () => chain,
        order: () => chain,
        limit: () => chain,
        abortSignal: () => chain,
        retry: () => chain,
        then: (f: (v: unknown) => unknown) => Promise.resolve(result).then(f),
      };
      return chain;
    },
  } as never;
}

const noRows = { data: [], error: null };
const noRow = { data: null, error: null };

function profile(overrides: Partial<MemberProfile> = {}): MemberProfile & { family_id: string; is_active: boolean } {
  return {
    id: MEMBER, member_id: MEMBER, family_id: FAMILY, is_active: true, ai_persona_name: 'Buddy', ai_greeting_template: null,
    current_context: 'normal', guardian_phone: null,
    default_mode_immediate: 'immediate_ring',
    default_mode_close: 'immediate_ring',
    default_mode_trusted: 'immediate_ai_summary',
    default_mode_known: 'ai_handle_first',
    default_mode_unknown: 'voicemail_first',
    default_mode_suspected_spam: 'silent_handling',
    default_mode_blocked: 'blocked',
    context_overrides: {},
    voicemail_greeting: null,
    ...overrides,
  };
}

const input = (over: Partial<Parameters<typeof runDecisionPipeline>[1]> = {}) => ({
  callerPhone: '+15125550142', callerName: 'Unknown Caller', familyId: FAMILY, memberId: MEMBER, ...over,
});

describe('runDecisionPipeline routing precedence', () => {
  it('uses the trust-based DEFAULT when there is no profile and no rule', async () => {
    const sb = mockSupabase({ guardian_contacts: noRow, guardian_member_profiles: noRow, guardian_routing_rules: noRows });
    const r = await runDecisionPipeline(sb, input());
    expect(r.trustLevel).toBe('unknown');
    expect(r.routingMode).toBe('ai_handle_first'); // defaultRouting(unknown)
  });

  it('rings immediate family and blocks a blocked contact by default', async () => {
    const fam = mockSupabase({
      guardian_contacts: { data: { id: CONTACT, family_id: FAMILY, phone: input().callerPhone, name: 'Grandma', trust_level: 'immediate_family', spam_score: 0 }, error: null },
      guardian_member_profiles: noRow, guardian_routing_rules: noRows,
    });
    expect((await runDecisionPipeline(fam, input())).routingMode).toBe('immediate_ring');

    const blk = mockSupabase({
      guardian_contacts: { data: { id: CONTACT, family_id: FAMILY, phone: input().callerPhone, name: 'Spammer', trust_level: 'blocked', spam_score: 90 }, error: null },
      guardian_member_profiles: noRow, guardian_routing_rules: noRows,
    });
    expect((await runDecisionPipeline(blk, input())).routingMode).toBe('blocked');
  });

  it('prefers the member PROFILE default over the hardcoded fallback', async () => {
    const sb = mockSupabase({
      guardian_contacts: noRow,
      guardian_member_profiles: { data: profile({ default_mode_unknown: 'voicemail_first' }), error: null },
      guardian_routing_rules: noRows,
    });
    const r = await runDecisionPipeline(sb, input());
    // profile.default_mode_unknown wins over defaultRouting(unknown)='ai_handle_first'
    expect(r.routingMode).toBe('voicemail_first');
    expect(r.memberProfile).not.toBeNull();
  });

  it('a matching ROUTING RULE wins over both profile and default', async () => {
    const sb = mockSupabase({
      guardian_contacts: { data: { id: CONTACT, family_id: FAMILY, phone: input().callerPhone, name: 'Coach', trust_level: 'known_contact', spam_score: 0 }, error: null },
      guardian_member_profiles: { data: profile(), error: null },
      guardian_routing_rules: {
        data: [{
          id: RULE, family_id: FAMILY, member_id: MEMBER, name: 'Block this caller', priority: 1, is_active: true,
          condition_contact_id: CONTACT, condition_trust_levels: null, condition_time_start: null,
          condition_time_end: null, condition_days_of_week: null, condition_contexts: null,
          condition_caller_pattern: null, action_routing_mode: 'blocked', action_notify_members: null,
        }],
        error: null,
      },
    });
    const r = await runDecisionPipeline(sb, input());
    expect(r.ruleId).toBe(RULE);
    expect(r.routingMode).toBe('blocked');
  });

  it('escalates an UNKNOWN caller to immediate_ring on an emergency transcript', async () => {
    const sb = mockSupabase({ guardian_contacts: noRow, guardian_member_profiles: noRow, guardian_routing_rules: noRows });
    const r = await runDecisionPipeline(sb, input({ initialTranscript: 'please help me this is an emergency' }));
    expect(r.shouldEscalate).toBe(true);
    expect(r.routingMode).toBe('immediate_ring');
  });

  it('stops before routing when required rules are unavailable', async () => {
    const sb = mockSupabase({
      guardian_contacts: noRow, guardian_member_profiles: noRow,
      guardian_routing_rules: { data: null, error: { message: 'permission denied' } },
    });
    await expect(runDecisionPipeline(sb, input())).rejects.toEqual(new GuardianPolicyUnavailableError('rules'));
  });
});
