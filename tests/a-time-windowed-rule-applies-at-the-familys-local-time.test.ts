// LIBRARY-30E3FF5E0E9D: a policy with a time window is satisfied only when the
// caller supplies `context.localTime`. ActionContext said it was "derived if
// omitted", but evaluateAction derived only `now`, and no production caller
// sets localTime. So a manager's "no spending between 22:00 and 06:00" rule was
// shown as active and never matched: the action fell through to grants and
// role defaults.
//
// The engine now derives HH:MM from `now` in the family's `timeZone`. Every
// instant here is fixed, so the answer does not depend on the machine's zone.
import { describe, expect, it } from 'vitest';
import { evaluateAction, localTimeIn, type Actor, type Policy } from '@/lib/trust/engine';

const parent: Actor = { kind: 'member', id: 'p1', role: 'parent' };
const ai: Actor = { kind: 'ai_agent', id: 'bubaly', role: 'parent' };

function policy(p: Partial<Policy>): Policy {
  return {
    id: 'pol', domain: 'all', capability: 'all', subjectKind: 'everyone',
    effect: 'require_approval', conditions: {}, approvalModel: 'single',
    requiredApprovals: 1, priority: 100, enabled: true, ...p,
  };
}

// 07:30 UTC is 23:30 the evening before in Los Angeles and 16:30 in Tokyo.
const NOW = Date.parse('2026-11-11T07:30:00Z');
const NIGHT_DENY = [policy({ id: 'night', domain: 'shopping', effect: 'deny', conditions: { timeStart: '22:00', timeEnd: '06:00' }, priority: 300 })];

describe('a time-windowed rule applies at the family\'s local time', () => {
  it('reads the family\'s wall clock for an instant', () => {
    expect(localTimeIn(NOW, 'America/Los_Angeles')).toBe('23:30');
    expect(localTimeIn(NOW, 'Asia/Tokyo')).toBe('16:30');
    expect(localTimeIn(NOW, 'UTC')).toBe('07:30');
    expect(localTimeIn(Date.parse('2026-11-11T08:05:00Z'), 'America/Los_Angeles')).toBe('00:05');
    expect(localTimeIn(NOW, 'Not/AZone')).toBeUndefined();
    expect(localTimeIn(NOW, undefined)).toBeUndefined();
  });

  it('a night-time deny fires without the caller supplying localTime', () => {
    const d = evaluateAction({ actor: parent, domain: 'shopping', capability: 'edit', context: { now: NOW, timeZone: 'America/Los_Angeles' }, policies: NIGHT_DENY });
    expect(d).toMatchObject({ effect: 'deny', basis: 'policy', policyId: 'night' });
  });

  it('the same instant is outside the window for a family in Tokyo', () => {
    const d = evaluateAction({ actor: parent, domain: 'shopping', capability: 'edit', context: { now: NOW, timeZone: 'Asia/Tokyo' }, policies: NIGHT_DENY });
    expect(d).toMatchObject({ effect: 'allow', basis: 'role_default' });
  });

  it('a time-windowed require-approval rule holds an assistant action inside its hours', () => {
    const policies = [policy({ id: 'evening', domain: 'calendar', capability: 'automate', subjectKind: 'ai', effect: 'require_approval', conditions: { timeStart: '21:00', timeEnd: '23:59' }, priority: 300 })];
    const held = evaluateAction({ actor: ai, domain: 'calendar', capability: 'automate', context: { now: NOW, timeZone: 'America/Los_Angeles', confidence: 0.9 }, policies });
    expect(held).toMatchObject({ effect: 'require_approval', basis: 'policy', policyId: 'evening' });
    const free = evaluateAction({ actor: ai, domain: 'calendar', capability: 'automate', context: { now: NOW, timeZone: 'Asia/Tokyo', confidence: 0.9 }, policies });
    expect(free.policyId).toBeUndefined();
  });

  it('a localTime the caller did supply is the one used', () => {
    const d = evaluateAction({ actor: parent, domain: 'shopping', capability: 'edit', context: { now: NOW, timeZone: 'America/Los_Angeles', localTime: '12:00' }, policies: NIGHT_DENY });
    expect(d.effect).toBe('allow');
  });

  it('with neither a localTime nor a zone the hour is unknown, and the window is not assumed', () => {
    const d = evaluateAction({ actor: parent, domain: 'shopping', capability: 'edit', context: { now: NOW }, policies: NIGHT_DENY });
    expect(d).toMatchObject({ effect: 'allow', basis: 'role_default' });
  });
});
