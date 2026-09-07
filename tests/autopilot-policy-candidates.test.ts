// Household Autopilot (M7): the pure half. A family that has said yes to the
// same tool three times over, never said no and never watched it fail has
// already decided — the candidate finder turns that history into ONE narrow
// policy offer, with the evidence a parent can check and a confidence that can
// never reach the auto tier. Everything here is deterministic, so every
// threshold is pinned.
import { describe, expect, it } from 'vitest';
import { AUTO_THRESHOLD, confidenceTier } from '@/lib/autopilot/engine';
import {
  acceptedPolicyName, findPolicyCandidates, humanizeToolName, isPolicySuggestionKey,
  policyCandidateToDraft, policyConfidence, policyCoversTool, policyDedupeKey, policyEvidence,
  policyProposalFromPayload, toolNameFromApprovalPayload,
  POLICY_ACTION_TYPE, POLICY_MAX_CONFIDENCE, POLICY_MIN_APPROVALS, POLICY_SUGGESTION_KIND, POLICY_WINDOW_DAYS,
  type ApprovalHistoryRow, type ExistingAiPolicy, type ToolCallHistoryRow,
} from '@/lib/autopilot/policy-candidates';

const NOW = '2026-09-07T12:00:00Z';

let seq = 0;
function approval(over: Partial<ApprovalHistoryRow> = {}): ApprovalHistoryRow {
  seq += 1;
  return {
    id: `approval-${seq}`, domain: 'scheduling', capability: 'automate', status: 'approved',
    decidedAt: '2026-08-20T10:00:00Z', requestedByKind: 'ai', toolName: 'reminders.create', ...over,
  };
}
function call(over: Partial<ToolCallHistoryRow> = {}): ToolCallHistoryRow {
  return { toolName: 'reminders.create', state: 'succeeded', createdAt: '2026-08-21T10:00:00Z', ...over };
}
const streak = (n: number, over: Partial<ApprovalHistoryRow> = {}): ApprovalHistoryRow[] => {
  const dates = ['2026-08-12T10:00:00Z', '2026-08-20T10:00:00Z', '2026-09-01T10:00:00Z', '2026-09-03T10:00:00Z', '2026-09-04T10:00:00Z', '2026-09-05T10:00:00Z', '2026-09-06T10:00:00Z', '2026-09-06T11:00:00Z'];
  return Array.from({ length: n }, (_, i) => approval({ decidedAt: dates[i % dates.length], ...over }));
};

describe('findPolicyCandidates — thresholds', () => {
  it('offers a policy after three approvals with no rejection and no failed call', () => {
    const out = findPolicyCandidates({ approvals: streak(3), toolCalls: [call(), call()], now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      domain: 'scheduling', capability: 'automate', toolName: 'reminders.create',
      approvals: 3, rejections: 0, corrections: 0, failedCalls: 0, succeededCalls: 2,
      firstApprovedAt: '2026-08-12T10:00:00Z', lastApprovedAt: '2026-09-01T10:00:00Z',
      dedupeKey: 'policy:scheduling:automate:reminders.create',
    });
  });

  it('two approvals are not enough', () => {
    expect(findPolicyCandidates({ approvals: streak(2), toolCalls: [], now: NOW })).toEqual([]);
    expect(POLICY_MIN_APPROVALS).toBe(3);
  });

  it('one rejection in the window withholds the offer, however long the streak', () => {
    const approvals = [...streak(6), approval({ status: 'rejected', decidedAt: '2026-08-25T10:00:00Z' })];
    expect(findPolicyCandidates({ approvals, toolCalls: [], now: NOW })).toEqual([]);
  });

  it('an approval with edits counts against the streak — the proposal was not right as Bubaly made it', () => {
    const approvals = [...streak(3), approval({ status: 'modified', decidedAt: '2026-08-25T10:00:00Z' })];
    expect(findPolicyCandidates({ approvals, toolCalls: [], now: NOW })).toEqual([]);
  });

  it('a failed call of that tool withholds the offer; a failed call of another tool does not', () => {
    const failedSame = [call({ state: 'failed' })];
    expect(findPolicyCandidates({ approvals: streak(4), toolCalls: failedSame, now: NOW })).toEqual([]);
    const failedOther = [call({ toolName: 'calendar.createEvent', state: 'failed' })];
    expect(findPolicyCandidates({ approvals: streak(4), toolCalls: failedOther, now: NOW })).toHaveLength(1);
  });

  it('a failed call outside the window does not count', () => {
    const old = [call({ state: 'failed', createdAt: '2026-05-01T10:00:00Z' })];
    expect(findPolicyCandidates({ approvals: streak(3), toolCalls: old, now: NOW })).toHaveLength(1);
  });

  it('ignores approvals outside the window, undecided rows, member-filed rows and rows that name no tool', () => {
    const cases: ApprovalHistoryRow[][] = [
      streak(3, { decidedAt: '2026-05-01T10:00:00Z' }),          // older than 90 days
      streak(3, { decidedAt: '2026-09-08T10:00:00Z' }),          // in the future
      streak(3, { status: 'pending', decidedAt: null }),         // not decided
      streak(3, { requestedByKind: 'member' }),                  // a person asked, not Bubaly
      streak(3, { toolName: null }),                             // a plan / concierge approval
    ];
    for (const approvals of cases) expect(findPolicyCandidates({ approvals, toolCalls: [], now: NOW })).toEqual([]);
    expect(POLICY_WINDOW_DAYS).toBe(90);
  });

  it('groups by domain + capability + tool, not by tool alone', () => {
    const approvals = [
      ...streak(2, { domain: 'scheduling' }),
      ...streak(2, { domain: 'calendar' }),
    ];
    expect(findPolicyCandidates({ approvals, toolCalls: [], now: NOW })).toEqual([]);
  });
});

describe('findPolicyCandidates — evidence and confidence', () => {
  it('carries the evidence a parent can check', () => {
    expect(policyEvidence(4, '2026-08-12T10:00:00Z')).toBe('Approved 4 times since 12 Aug, never rejected');
    const [c] = findPolicyCandidates({ approvals: streak(3), toolCalls: [], now: NOW });
    expect(c.evidence).toBe('Approved 3 times since 12 Aug, never rejected');
  });

  it('grows confidence by four per extra approval and never reaches the auto tier', () => {
    expect(policyConfidence(3)).toBe(70);
    expect(policyConfidence(4)).toBe(74);
    expect(policyConfidence(7)).toBe(86);
    expect(policyConfidence(8)).toBe(89);
    expect(policyConfidence(30)).toBe(89);
    expect(POLICY_MAX_CONFIDENCE).toBeLessThan(AUTO_THRESHOLD);
    expect(confidenceTier(POLICY_MAX_CONFIDENCE)).toBe('approve');
    for (const n of [3, 5, 8, 12]) {
      const [c] = findPolicyCandidates({ approvals: streak(n), toolCalls: [], now: NOW });
      expect(c.confidence).toBe(policyConfidence(n));
      expect(confidenceTier(c.confidence)).not.toBe('auto');
    }
  });

  it('sorts the strongest streak first, ties by key, so the order is stable across scans', () => {
    const approvals = [
      ...streak(3, { toolName: 'reminders.create' }),
      ...streak(5, { toolName: 'calendar.createEvent', domain: 'calendar' }),
      ...streak(3, { toolName: 'chores.create', domain: 'chores' }),
    ];
    const once = findPolicyCandidates({ approvals, toolCalls: [], now: NOW }).map((c) => c.dedupeKey);
    const twice = findPolicyCandidates({ approvals: [...approvals].reverse(), toolCalls: [], now: NOW }).map((c) => c.dedupeKey);
    expect(once).toEqual([
      'policy:calendar:automate:calendar.createEvent',
      'policy:chores:automate:chores.create',
      'policy:scheduling:automate:reminders.create',
    ]);
    expect(twice).toEqual(once);
  });
});

describe('findPolicyCandidates — policies the family already holds', () => {
  const base: ExistingAiPolicy = { domain: 'scheduling', capability: 'automate', effect: 'allow', enabled: true, conditions: {} };

  it('does not offer a tool an enabled allow policy already covers', () => {
    const covering: ExistingAiPolicy[] = [
      { ...base, conditions: { tags: ['reminders.create'] } },
      { ...base, conditions: { tags: ['tool:reminders.create'] } },
      { ...base },                                                  // blanket for the domain
      { ...base, domain: 'all', capability: 'all' },                // blanket for everything
      { ...base, effect: 'auto_approve', conditions: { tags: ['reminders.create'] } },
    ];
    for (const p of covering) {
      expect(policyCoversTool(p, 'scheduling', 'automate', 'reminders.create')).toBe(true);
      expect(findPolicyCandidates({ approvals: streak(3), toolCalls: [], existingPolicies: [p], now: NOW })).toEqual([]);
    }
  });

  it('still offers when the held policy is disabled, denies, names another tool or another domain', () => {
    const notCovering: ExistingAiPolicy[] = [
      { ...base, enabled: false },
      { ...base, effect: 'deny' },
      { ...base, effect: 'require_approval' },
      { ...base, conditions: { tags: ['reminders.delete'] } },
      { ...base, domain: 'calendar' },
      { ...base, capability: 'create' },
    ];
    for (const p of notCovering) {
      expect(policyCoversTool(p, 'scheduling', 'automate', 'reminders.create')).toBe(false);
      expect(findPolicyCandidates({ approvals: streak(3), toolCalls: [], existingPolicies: [p], now: NOW })).toHaveLength(1);
    }
  });
});

describe('dedupe key', () => {
  it('is stable and namespaced under policy:', () => {
    expect(policyDedupeKey('scheduling', 'automate', 'reminders.create')).toBe('policy:scheduling:automate:reminders.create');
    expect(isPolicySuggestionKey('policy:scheduling:automate:reminders.create')).toBe(true);
    expect(isPolicySuggestionKey('renewal:abc')).toBe(false);
    const a = findPolicyCandidates({ approvals: streak(3), toolCalls: [], now: NOW })[0].dedupeKey;
    const b = findPolicyCandidates({ approvals: streak(5), toolCalls: [call()], now: '2026-09-20T00:00:00Z' })[0].dedupeKey;
    expect(a).toBe(b);
  });
});

describe('policyCandidateToDraft — a suggestion that cannot execute anything', () => {
  it('becomes an open, non-auto suggestion whose payload round-trips to the proposal the trust action writes', () => {
    const [c] = findPolicyCandidates({ approvals: streak(4), toolCalls: [], now: NOW });
    const draft = policyCandidateToDraft(c, { now: NOW });
    expect(draft.kind).toBe(POLICY_SUGGESTION_KIND);
    expect(draft.actionType).toBe(POLICY_ACTION_TYPE);
    expect(draft.actionType).not.toBe('create_reminder');
    expect(draft.actionType).not.toBe('add_groceries');
    expect(draft.urgency).toBe(1);
    expect(draft.memberId).toBeNull();
    expect(draft.sourceKind).toBe('approval_requests');
    expect(draft.dedupeKey).toBe('policy:scheduling:automate:reminders.create');
    expect(confidenceTier(draft.confidence)).not.toBe('auto');
    expect(draft.title).toBe('Let Bubaly create reminders without asking');
    expect(draft.detail).toContain('Approved 4 times since 12 Aug, never rejected');
    expect(draft.expiresAt).toBe(new Date(new Date(NOW).getTime() + POLICY_WINDOW_DAYS * 86400000).toISOString());
    expect(policyProposalFromPayload(draft.payload)).toEqual({
      domain: 'scheduling', capability: 'automate', tool: 'reminders.create',
      approvals: 4, evidence: 'Approved 4 times since 12 Aug, never rejected', firstApprovedAt: '2026-08-12T10:00:00Z',
    });
  });

  it('rejects a payload that does not name one domain, capability and tool', () => {
    expect(policyProposalFromPayload(null)).toBeNull();
    expect(policyProposalFromPayload([])).toBeNull();
    expect(policyProposalFromPayload({ domain: 'scheduling', capability: 'automate' })).toBeNull();
    expect(policyProposalFromPayload({ domain: ' ', capability: 'automate', tool: 'x' })).toBeNull();
  });
});

describe('humanizers', () => {
  it('reads a tool name back as a sentence and names the policy it becomes', () => {
    expect(humanizeToolName('reminders.create')).toBe('create reminders');
    expect(humanizeToolName('calendar.createEvent')).toBe('create event in calendar');
    expect(humanizeToolName('add_todo')).toBe('add todo');
    expect(acceptedPolicyName({ tool: 'reminders.create' })).toBe('Bubaly may create reminders');
  });

  it('reads the tool name out of an approval payload, or nothing', () => {
    expect(toolNameFromApprovalPayload({ name: 'reminders.create', args: {} })).toBe('reminders.create');
    expect(toolNameFromApprovalPayload({ name: '  ' })).toBeNull();
    expect(toolNameFromApprovalPayload({ steps: [] })).toBeNull();
    expect(toolNameFromApprovalPayload(null)).toBeNull();
  });
});
