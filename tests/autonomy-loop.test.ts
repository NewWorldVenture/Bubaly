import { describe, expect, it } from 'vitest';
import {
  approvalTitle, autonomyMode, autopilotStats, dialEffect, dialLevel,
  isAcceptance, runSummary,
} from '@/lib/autonomy/loop';
import { evaluateAction, type Policy } from '@/lib/trust/engine';

describe('isAcceptance', () => {
  it('fires only on the transition INTO an accepted status', () => {
    expect(isAcceptance('planning', 'booked')).toBe(true);
    expect(isAcceptance('idea', 'confirmed')).toBe(true);
    expect(isAcceptance('booked', 'confirmed')).toBe(false); // already accepted
    expect(isAcceptance('booked', 'booked')).toBe(false);
    expect(isAcceptance('planning', 'completed')).toBe(false);
    expect(isAcceptance('confirmed', 'cancelled')).toBe(false);
  });
});

describe('autonomyMode + dial mapping', () => {
  it('maps trust decisions to loop modes', () => {
    expect(autonomyMode({ effect: 'allow' })).toBe('auto');
    expect(autonomyMode({ effect: 'require_approval' })).toBe('ask');
    expect(autonomyMode({ effect: 'deny' })).toBe('off');
  });

  it('round-trips the dial through policy effects', () => {
    expect(dialLevel(dialEffect('auto'))).toBe('auto');
    expect(dialLevel(dialEffect('ask'))).toBe('ask');
    expect(dialLevel(dialEffect('off'))).toBe('off');
    // Safe default when the family has no policy yet.
    expect(dialLevel(null)).toBe('ask');
    expect(dialLevel('auto_approve')).toBe('auto');
  });
});

describe('trust-engine integration (the dial policy actually governs)', () => {
  const policy = (effect: Policy['effect']): Policy => ({
    id: 'p1', domain: 'scheduling', capability: 'automate', subjectKind: 'ai',
    subjectRole: null, subjectMemberId: null, effect, conditions: {},
    approvalModel: 'single', requiredApprovals: 1, priority: 10, enabled: true,
  });
  const actor = { kind: 'ai_agent' as const, id: 'concierge', role: 'parent' as const };

  it('allow policy → auto; require_approval → ask; deny → off', () => {
    expect(autonomyMode(evaluateAction({ actor, domain: 'scheduling', capability: 'automate', policies: [policy('allow')] }))).toBe('auto');
    expect(autonomyMode(evaluateAction({ actor, domain: 'scheduling', capability: 'automate', policies: [policy('require_approval')] }))).toBe('ask');
    expect(autonomyMode(evaluateAction({ actor, domain: 'scheduling', capability: 'automate', policies: [policy('deny')] }))).toBe('off');
  });
});

describe('runSummary + approvalTitle', () => {
  it('reads like a human wrote it', () => {
    expect(runSummary('Beach weekend', ['calendar', 'reminder', 'task']))
      .toBe('“Beach weekend” accepted — Bubaly put it on the calendar, set a follow-up reminder and added a prep task.');
    expect(runSummary('Beach weekend', ['reminder']))
      .toBe('“Beach weekend” accepted — Bubaly set a follow-up reminder.');
    expect(runSummary('Beach weekend', [])).toContain('already in place');
    expect(approvalTitle('  Beach weekend ')).toBe('Execute plan: Beach weekend');
    expect(approvalTitle('')).toBe('Execute plan: Untitled plan');
  });
});

describe('autopilotStats', () => {
  const NOW = new Date('2026-03-11T12:00:00Z');
  const run = (status: string, daysAgo: number, trigger = 'plan_accepted') => ({
    status, trigger_type: trigger,
    created_at: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
  });

  it('counts loop runs only, split by status and recency', () => {
    const stats = autopilotStats([
      run('executed', 1),
      run('executed', 3),
      run('executed', 30),               // executed, but not this week
      run('pending', 0),
      run('dismissed', 1),
      run('executed', 1, 'cron'),        // not the loop — ignored
    ], NOW);
    expect(stats.executedThisWeek).toBe(2);
    expect(stats.totalExecuted).toBe(3);
    expect(stats.pending).toBe(1);
  });
});
