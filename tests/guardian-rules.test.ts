import { describe, expect, it } from 'vitest';
import { evaluateRules, type GuardianRule, type RuleMatchContext, type DayOfWeek } from '@/lib/guardian/rules';

// A-12 guardian rules engine — the deterministic, parent-approved logic that
// decides WHEN a child's incoming call/message is screened, silenced, or rung
// through. It was previously untested. These lock its safety-critical behavior:
// priority ordering, overnight time windows, day/context/trust/pattern matching,
// AND-composition of conditions, and — the robustness fix — that a malformed
// parent-entered caller-pattern regex can no longer crash the whole pipeline.

function rule(overrides: Partial<GuardianRule> = {}): GuardianRule {
  return {
    id: overrides.id ?? 'r1',
    name: overrides.name ?? 'Rule',
    priority: overrides.priority ?? 100,
    is_active: overrides.is_active ?? true,
    condition_contact_id: overrides.condition_contact_id ?? null,
    condition_trust_levels: overrides.condition_trust_levels ?? null,
    condition_time_start: overrides.condition_time_start ?? null,
    condition_time_end: overrides.condition_time_end ?? null,
    condition_days_of_week: overrides.condition_days_of_week ?? null,
    condition_contexts: overrides.condition_contexts ?? null,
    condition_caller_pattern: overrides.condition_caller_pattern ?? null,
    action_routing_mode: overrides.action_routing_mode ?? 'ai_handle_first',
    action_notify_members: overrides.action_notify_members ?? null,
  };
}

function ctx(overrides: Partial<RuleMatchContext> = {}): RuleMatchContext {
  return {
    contactId: overrides.contactId ?? 'c1',
    trustLevel: overrides.trustLevel ?? 'known_contact',
    callerPhone: overrides.callerPhone ?? '+15125550142',
    callerName: overrides.callerName ?? 'Coach Dave',
    currentContext: overrides.currentContext ?? 'normal',
    localHour: overrides.localHour ?? 12,
    localMinute: overrides.localMinute ?? 0,
    dayOfWeek: (overrides.dayOfWeek ?? 3) as DayOfWeek,
  };
}

describe('evaluateRules', () => {
  it('returns the highest-priority (lowest number) matching rule', () => {
    const rules = [
      rule({ id: 'low', priority: 200, action_routing_mode: 'immediate_ring' }),
      rule({ id: 'high', priority: 10, action_routing_mode: 'blocked' }),
    ];
    const r = evaluateRules(rules, ctx());
    expect(r.matched).toBe(true);
    expect(r.rule?.id).toBe('high');
    expect(r.routingMode).toBe('blocked');
  });

  it('falls through with a default reason when nothing matches', () => {
    const r = evaluateRules([rule({ condition_contact_id: 'other' })], ctx({ contactId: 'c1' }));
    expect(r.matched).toBe(false);
    expect(r.routingMode).toBeNull();
    expect(r.reason).toMatch(/no rules matched/i);
  });

  it('skips inactive rules', () => {
    const r = evaluateRules([rule({ is_active: false, action_routing_mode: 'blocked' })], ctx());
    expect(r.matched).toBe(false);
  });

  describe('time windows', () => {
    it('matches a normal daytime window inclusive of both ends', () => {
      const r = rule({ condition_time_start: '09:00', condition_time_end: '17:00' });
      expect(evaluateRules([r], ctx({ localHour: 9, localMinute: 0 })).matched).toBe(true);   // start
      expect(evaluateRules([r], ctx({ localHour: 17, localMinute: 0 })).matched).toBe(true);  // end
      expect(evaluateRules([r], ctx({ localHour: 12 })).matched).toBe(true);
      expect(evaluateRules([r], ctx({ localHour: 8, localMinute: 59 })).matched).toBe(false);
      expect(evaluateRules([r], ctx({ localHour: 17, localMinute: 1 })).matched).toBe(false);
    });

    it('handles an overnight window (22:00–07:00) across midnight', () => {
      const r = rule({ condition_time_start: '22:00', condition_time_end: '07:00' });
      expect(evaluateRules([r], ctx({ localHour: 23 })).matched).toBe(true);   // before midnight
      expect(evaluateRules([r], ctx({ localHour: 0, localMinute: 30 })).matched).toBe(true); // after midnight
      expect(evaluateRules([r], ctx({ localHour: 7, localMinute: 0 })).matched).toBe(true);  // at end
      expect(evaluateRules([r], ctx({ localHour: 12 })).matched).toBe(false); // midday not in window
      expect(evaluateRules([r], ctx({ localHour: 7, localMinute: 1 })).matched).toBe(false);
    });
  });

  it('requires ALL set conditions to hold (AND-composition)', () => {
    const r = rule({
      condition_trust_levels: ['unknown', 'suspected_spam'],
      condition_days_of_week: [1, 2, 3, 4, 5],
      condition_contexts: ['driving', 'sleeping'],
    });
    // Every condition satisfied → match.
    expect(evaluateRules([r], ctx({ trustLevel: 'unknown', dayOfWeek: 2, currentContext: 'driving' })).matched).toBe(true);
    // One condition off → no match.
    expect(evaluateRules([r], ctx({ trustLevel: 'close_family', dayOfWeek: 2, currentContext: 'driving' })).matched).toBe(false);
    expect(evaluateRules([r], ctx({ trustLevel: 'unknown', dayOfWeek: 6, currentContext: 'driving' })).matched).toBe(false);
    expect(evaluateRules([r], ctx({ trustLevel: 'unknown', dayOfWeek: 2, currentContext: 'normal' })).matched).toBe(false);
  });

  it('matches a caller pattern against the phone OR the name', () => {
    const r = rule({ condition_caller_pattern: 'coach|555-0142' });
    expect(evaluateRules([r], ctx({ callerName: 'Coach Dave', callerPhone: '' })).matched).toBe(true);   // name
    expect(evaluateRules([r], ctx({ callerName: '', callerPhone: '555-0142' })).matched).toBe(true);     // phone
    expect(evaluateRules([r], ctx({ callerName: 'Stranger', callerPhone: '+19999999999' })).matched).toBe(false);
  });

  it('does NOT crash on a malformed parent-entered caller-pattern regex (robustness)', () => {
    // A parent could type an invalid regex like "(" — this must not throw and
    // take down the whole guardian routing pipeline; the rule simply cannot match.
    const bad = rule({ id: 'bad', condition_caller_pattern: '(unclosed[', action_routing_mode: 'blocked' });
    const good = rule({ id: 'good', priority: 500, condition_contact_id: 'c1', action_routing_mode: 'ai_handle_first' });
    let result!: ReturnType<typeof evaluateRules>;
    expect(() => { result = evaluateRules([bad, good], ctx({ contactId: 'c1' })); }).not.toThrow();
    // The malformed rule can't match; evaluation continues to the next valid rule.
    expect(result.matched).toBe(true);
    expect(result.rule?.id).toBe('good');
  });
});
