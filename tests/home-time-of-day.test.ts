import { describe, it, expect } from 'vitest';
import { dayPhase, phaseGreeting, phaseBlurb, focusForPhase } from '@/lib/home/time-of-day';
import { getMessages, translate } from '@/lib/i18n/messages';

const en = (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params);
const de = (key: string, params?: Record<string, string | number>) => translate(getMessages('de-DE'), key, params);

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
    expect(phaseGreeting('morning', en)).toBe('Good morning');
    expect(phaseGreeting('midday', en)).toBe('Good afternoon');
    expect(phaseGreeting('evening', en)).toBe('Good evening');
    expect(phaseGreeting('night', en)).toBe('Good evening');
  });
});

describe('phaseBlurb', () => {
  it('has a distinct blurb for every phase', () => {
    const blurbs = (['morning', 'midday', 'evening', 'night'] as const).map((p) => phaseBlurb(p, en));
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

describe('the phase is the family\'s, not the server\'s (DATA-022)', () => {
  // The home page and the dashboards render on the server, in UTC. At 8 pm in
  // Los Angeles (03:00 UTC) the old code said "Good morning" and offered the
  // morning shortcuts; at 8 am there (15:00 UTC) it said "Good afternoon".
  const evening = new Date('2026-07-04T03:00:00Z');   // 20:00 in Los Angeles
  const morning = new Date('2026-07-04T15:00:00Z');   // 08:00 in Los Angeles

  it('reads the hour in the family timezone', () => {
    expect(dayPhase(evening, 'America/Los_Angeles')).toBe('evening');
    expect(dayPhase(morning, 'America/Los_Angeles')).toBe('morning');
    expect(dayPhase(evening, 'Europe/Berlin')).toBe('morning');   // the same instant is 05:00 in Berlin
    expect(dayPhase(evening, 'UTC')).toBe('night');
  });

  it('and the words are the family\'s language', () => {
    expect(phaseGreeting('morning', de)).toBe('Guten Morgen');
    expect(focusForPhase('morning').map((i) => de(i.labelKey))).toContain('Wetter');
  });
});
