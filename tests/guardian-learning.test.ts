import { describe, it, expect } from 'vitest';
import {
  analyzeCommunications,
  type CommSummary,
  type ContactSummary,
  REPEAT_SCAM_THRESHOLD,
  FREQUENT_UNKNOWN_THRESHOLD,
  PROVEN_SAFE_THRESHOLD,
  NIGHT_CALL_THRESHOLD,
} from '@/lib/guardian/learning';

const DAY_NOON = '2026-03-10T18:00:00.000Z'; // 18:00 UTC = daytime
const NIGHT = '2026-03-10T04:00:00.000Z';    // 04:00 UTC = night

function comm(p: Partial<CommSummary>): CommSummary {
  return {
    from_number: '+15551230001',
    contact_id: null,
    scam_detected: false,
    trust_level_at_time: 'unknown',
    started_at: DAY_NOON,
    ...p,
  };
}

describe('analyzeCommunications — repeat scammer', () => {
  it('proposes a block when an unsaved number is flagged scam >= threshold', () => {
    const comms = Array.from({ length: REPEAT_SCAM_THRESHOLD }, () =>
      comm({ scam_detected: true, from_number: '+15559999999' }));
    const drafts = analyzeCommunications({ communications: comms, contacts: [] });
    const block = drafts.find((dr) => dr.dedupeKey === 'block:+15559999999');
    expect(block).toBeTruthy();
    expect(block!.suggestion_type).toBe('flag_scam'); // no saved contact
    expect(block!.proposed_trust_level).toBe('blocked');
  });

  it('uses block_contact type when the number is a saved contact', () => {
    const comms = Array.from({ length: REPEAT_SCAM_THRESHOLD }, () =>
      comm({ scam_detected: true, from_number: '+15558887777', contact_id: 'c1' }));
    const contacts: ContactSummary[] = [
      { id: 'c1', phone: '+15558887777', name: 'Spammy', trust_level: 'unknown', trust_override: false },
    ];
    const drafts = analyzeCommunications({ communications: comms, contacts });
    const block = drafts.find((dr) => dr.suggestion_type === 'block_contact');
    expect(block).toBeTruthy();
    expect(block!.proposed_contact_id).toBe('c1');
  });

  it('does not propose blocking an already-blocked contact', () => {
    const comms = Array.from({ length: REPEAT_SCAM_THRESHOLD }, () =>
      comm({ scam_detected: true, from_number: '+15558887777', contact_id: 'c1' }));
    const contacts: ContactSummary[] = [
      { id: 'c1', phone: '+15558887777', name: 'Spammy', trust_level: 'blocked', trust_override: true },
    ];
    const drafts = analyzeCommunications({ communications: comms, contacts });
    expect(drafts.find((dr) => dr.suggestion_type.includes('block'))).toBeFalsy();
  });
});

describe('analyzeCommunications — frequent unknown', () => {
  it('proposes adding a frequent, scam-free unknown number to contacts', () => {
    const comms = Array.from({ length: FREQUENT_UNKNOWN_THRESHOLD }, () =>
      comm({ from_number: '+15551112222' }));
    const drafts = analyzeCommunications({ communications: comms, contacts: [] });
    const trust = drafts.find((dr) => dr.dedupeKey === 'trust:+15551112222:known_contact');
    expect(trust).toBeTruthy();
    expect(trust!.proposed_trust_level).toBe('known_contact');
  });

  it('does not propose for numbers below the frequency threshold', () => {
    const comms = Array.from({ length: FREQUENT_UNKNOWN_THRESHOLD - 1 }, () =>
      comm({ from_number: '+15551112222' }));
    const drafts = analyzeCommunications({ communications: comms, contacts: [] });
    expect(drafts.find((dr) => dr.dedupeKey.startsWith('trust:+15551112222'))).toBeFalsy();
  });
});

describe('analyzeCommunications — proven-safe upgrade', () => {
  it('proposes promoting a known_contact with many safe interactions', () => {
    const comms = Array.from({ length: PROVEN_SAFE_THRESHOLD }, () =>
      comm({ contact_id: 'c2', from_number: '+15553334444', trust_level_at_time: 'known_contact' }));
    const contacts: ContactSummary[] = [
      { id: 'c2', phone: '+15553334444', name: 'Coach Dave', trust_level: 'known_contact', trust_override: false },
    ];
    const drafts = analyzeCommunications({ communications: comms, contacts });
    const up = drafts.find((dr) => dr.dedupeKey === 'trust:c2:trusted_friend');
    expect(up).toBeTruthy();
    expect(up!.proposed_trust_level).toBe('trusted_friend');
  });

  it('respects a manual trust_override (no auto-upgrade)', () => {
    const comms = Array.from({ length: PROVEN_SAFE_THRESHOLD }, () =>
      comm({ contact_id: 'c2', from_number: '+15553334444' }));
    const contacts: ContactSummary[] = [
      { id: 'c2', phone: '+15553334444', name: 'Coach Dave', trust_level: 'known_contact', trust_override: true },
    ];
    const drafts = analyzeCommunications({ communications: comms, contacts });
    expect(drafts.find((dr) => dr.dedupeKey === 'trust:c2:trusted_friend')).toBeFalsy();
  });
});

describe('analyzeCommunications — quiet hours', () => {
  it('proposes a quiet-hours rule after enough night-time unknown calls', () => {
    const comms = Array.from({ length: NIGHT_CALL_THRESHOLD }, (_, i) =>
      comm({ from_number: `+1555000000${i}`, started_at: NIGHT, trust_level_at_time: 'unknown' }));
    const drafts = analyzeCommunications({ communications: comms, contacts: [] });
    const rule = drafts.find((dr) => dr.dedupeKey === 'rule:quiet_hours_unknown');
    expect(rule).toBeTruthy();
    expect(rule!.suggestion_type).toBe('new_rule');
    expect(rule!.proposed_rule_data?.action_routing_mode).toBe('silent_handling');
  });

  it('does not propose quiet hours for daytime calls', () => {
    const comms = Array.from({ length: NIGHT_CALL_THRESHOLD }, (_, i) =>
      comm({ from_number: `+1555000000${i}`, started_at: DAY_NOON }));
    const drafts = analyzeCommunications({ communications: comms, contacts: [] });
    expect(drafts.find((dr) => dr.dedupeKey === 'rule:quiet_hours_unknown')).toBeFalsy();
  });
});

describe('analyzeCommunications — empty input', () => {
  it('returns no drafts for no activity', () => {
    expect(analyzeCommunications({ communications: [], contacts: [] })).toEqual([]);
  });
});
