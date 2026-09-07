import { describe, it, expect } from 'vitest';
import {
  OUTCOMES, OUTCOMES_BY_ID, OUTCOME_INTENT, buildOutcomePlan, buildOutcomeLaunchRequest, outcomeUrgencyCount,
  EMPTY_CONTEXT, type OutcomeContext, type OutcomeId,
} from '@/lib/outcomes/launcher';
import { INTENT_KEYS } from '@/lib/ai/context/intents';

const ctx = (over: Partial<OutcomeContext> = {}): OutcomeContext => ({ ...EMPTY_CONTEXT, ...over });

describe('OUTCOMES registry', () => {
  it('has the eight north-star outcomes with unique ids', () => {
    expect(OUTCOMES).toHaveLength(8);
    expect(new Set(OUTCOMES.map((o) => o.id)).size).toBe(8);
  });
  it('every outcome builds a non-empty plan with valid hrefs', () => {
    for (const o of OUTCOMES) {
      const steps = buildOutcomePlan(o.id);
      expect(steps.length).toBeGreaterThan(0);
      for (const s of steps) {
        expect(s.href.startsWith('/')).toBe(true);
        expect(s.label.length).toBeGreaterThan(0);
      }
    }
  });
  it('OUTCOMES_BY_ID resolves each id', () => {
    expect(OUTCOMES_BY_ID.run_today.title).toBe('Run Today');
    expect(OUTCOMES_BY_ID.feed_family.title).toBe('Feed the Family');
  });
});

describe('buildOutcomePlan — context badges', () => {
  it('empty context → no badges anywhere', () => {
    for (const o of OUTCOMES) {
      expect(buildOutcomePlan(o.id, EMPTY_CONTEXT).some((s) => s.badge)).toBe(false);
    }
  });

  it('run_today surfaces events + overdue badges', () => {
    const steps = buildOutcomePlan('run_today', ctx({ eventsToday: 3, overdueTasks: 2 }));
    expect(steps.find((s) => s.href === '/dashboard/calendar')!.badge).toBe('3 events');
    expect(steps.find((s) => s.href === '/dashboard/next-best-actions')!.badge).toBe('2 overdue');
  });

  it('singular/plural is correct', () => {
    const steps = buildOutcomePlan('run_today', ctx({ eventsToday: 1 }));
    expect(steps.find((s) => s.href === '/dashboard/calendar')!.badge).toBe('1 event');
  });

  it('feed_family badges the shopping list from openGrocery', () => {
    const steps = buildOutcomePlan('feed_family', ctx({ openGrocery: 5 }));
    expect(steps.find((s) => s.href === '/dashboard/grocery')!.badge).toBe('5 items');
  });

  it('celebrate badges upcoming birthdays', () => {
    const steps = buildOutcomePlan('celebrate', ctx({ birthdaysSoon: 2 }));
    expect(steps.find((s) => s.href === '/dashboard/celebrations')!.badge).toBe('2 coming up');
  });
});

describe('outcomeUrgencyCount', () => {
  it('counts badged steps for an outcome', () => {
    expect(outcomeUrgencyCount('run_today', ctx({ eventsToday: 1, overdueTasks: 1 }))).toBe(2);
    expect(outcomeUrgencyCount('run_today', EMPTY_CONTEXT)).toBe(0);
    expect(outcomeUrgencyCount('feed_family', ctx({ openGrocery: 3 }))).toBe(1);
  });
});

describe('exhaustiveness', () => {
  it('buildOutcomePlan handles every OutcomeId', () => {
    const ids: OutcomeId[] = ['run_today', 'feed_family', 'plan_trip', 'prepare_school', 'manage_money', 'stay_healthy', 'celebrate', 'prepare_unexpected'];
    for (const id of ids) expect(buildOutcomePlan(id)).toBeTruthy();
  });
});

// M25: an outcome that cannot be launched is a card with a button that lies.
describe('launching an outcome', () => {
  it('maps every outcome to a real intent', () => {
    for (const outcome of OUTCOMES) {
      const intent = OUTCOME_INTENT[outcome.id];
      expect(intent, outcome.id).toBeTruthy();
      expect(INTENT_KEYS, outcome.id).toContain(intent);
    }
    expect(Object.keys(OUTCOME_INTENT).sort()).toEqual(OUTCOMES.map((o) => o.id).sort());
  });

  it('builds a request with the outcome text, its intent and its page context', () => {
    const request = buildOutcomeLaunchRequest('manage_money');
    expect(request).toMatchObject({ outcomeId: 'manage_money', intent: 'spending_review', context: { module: 'outcomes:manage_money' } });
    expect(request.text.length).toBeGreaterThan(10);
  });

  it('gives every outcome its own non-empty launch sentence', () => {
    const texts = OUTCOMES.map((o) => buildOutcomeLaunchRequest(o.id).text);
    for (const text of texts) expect(text.trim().length).toBeGreaterThan(10);
    expect(new Set(texts).size).toBe(OUTCOMES.length);
  });
});
