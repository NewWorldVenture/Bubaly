import { describe, it, expect } from 'vitest';
import { dayPhase, phaseGreeting, phaseBlurb, focusForPhase } from '@/lib/home/time-of-day';

function at(hour: number): Date {
  const d = new Date('2026-07-04T00:00:00');
  d.setHours(hour, 0, 0, 0);
  return d;
}

describe('dayPhase', () => {
  it('maps the hour to the right phase across all boundaries', () => {
    expect(dayPhase(at(5))).toBe('morning');
    expect(dayPhase(at(10))).toBe('morning');
    expect(dayPhase(at(11))).toBe('midday');
    expect(dayPhase(at(16))).toBe('midday');
    expect(dayPhase(at(17))).toBe('evening');
    expect(dayPhase(at(20))).toBe('evening');
    expect(dayPhase(at(21))).toBe('night');
    expect(dayPhase(at(2))).toBe('night');
    expect(dayPhase(at(4))).toBe('night');
  });
});

describe('phaseGreeting', () => {
  it('greets per phase; night reads as evening', () => {
    expect(phaseGreeting('morning')).toBe('Good morning');
    expect(phaseGreeting('midday')).toBe('Good afternoon');
    expect(phaseGreeting('evening')).toBe('Good evening');
    expect(phaseGreeting('night')).toBe('Good evening');
  });
});

describe('phaseBlurb', () => {
  it('has a distinct blurb for every phase', () => {
    const blurbs = (['morning', 'midday', 'evening', 'night'] as const).map(phaseBlurb);
    expect(new Set(blurbs).size).toBe(4);
    blurbs.forEach((b) => expect(b.length).toBeGreaterThan(0));
  });
});

describe('focusForPhase', () => {
  it('leads with the schedule in the morning and tomorrow at night', () => {
    expect(focusForPhase('morning')[0].key).toBe('schedule');
    expect(focusForPhase('night')[0].key).toBe('tomorrow');
  });
  it('returns valid dashboard hrefs + a lucide icon name, capped at max', () => {
    const items = focusForPhase('midday', 3);
    expect(items).toHaveLength(3);
    items.forEach((i) => {
      expect(i.href.startsWith('/dashboard/')).toBe(true);
      expect(i.icon.length).toBeGreaterThan(0);
    });
  });
  it('never returns more items than a phase defines', () => {
    expect(focusForPhase('night', 10).length).toBe(3); // night defines 3
  });
});
