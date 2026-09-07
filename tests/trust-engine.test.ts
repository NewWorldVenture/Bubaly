import { describe, it, expect } from 'vitest';
import {
  evaluateAction, computeTrustScore, trustBand, riskToDecision, toolTags,
  type Policy, type Actor, type Grant, type Delegation,
} from '@/lib/trust/engine';

const parent: Actor = { kind: 'member', id: 'p1', role: 'parent' };
const teen: Actor = { kind: 'member', id: 't1', role: 'teen' };
const child: Actor = { kind: 'member', id: 'c1', role: 'child' };
const ai: Actor = { kind: 'ai_agent', id: 'concierge', role: 'parent' };

function policy(p: Partial<Policy>): Policy {
  return {
    id: 'pol', domain: 'all', capability: 'all', subjectKind: 'everyone',
    effect: 'require_approval', conditions: {}, approvalModel: 'single',
    requiredApprovals: 1, priority: 100, enabled: true, ...p,
  };
}

describe('evaluateAction — role defaults (least privilege)', () => {
  it('lets a parent edit anything', () => {
    const d = evaluateAction({ actor: parent, domain: 'medical', capability: 'edit' });
    expect(d.effect).toBe('allow');
    expect(d.basis).toBe('role_default');
  });

  it('lets a teen view medical but requires approval to edit it (sensitive)', () => {
    expect(evaluateAction({ actor: teen, domain: 'medical', capability: 'view' }).effect).toBe('allow');
    const edit = evaluateAction({ actor: teen, domain: 'medical', capability: 'edit' });
    expect(edit.effect).toBe('require_approval');
  });

  it('denies a child a capability it does not have', () => {
    const d = evaluateAction({ actor: child, domain: 'finances', capability: 'edit' });
    expect(d.effect).toBe('deny');
    expect(d.basis).toBe('fallback');
  });

  it('lets a teen edit a non-sensitive domain (chores)', () => {
    expect(evaluateAction({ actor: teen, domain: 'chores', capability: 'edit' }).effect).toBe('allow');
  });
});

describe('evaluateAction — explicit grants', () => {
  it('an allow grant lets a teen edit a sensitive domain without approval', () => {
    const grants: Grant[] = [{ memberId: 't1', domain: 'medical', capability: 'edit', effect: 'allow' }];
    const d = evaluateAction({ actor: teen, domain: 'medical', capability: 'edit', grants });
    expect(d.effect).toBe('allow');
    expect(d.basis).toBe('allow_grant');
  });

  it('a deny grant beats everything, even for a parent', () => {
    const grants: Grant[] = [{ memberId: 'p1', domain: 'banking', capability: 'delete', effect: 'deny' }];
    const d = evaluateAction({ actor: parent, domain: 'banking', capability: 'delete', grants });
    expect(d.effect).toBe('deny');
    expect(d.basis).toBe('deny_grant');
  });
});

describe('evaluateAction — household policies', () => {
  it('auto-approves under a cost threshold', () => {
    const policies = [policy({ id: 'lt50', domain: 'scheduling', capability: 'automate', effect: 'auto_approve', conditions: { maxAmountCents: 5000 }, subjectKind: 'ai', priority: 200 })];
    const d = evaluateAction({ actor: ai, domain: 'scheduling', capability: 'automate', context: { amountCents: 3000 }, policies });
    expect(d.effect).toBe('allow');
    expect(d.policyId).toBe('lt50');
  });

  it('requires approval when over the cost threshold (condition no longer matches → role default)', () => {
    const policies = [policy({ id: 'lt50', domain: 'travel', capability: 'automate', effect: 'auto_approve', conditions: { maxAmountCents: 5000 }, subjectKind: 'ai', priority: 200 })];
    // $80 > $50 so the auto_approve policy does NOT match; AI automation in travel falls through to role default
    const d = evaluateAction({ actor: ai, domain: 'travel', capability: 'automate', context: { amountCents: 8000 }, policies });
    expect(d.effect).toBe('allow'); // parent-acting AI, travel not sensitive for parent
  });

  it('a deny policy blocks legal/medical AI even at high confidence', () => {
    const policies = [policy({ id: 'no-ai-legal', domain: 'documents', capability: 'automate', effect: 'deny', subjectKind: 'ai', priority: 300 })];
    const d = evaluateAction({ actor: ai, domain: 'documents', capability: 'automate', context: { confidence: 0.99 }, policies });
    expect(d.effect).toBe('deny');
  });

  it('respects a minConfidence condition', () => {
    const policies = [policy({ id: 'hi-conf', domain: 'medical', capability: 'automate', effect: 'auto_approve', conditions: { minConfidence: 0.95 }, subjectKind: 'ai', priority: 200 })];
    const low = evaluateAction({ actor: ai, domain: 'medical', capability: 'automate', context: { confidence: 0.6 }, policies });
    expect(low.effect).toBe('require_approval'); // policy doesn't match → AI automation default needs review
    const high = evaluateAction({ actor: ai, domain: 'medical', capability: 'automate', context: { confidence: 0.97 }, policies });
    expect(high.effect).toBe('allow');
  });

  it('honours a time window (babysitter 4pm–10pm)', () => {
    const sitter: Actor = { kind: 'member', id: 's1', role: 'caregiver' };
    const policies = [policy({ id: 'sitter-hours', domain: 'tasks', capability: 'approve', effect: 'allow', conditions: { timeStart: '16:00', timeEnd: '22:00' }, subjectKind: 'member', subjectMemberId: 's1', priority: 200 })];
    const inHours = evaluateAction({ actor: sitter, domain: 'tasks', capability: 'approve', context: { localTime: '18:30' }, policies });
    expect(inHours.effect).toBe('allow');
    const outHours = evaluateAction({ actor: sitter, domain: 'tasks', capability: 'approve', context: { localTime: '23:30' }, policies });
    // out of window → policy doesn't match; caregiver lacks 'approve' by default → deny
    expect(outHours.effect).toBe('deny');
  });

  it('higher priority policy wins on conflict', () => {
    const policies = [
      policy({ id: 'low', domain: 'shopping', capability: 'automate', effect: 'deny', subjectKind: 'ai', priority: 50 }),
      policy({ id: 'high', domain: 'shopping', capability: 'automate', effect: 'auto_approve', subjectKind: 'ai', priority: 500 }),
    ];
    const d = evaluateAction({ actor: ai, domain: 'shopping', capability: 'automate', policies });
    expect(d.effect).toBe('allow');
    expect(d.policyId).toBe('high');
  });
});

describe('evaluateAction — delegation', () => {
  it('an active delegation grants the domain', () => {
    const now = Date.now();
    const dels: Delegation[] = [{ toMemberId: 't1', domains: ['transportation'], startsAt: now - 1000, expiresAt: now + 1000, revoked: false }];
    const d = evaluateAction({ actor: teen, domain: 'transportation', capability: 'edit', delegations: dels, context: { now } });
    expect(d.effect).toBe('allow');
    expect(d.basis).toBe('delegation');
  });

  it('an expired delegation does not grant', () => {
    const now = Date.now();
    const dels: Delegation[] = [{ toMemberId: 't1', domains: ['transportation'], startsAt: now - 5000, expiresAt: now - 1000, revoked: false }];
    // transportation isn't sensitive for a teen and they have edit, so it allows by role default, not delegation
    const d = evaluateAction({ actor: teen, domain: 'driving', capability: 'edit', delegations: dels, context: { now } });
    expect(d.effect).toBe('require_approval'); // driving is sensitive for a teen; expired delegation can't help
  });
});

describe('evaluateAction — emergency override', () => {
  it('elevates a listed domain to allow', () => {
    const d = evaluateAction({ actor: child, domain: 'medical', capability: 'edit', emergencyDomains: ['medical'] });
    expect(d.effect).toBe('allow');
    expect(d.basis).toBe('emergency');
  });
  it('does not elevate domains not listed', () => {
    const d = evaluateAction({ actor: child, domain: 'finances', capability: 'edit', emergencyDomains: ['medical'] });
    expect(d.effect).toBe('deny');
  });
});

describe('computeTrustScore + trustBand', () => {
  it('starts near the role baseline with no history', () => {
    expect(computeTrustScore({ role: 'teen', interactions: 0, successes: 0 })).toBeGreaterThanOrEqual(45);
    expect(computeTrustScore({ role: 'teen', interactions: 0, successes: 0 })).toBeLessThanOrEqual(55);
  });
  it('rises with a strong track record', () => {
    const low = computeTrustScore({ role: 'teen', interactions: 2, successes: 2 });
    const high = computeTrustScore({ role: 'teen', interactions: 30, successes: 30 });
    expect(high).toBeGreaterThan(low);
  });
  it('falls with failures', () => {
    const good = computeTrustScore({ role: 'adult', interactions: 20, successes: 20 });
    const bad = computeTrustScore({ role: 'adult', interactions: 20, successes: 4 });
    expect(bad).toBeLessThan(good);
  });
  it('bands map sensibly', () => {
    expect(trustBand(90)).toBe('high');
    expect(trustBand(70)).toBe('trusted');
    expect(trustBand(50)).toBe('building');
    expect(trustBand(20)).toBe('low');
  });
});

// ─── §11's dial, and the blanket that used to beat it ───────────────────────

describe('the autonomy dial applies to every write, not only the medium ones', () => {
  const low = (behavior: 'recommend' | 'prepare' | 'execute') => riskToDecision({
    risk: 'low',
    actor: { kind: 'ai_agent', id: 'bubaly', role: 'parent' },
    domain: 'calendar',
    capability: 'automate',
    behavior,
    explicitAllow: false,
  });

  it('"Suggests only" stops a low-risk write — most of what Bubaly does', () => {
    // calendar.createEvent, tasks.createTodo, chores, reminders, groceries:
    // twenty write tools declare risk 'low'. Before this they ignored the dial
    // entirely, so a family set to "Recommend" still had events created.
    expect(low('recommend')).toMatchObject({ effect: 'deny', basis: 'risk_tier' });
  });

  it('"Prepare" stages a low-risk write for a person instead of doing it', () => {
    expect(low('prepare')).toMatchObject({ effect: 'require_approval', basis: 'risk_tier' });
  });

  it('"Execute" changes nothing — the role matrix still has the last word', () => {
    expect(low('execute')).toMatchObject({ effect: 'allow', basis: 'risk_tier' });
  });

  it('never loosens the high tier', () => {
    for (const behavior of ['recommend', 'prepare', 'execute'] as const) {
      const d = riskToDecision({
        risk: 'high',
        actor: { kind: 'ai_agent', id: 'bubaly', role: 'parent' },
        domain: 'finances',
        capability: 'automate',
        behavior,
        explicitAllow: false,
      });
      expect(d?.effect, behavior).not.toBe('allow');
    }
  });

  it('leaves reads alone: the dial is about acting', () => {
    expect(riskToDecision({
      risk: 'low',
      actor: { kind: 'member', id: 'm1', role: 'parent' },
      domain: 'calendar',
      capability: 'view',
      behavior: 'recommend',
      explicitAllow: false,
    })).toBeNull();
  });
});

describe('a household policy is only a decision about what it names', () => {
  const policy = (over: Partial<Policy>): Policy => ({
    id: 'p1', domain: 'finances', capability: 'automate', subjectKind: 'ai', effect: 'allow',
    conditions: {}, approvalModel: 'single', requiredApprovals: 1, priority: 10, enabled: true, ...over,
  });
  const evaluate = (p: Policy) => evaluateAction({
    actor: { kind: 'ai_agent', id: 'bubaly', role: 'parent' },
    domain: 'finances', capability: 'automate', policies: [p],
  });

  it('marks a domain=all allow as the blanket it is', () => {
    expect(evaluate(policy({ domain: 'all', capability: 'all' }))).toMatchObject({
      effect: 'allow', basis: 'policy', policyScope: 'broad',
    });
    // Still a blanket when it names a capability but no area of family life.
    expect(evaluate(policy({ domain: 'all' })).policyScope).toBe('broad');
  });

  it('marks a policy that names the area it is talking about as specific', () => {
    expect(evaluate(policy({}))).toMatchObject({ effect: 'allow', basis: 'policy', policyScope: 'specific' });
    // "Bubaly may do anything with our money" is a deliberate, scoped choice.
    expect(evaluate(policy({ capability: 'all' })).policyScope).toBe('specific');
  });

  it('does not label a deny or an approval requirement — only an allow can over-reach', () => {
    expect(evaluate(policy({ domain: 'all', capability: 'all', effect: 'deny' })).policyScope).toBeUndefined();
    expect(evaluate(policy({ domain: 'all', capability: 'all', effect: 'require_approval' })).policyScope).toBeUndefined();
  });
});

// ── M7 learned policies: a policy scoped by `conditions.tags` to ONE tool ────
// Household Autopilot offers a policy for the exact tool a family kept
// approving, and the accept action writes it as AI × domain × capability with
// `conditions.tags = [toolName]`. The gates hand the engine the executing
// tool's name as a tag (`toolTags`), so the policy reaches that tool and no
// other in the same domain.
describe('evaluateAction — a tag-scoped AI policy allows only the named tool', () => {
  const learned = policy({
    id: 'learned-record-expense', domain: 'finances', capability: 'automate', subjectKind: 'ai',
    effect: 'allow', conditions: { tags: ['finance.recordExpense'] }, priority: 200,
  });

  it('allows the named tool without approval, and names the policy that did it', () => {
    const d = evaluateAction({ actor: ai, domain: 'finances', capability: 'automate', context: { tags: toolTags('finance.recordExpense') }, policies: [learned] });
    expect(d.effect).toBe('allow');
    expect(d.basis).toBe('policy');
    expect(d.policyId).toBe('learned-record-expense');
    // Names its domain, so the risk tier treats it as the family's deliberate decision.
    expect(d.policyScope).toBe('specific');
  });

  it('leaves a neighbouring tool in the same domain on the default path', () => {
    const d = evaluateAction({ actor: ai, domain: 'finances', capability: 'automate', context: { tags: toolTags('finance.deleteExpense') }, policies: [learned] });
    expect(d.effect).toBe('require_approval');
    expect(d.basis).toBe('role_default');
    expect(d.policyId).toBeUndefined();
  });

  it('does not match an action that carries no tool tag at all', () => {
    const d = evaluateAction({ actor: ai, domain: 'finances', capability: 'automate', context: { confidence: 0.99 }, policies: [learned] });
    expect(d.effect).toBe('require_approval');
    expect(d.basis).toBe('role_default');
  });

  it('matches through a legacy alias only when the caller supplies the canonical name alongside it', () => {
    const aliasOnly = evaluateAction({ actor: ai, domain: 'finances', capability: 'automate', context: { tags: toolTags('record_expense') }, policies: [learned] });
    expect(aliasOnly.basis).toBe('role_default');
    const both = evaluateAction({ actor: ai, domain: 'finances', capability: 'automate', context: { tags: toolTags('record_expense', 'finance.recordExpense') }, policies: [learned] });
    expect(both.effect).toBe('allow');
    expect(both.policyId).toBe('learned-record-expense');
  });

  it('does not reach a person acting in the same domain', () => {
    const d = evaluateAction({ actor: teen, domain: 'finances', capability: 'automate', context: { tags: toolTags('finance.recordExpense') }, policies: [learned] });
    expect(d.policyId).toBeUndefined();
  });

  it('toolTags carries both spellings for every name, without duplicates or blanks', () => {
    expect(toolTags('reminders.create')).toEqual(['reminders.create', 'tool:reminders.create']);
    expect(toolTags('add_reminder', 'reminders.create')).toEqual(['add_reminder', 'tool:add_reminder', 'reminders.create', 'tool:reminders.create']);
    expect(toolTags('a', null, undefined, ' ', 'a')).toEqual(['a', 'tool:a']);
  });
});
