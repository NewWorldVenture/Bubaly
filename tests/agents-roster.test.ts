import { describe, it, expect } from 'vitest';
import {
  AGENTS, AGENTS_BY_ID, runAgent, chiefOfStaff, runAllAgents,
  agentsNeedingAttention, EMPTY_AGENT_CONTEXT, type AgentContext,
} from '@/lib/agents/roster';

const ctx = (over: Partial<AgentContext> = {}): AgentContext => ({ ...EMPTY_AGENT_CONTEXT, ...over });

describe('AGENTS roster', () => {
  it('has 10 agents, Chief of Staff first, unique ids', () => {
    expect(AGENTS).toHaveLength(10);
    expect(AGENTS[0].id).toBe('chief_of_staff');
    expect(new Set(AGENTS.map((a) => a.id)).size).toBe(10);
  });
  it('AGENTS_BY_ID resolves', () => {
    expect(AGENTS_BY_ID.scheduler.name).toBe('Scheduler');
  });
});

describe('runAgent', () => {
  it('empty context → clear status, no items, a reassuring headline', () => {
    const b = runAgent('scheduler', EMPTY_AGENT_CONTEXT);
    expect(b.status).toBe('clear');
    expect(b.items).toHaveLength(0);
    expect(b.headline).toMatch(/clear/i);
  });

  it('a conflict makes the Scheduler status "action"', () => {
    const b = runAgent('scheduler', ctx({ conflicts: 2, eventsToday: 3 }));
    expect(b.status).toBe('action');
    const clash = b.items.find((i) => i.href === '/dashboard/conflicts');
    expect(clash?.severity).toBe('action');
    expect(clash?.title).toContain('2 schedule clashes');
  });

  it('only-info signals make status "attention" at most, not "action"', () => {
    const b = runAgent('meal_planner', ctx({ openGrocery: 5 })); // info only
    expect(b.status).toBe('attention'); // has an item, none is 'action'
    expect(b.items.every((i) => i.severity !== 'action')).toBe(true);
  });

  it('Budget Coach flags bills as action', () => {
    const b = runAgent('budget_coach', ctx({ billsDueSoon: 3 }));
    expect(b.status).toBe('action');
    expect(b.items[0].title).toContain('3 bills');
  });

  it('singular vs plural wording', () => {
    expect(runAgent('household_manager', ctx({ overdueChores: 1 })).items[0].title).toContain('1 overdue chore');
    expect(runAgent('household_manager', ctx({ overdueChores: 4 })).items[0].title).toContain('4 overdue chores');
  });
});

describe('chiefOfStaff', () => {
  it('synthesizes top items across specialists, action-first, max 5', () => {
    const specialists = [
      runAgent('scheduler', ctx({ conflicts: 1 })),
      runAgent('budget_coach', ctx({ billsDueSoon: 1, subscriptions: 4 })),
      runAgent('meal_planner', ctx({ openGrocery: 9 })),
      runAgent('memory_keeper', ctx({ birthdaysSoon: 2 })),
    ];
    const cos = chiefOfStaff(specialists);
    expect(cos.agentId).toBe('chief_of_staff');
    expect(cos.status).toBe('action');
    expect(cos.items.length).toBeLessThanOrEqual(5);
    // action-severity items sort ahead of info
    expect(cos.items[0].severity).toBe('action');
  });

  it('all clear → reassuring headline', () => {
    const cos = chiefOfStaff([runAgent('scheduler', EMPTY_AGENT_CONTEXT)]);
    expect(cos.status).toBe('clear');
    expect(cos.headline).toMatch(/on track/i);
  });
});

describe('runAllAgents', () => {
  it('returns Chief of Staff + 9 specialists', () => {
    const all = runAllAgents(ctx({ conflicts: 1, medsDue: 2, openGrocery: 3 }));
    expect(all).toHaveLength(10);
    expect(all[0].agentId).toBe('chief_of_staff');
  });

  it('agentsNeedingAttention counts specialists only', () => {
    const all = runAllAgents(ctx({ conflicts: 1, medsDue: 2 })); // scheduler + health_guide
    expect(agentsNeedingAttention(all)).toBe(2);
    expect(agentsNeedingAttention(runAllAgents(EMPTY_AGENT_CONTEXT))).toBe(0);
  });
});
