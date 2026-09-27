import { describe, expect, it } from 'vitest';
import { parseDecision } from '@/lib/guardian/ai-screen';

// The screening decision comes out of a model that is talking to an UNTRUSTED
// caller — the system prompt says so in as many words. Two things then treat
// its three enum fields as if they were guaranteed:
//
//   • app/api/guardian/screen/route.ts branches on string equality
//     (`action === 'hang_up'`, `risk === 'definite_scam'`) to decide whether to
//     hang up on a suspected scam or TRANSFER the call to the family member
//     being screened for.
//   • endScreening writes action/risk/urgency into guardian_screening_sessions,
//     whose CHECK constraints accept only the listed values. Anything else
//     raises 23514, the update is discarded, and the session stays 'active'.
//
// parseDecision used to check `!d.action || !d.urgency || !d.risk` — presence,
// not membership — and assign `JSON.parse` output straight into a type that
// promises four specific words. These pin membership.

const wrap = (fields: Record<string, unknown>) => JSON.stringify({ action: 'transfer', urgency: 'low', risk: 'safe', ...fields });

describe('a screening decision must name values the route and the column accept', () => {
  it('parses a well-formed decision', () => {
    const decision = parseDecision(wrap({ intent: 'personal', summary: 'Grandma calling', callerName: 'Ruth' }));
    expect(decision).toEqual({
      action: 'transfer', urgency: 'low', risk: 'safe',
      intent: 'personal', summary: 'Grandma calling', callerName: 'Ruth',
      shouldNotifyParents: false,
    });
  });

  it('rejects an action that is merely spelled differently', () => {
    // Each of these is present and truthy, so the old presence check passed it
    // through — and `action === 'hang_up'` then read false, transferring a call
    // the model had decided to end.
    for (const action of ['Hang_up', 'HANG_UP', 'hangup', 'hang up', 'end_call', 'escalate']) {
      expect(parseDecision(wrap({ action })), action).toBeNull();
    }
  });

  it('rejects a risk or urgency outside its own set', () => {
    // 'high' is a real urgency and not a real risk. Crossing the two is the
    // mistake a model makes most, and the CHECK constraint is where it landed.
    for (const risk of ['high', 'dangerous', 'Safe', 'unknown', '']) {
      expect(parseDecision(wrap({ risk })), risk).toBeNull();
    }
    for (const urgency of ['critical', 'urgent', 'Low', 'safe', '']) {
      expect(parseDecision(wrap({ urgency })), urgency).toBeNull();
    }
  });

  it('rejects a non-string where a decision word belongs', () => {
    for (const action of [1, true, null, ['hang_up'], { value: 'hang_up' }]) {
      expect(parseDecision(wrap({ action })), JSON.stringify(action)).toBeNull();
    }
  });

  it('still returns null for no JSON, bad JSON, and a missing field', () => {
    expect(parseDecision('I could not reach a decision.')).toBeNull();
    expect(parseDecision('{"action": ')).toBeNull();
    expect(parseDecision('{"action":"transfer","urgency":"low"}')).toBeNull();
  });

  it('defaults only the free-text fields, never the constrained ones', () => {
    const decision = parseDecision('{"action":"voicemail","urgency":"low","risk":"safe"}');
    expect(decision).not.toBeNull();
    expect(decision?.intent).toBe('other');
    expect(decision?.summary).toBe('');
    expect(decision?.callerName).toBeNull();
  });
});
