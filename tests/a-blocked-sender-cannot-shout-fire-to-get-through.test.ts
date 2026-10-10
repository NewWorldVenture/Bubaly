// A parent's block outranks an emergency keyword.
//
// The pipeline's emergency override matched a broad list — 'fire', 'hurt',
// 'police', 'hospital', 'help me', 'emergency' — and unconditionally set
// routingMode to immediate_ring, over the explicit block and over any matched
// rule. So a harasser the parent had blocked texted "you'll get hurt" and was
// put straight through, and the family was notified with the first hundred
// characters of it. The override also ignored the member's own
// emergency_always_ring setting (01370), which no code path read.
//
// Now: a blocked contact, or a route that resolved to `blocked`, keeps its
// block and never escalates — the keyword match is recorded for parent review
// only. For everyone else, ringing through on an emergency is governed by
// emergency_always_ring (default true), and shouldEscalate is set regardless so
// the managers are told.
import { describe, expect, it } from 'vitest';
import { runDecisionPipeline, type MemberProfile } from '@/lib/guardian/pipeline';

type Canned = Record<string, { data: unknown; error: unknown }>;
const FAMILY = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const RULE = '44444444-4444-4444-8444-444444444444';

/** The same per-table stand-in tests/guardian-pipeline.test.ts uses, with the family's zone served by default. */
function mockSupabase(tables: Canned) {
  const withFamily: Canned = { families: { data: { id: FAMILY, timezone: 'UTC' }, error: null }, ...tables };
  return {
    from(table: string) {
      const canned = withFamily[table] ?? { data: null, error: null };
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
const PHONE = '+15125550142';

function profile(overrides: Partial<MemberProfile> = {}): MemberProfile & { family_id: string; is_active: boolean } {
  return {
    id: MEMBER, member_id: MEMBER, family_id: FAMILY, is_active: true, ai_persona_name: 'Buddy', ai_greeting_template: null,
    current_context: 'normal', guardian_phone: null,
    default_mode_immediate: 'immediate_ring', default_mode_close: 'immediate_ring', default_mode_trusted: 'immediate_ai_summary',
    default_mode_known: 'ai_handle_first', default_mode_unknown: 'voicemail_first', default_mode_suspected_spam: 'silent_handling',
    default_mode_blocked: 'blocked', context_overrides: {}, voicemail_greeting: null,
    ...overrides,
  };
}
const blockedContact = { data: { id: CONTACT, family_id: FAMILY, phone: PHONE, name: 'Harasser', trust_level: 'blocked', spam_score: 0 }, error: null };
const input = (initialTranscript: string) => ({ callerPhone: PHONE, callerName: null, familyId: FAMILY, memberId: MEMBER, initialTranscript });

describe('a blocked sender and an emergency keyword', () => {
  it('"you\'ll get hurt" from a blocked contact stays blocked and does not escalate', async () => {
    const sb = mockSupabase({ guardian_contacts: blockedContact, guardian_member_profiles: noRow, guardian_routing_rules: noRows });
    const r = await runDecisionPipeline(sb, input("you'll get hurt"));
    // The defect, in two assertions: this was immediate_ring, and the family
    // was notified of the message.
    expect(r.routingMode).toBe('blocked');
    expect(r.shouldEscalate).toBe(false);
    // Recorded for parent review, not acted on.
    expect(r.emergencyKeywords).toBe(true);
    expect(r.trustLevel).toBe('blocked');
  });

  it('every keyword on the list is covered, not just one', async () => {
    const sb = mockSupabase({ guardian_contacts: blockedContact, guardian_member_profiles: noRow, guardian_routing_rules: noRows });
    for (const word of ['911', 'emergency', 'help me', 'heart attack', 'stroke', 'fire', 'crash', 'accident', 'hospital', 'police', 'hurt', 'dying']) {
      const r = await runDecisionPipeline(sb, input(`there is a ${word} here`));
      expect(r.routingMode, word).toBe('blocked');
      expect(r.shouldEscalate, word).toBe(false);
    }
  });

  it('a rule that resolved to blocked is not overridden either', async () => {
    const sb = mockSupabase({
      guardian_contacts: { data: { id: CONTACT, family_id: FAMILY, phone: PHONE, name: 'Ex', trust_level: 'known_contact', spam_score: 0 }, error: null },
      guardian_member_profiles: { data: profile(), error: null },
      guardian_routing_rules: {
        data: [{
          id: RULE, family_id: FAMILY, member_id: MEMBER, name: 'Block this caller', priority: 1, is_active: true,
          condition_contact_id: CONTACT, condition_trust_levels: null, condition_time_start: null, condition_time_end: null,
          condition_days_of_week: null, condition_contexts: null, condition_caller_pattern: null, action_routing_mode: 'blocked', action_notify_members: null,
        }],
        error: null,
      },
    });
    const r = await runDecisionPipeline(sb, input('call the police, there has been an accident'));
    expect(r.ruleId).toBe(RULE);
    expect(r.routingMode).toBe('blocked');
    expect(r.shouldEscalate).toBe(false);
    expect(r.emergencyKeywords).toBe(true);
  });
});

describe('an emergency from a sender the family has not blocked', () => {
  it('escalates and rings through for an unknown caller (positive control)', async () => {
    const sb = mockSupabase({ guardian_contacts: noRow, guardian_member_profiles: noRow, guardian_routing_rules: noRows });
    const r = await runDecisionPipeline(sb, input('please help me this is an emergency'));
    expect(r.shouldEscalate).toBe(true);
    expect(r.emergencyKeywords).toBe(true);
    expect(r.routingMode).toBe('immediate_ring');
  });

  it('still escalates, but does not ring through, when the member\'s profile says emergency_always_ring is off', async () => {
    const sb = mockSupabase({ guardian_contacts: noRow, guardian_member_profiles: { data: profile({ emergency_always_ring: false }), error: null }, guardian_routing_rules: noRows });
    const r = await runDecisionPipeline(sb, input('please help me this is an emergency'));
    expect(r.shouldEscalate).toBe(true);
    // The profile's own default for an unknown caller, not immediate_ring.
    expect(r.routingMode).toBe('voicemail_first');
  });

  it('rings through when the profile leaves emergency_always_ring on', async () => {
    const sb = mockSupabase({ guardian_contacts: noRow, guardian_member_profiles: { data: profile({ emergency_always_ring: true }), error: null }, guardian_routing_rules: noRows });
    const r = await runDecisionPipeline(sb, input('please help me this is an emergency'));
    expect(r.shouldEscalate).toBe(true);
    expect(r.routingMode).toBe('immediate_ring');
  });

  it('a routine message sets neither flag', async () => {
    const sb = mockSupabase({ guardian_contacts: noRow, guardian_member_profiles: noRow, guardian_routing_rules: noRows });
    const r = await runDecisionPipeline(sb, input('see you at dinner'));
    expect(r.shouldEscalate).toBe(false);
    expect(r.emergencyKeywords).toBe(false);
  });
});
