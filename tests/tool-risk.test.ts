// `riskToDecision` is the §12 risk tier: what a tool's blast radius adds to a
// decision the role matrix would otherwise have made on its own.
//
// The property these tests pin down is PRECEDENCE, because that is where a
// permissions bug hurts: the tier must be able to tighten a generic role
// default (a delete always asks; "recommend only" blocks a medium write) and
// must never loosen a gate that exists for a reason (anything in a sensitive
// or high-stakes domain, anything a person is already being asked about). The
// caller in `lib/ai/tools/execute.ts` only consults it when the engine landed
// on `role_default`/`fallback`, so "returns null" here means "the engine's
// answer stands".
import { describe, it, expect } from 'vitest';
import { riskToDecision, type Actor } from '@/lib/trust/engine';

const ai = (role: Actor['role']): Actor => ({ kind: 'ai_agent', id: 'bubaly', role });

describe('riskToDecision — high risk', () => {
  it('always asks a person, even for a parent in an everyday domain', () => {
    const decision = riskToDecision({ risk: 'high', actor: ai('parent'), domain: 'calendar', capability: 'automate' });
    expect(decision).toMatchObject({ effect: 'require_approval', basis: 'risk_tier' });
    expect(decision?.requiredApprovals).toBe(1);
  });

  it('stands aside when the family explicitly allowed it', () => {
    // An explicit allow policy or grant matched earlier; the tier does not
    // second-guess a decision the household made deliberately.
    expect(riskToDecision({ risk: 'high', actor: ai('parent'), domain: 'calendar', capability: 'automate', explicitAllow: true })).toBeNull();
  });
});

describe('riskToDecision — medium risk follows the autonomy setting', () => {
  it('blocks the write outright when Bubaly is set to recommend only', () => {
    const decision = riskToDecision({ risk: 'medium', actor: ai('parent'), domain: 'calendar', capability: 'automate', behavior: 'recommend' });
    expect(decision).toMatchObject({ effect: 'deny', basis: 'risk_tier' });
  });

  it('stages it for approval when Bubaly is set to prepare', () => {
    const decision = riskToDecision({ risk: 'medium', actor: ai('parent'), domain: 'calendar', capability: 'automate', behavior: 'prepare' });
    expect(decision).toMatchObject({ effect: 'require_approval', basis: 'risk_tier' });
  });

  it('adds nothing on execute, or when no preference is recorded', () => {
    expect(riskToDecision({ risk: 'medium', actor: ai('parent'), domain: 'calendar', capability: 'automate', behavior: 'execute' })).toBeNull();
    expect(riskToDecision({ risk: 'medium', actor: ai('parent'), domain: 'calendar', capability: 'automate' })).toBeNull();
  });
});

describe('riskToDecision — low risk auto-executes only where it is safe', () => {
  it('lets a parent or adult get on with small reversible work', () => {
    expect(riskToDecision({ risk: 'low', actor: ai('parent'), domain: 'calendar', capability: 'automate' }))
      .toMatchObject({ effect: 'allow', basis: 'risk_tier' });
    expect(riskToDecision({ risk: 'low', actor: ai('adult'), domain: 'tasks', capability: 'automate' }))
      .toMatchObject({ effect: 'allow', basis: 'risk_tier' });
  });

  it("lets a teen's assistant add a task — ROLE_DEFAULTS never grants a teen `automate`, so without this nothing a teen asks for would run", () => {
    expect(riskToDecision({ risk: 'low', actor: ai('teen'), domain: 'tasks', capability: 'automate' }))
      .toMatchObject({ effect: 'allow', basis: 'risk_tier' });
  });

  it('never loosens a high-stakes or role-sensitive domain', () => {
    // finances is HIGH_STAKES for everyone and sensitive for a teen; either
    // way the engine's own gate has to stand.
    expect(riskToDecision({ risk: 'low', actor: ai('parent'), domain: 'finances', capability: 'automate' })).toBeNull();
    expect(riskToDecision({ risk: 'low', actor: ai('teen'), domain: 'finances', capability: 'automate' })).toBeNull();
    expect(riskToDecision({ risk: 'low', actor: ai('adult'), domain: 'banking', capability: 'automate' })).toBeNull();
  });

  it('adds nothing for roles a household has not trusted with automation', () => {
    expect(riskToDecision({ risk: 'low', actor: ai('child'), domain: 'tasks', capability: 'automate' })).toBeNull();
    expect(riskToDecision({ risk: 'low', actor: ai('guest'), domain: 'tasks', capability: 'automate' })).toBeNull();
    expect(riskToDecision({ risk: 'low', actor: ai('caregiver'), domain: 'tasks', capability: 'automate' })).toBeNull();
  });
});

describe('riskToDecision — the view-sensitivity rule', () => {
  it('denies a child reading the family finances through any tool', () => {
    const decision = riskToDecision({ risk: 'low', actor: ai('child'), domain: 'finances', capability: 'view' });
    expect(decision).toMatchObject({ effect: 'deny', basis: 'risk_tier' });
    expect(decision?.reason).toMatch(/private to the adults/i);
  });

  it('denies a restricted role a tool flagged as a sensitive read even in a plain domain', () => {
    expect(riskToDecision({ risk: 'low', actor: ai('teen'), domain: 'tasks', capability: 'view', sensitiveRead: true }))
      .toMatchObject({ effect: 'deny', basis: 'risk_tier' });
  });

  it('leaves ordinary reads and manager reads alone', () => {
    expect(riskToDecision({ risk: 'low', actor: ai('child'), domain: 'calendar', capability: 'view' })).toBeNull();
    expect(riskToDecision({ risk: 'low', actor: ai('parent'), domain: 'finances', capability: 'view' })).toBeNull();
    expect(riskToDecision({ risk: 'low', actor: ai('adult'), domain: 'documents', capability: 'view' })).toBeNull();
  });

  it('respects an explicit share with a teen', () => {
    expect(riskToDecision({ risk: 'low', actor: ai('teen'), domain: 'finances', capability: 'view', explicitAllow: true })).toBeNull();
  });

  it('applies to member actors too, not just the AI', () => {
    expect(riskToDecision({ risk: 'low', actor: { kind: 'member', id: 'm-1', role: 'child' }, domain: 'medical', capability: 'view' }))
      .toMatchObject({ effect: 'deny', basis: 'risk_tier' });
  });
});
