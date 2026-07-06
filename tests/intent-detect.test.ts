import { describe, it, expect } from 'vitest';
import { detectIntent } from '@/lib/intent/detect';
import { routeCommand, type CommandNavItem } from '@/lib/command-bar/route';

describe('detectIntent', () => {
  it('routes decision phrases to the Decision Engine', () => {
    for (const q of ['should we do soccer or swim?', 'help me decide on a car', 'which option is better']) {
      expect(detectIntent(q)?.intent).toBe('make_decision');
      expect(detectIntent(q)?.href).toBe('/dashboard/decisions');
    }
  });

  it('routes readiness questions to Life Readiness', () => {
    expect(detectIntent('are we ready for tomorrow?')?.intent).toBe('check_readiness');
    expect(detectIntent('ready for monday')?.href).toBe('/dashboard/readiness');
  });

  it('routes trip planning to Prep Plans', () => {
    expect(detectIntent('plan a trip to Denver')?.intent).toBe('plan_trip');
    expect(detectIntent('plan our vacation')?.href).toBe('/dashboard/prep-plans');
  });

  it('routes generic prep phrases to Prep Plans', () => {
    expect(detectIntent('get ready for the recital')?.intent).toBe('prep_for');
    expect(detectIntent('what do i need for camp')?.intent).toBe('prep_for');
  });

  it('routes meal planning to Meals', () => {
    expect(detectIntent("what's for dinner")?.intent).toBe('plan_meals');
    expect(detectIntent('plan the meals for the week')?.intent).toBe('plan_meals');
  });

  it('returns null for plain navigation / capture / noise', () => {
    for (const q of ['billing', 'remind me to call the dentist', 'calendar', 'x', '']) {
      expect(detectIntent(q)).toBeNull();
    }
  });

  it('honours rule order (decision beats meals when both could match)', () => {
    // "should we ... dinner" — decision phrasing wins
    expect(detectIntent('should we order dinner or cook?')?.intent).toBe('make_decision');
  });
});

describe('routeCommand surfaces intents', () => {
  const NAV: CommandNavItem[] = [
    { href: '/dashboard/calendar', label: 'Calendar' },
    { href: '/dashboard/decisions', label: 'Decision Engine' },
  ];

  it('adds an intent result for a goal phrase, above the assistant fallback', () => {
    const res = routeCommand('should we do soccer or swim?', NAV);
    const intentIdx = res.findIndex((r) => r.kind === 'intent');
    const assistantIdx = res.findIndex((r) => r.kind === 'assistant');
    expect(intentIdx).toBeGreaterThanOrEqual(0);
    expect(intentIdx).toBeLessThan(assistantIdx);
    const intent = res[intentIdx];
    if (intent.kind === 'intent') expect(intent.href).toBe('/dashboard/decisions');
  });

  it('does not add an intent for plain navigation text', () => {
    const res = routeCommand('calendar', NAV);
    expect(res.some((r) => r.kind === 'intent')).toBe(false);
  });

  it('keeps an exact nav match ahead of the intent', () => {
    const res = routeCommand('Decision Engine', NAV);
    // exact nav hit should be first; intent (if any) never outranks it
    expect(res[0].kind).toBe('navigate');
  });
});
