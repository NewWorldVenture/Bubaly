import { describe, it, expect } from 'vitest';
import {
  classifyPaperwork, extractDates, extractAmount, extractActions,
  urgencyOf, triagePaperwork, deriveTitle,
} from '@/lib/paperwork/triage';

const NOW = new Date('2026-03-01T12:00:00Z');

describe('classifyPaperwork', () => {
  it('recognizes the common kinds', () => {
    expect(classifyPaperwork('Please sign and return this permission slip for the field trip')).toBe('permission_slip');
    expect(classifyPaperwork('Immunization records are required before enrollment')).toBe('medical_form');
    expect(classifyPaperwork('Practice schedule for the spring league — jersey fees due')).toBe('sports');
    expect(classifyPaperwork('Invoice attached. Amount due: $45.00 by Friday')).toBe('bill_or_payment');
    expect(classifyPaperwork("You're invited! RSVP for the spring open house")).toBe('event_flyer');
    expect(classifyPaperwork('A note from your classroom teacher about picture day')).toBe('school_notice');
    expect(classifyPaperwork('miscellaneous text with no signals')).toBe('other');
  });
});

describe('extractDates', () => {
  it('parses month-name dates and rolls past dates to next year', () => {
    expect(extractDates('Due March 5', NOW)).toEqual(['2026-03-05']);
    expect(extractDates('Due Mar 15, 2026', NOW)).toEqual(['2026-03-15']);
    // Jan 10 already passed relative to 2026-03-01 → 2027
    expect(extractDates('Party on January 10', NOW)).toEqual(['2027-01-10']);
  });

  it('parses numeric dates', () => {
    expect(extractDates('return by 3/20', NOW)).toEqual(['2026-03-20']);
    expect(extractDates('return by 3/20/27', NOW)).toEqual(['2027-03-20']);
  });
});

describe('extractAmount', () => {
  it('returns the largest dollar amount', () => {
    expect(extractAmount('$5 deposit, total $45.50 due')).toBe(45.5);
    expect(extractAmount('no money here')).toBeNull();
    expect(extractAmount('fee of $1,250.00')).toBe(1250);
  });
});

describe('extractActions', () => {
  it('extracts sign + pay with due date and amount', () => {
    const a = extractActions('Please sign and return the consent form with the $25 fee by March 10', NOW);
    const kinds = a.map((x) => x.kind);
    expect(kinds).toContain('sign');
    expect(kinds).toContain('pay');
    const pay = a.find((x) => x.kind === 'pay')!;
    expect(pay.amount).toBe(25);
    expect(pay.due_on).toBe('2026-03-10');
  });

  it('falls back to review when nothing matches', () => {
    const a = extractActions('general newsletter content', NOW);
    expect(a).toHaveLength(1);
    expect(a[0].kind).toBe('review');
  });
});

describe('urgencyOf', () => {
  it('ranks by days remaining', () => {
    expect(urgencyOf('2026-03-02', NOW)).toBe('urgent');   // tomorrow
    expect(urgencyOf('2026-03-06', NOW)).toBe('soon');     // 5 days
    expect(urgencyOf('2026-04-01', NOW)).toBe('normal');
    expect(urgencyOf(null, NOW)).toBe('normal');
  });
});

describe('triagePaperwork (end-to-end)', () => {
  it('triages a real permission slip', () => {
    const text = [
      'Field Trip to the Science Museum',
      'Dear Parents, please sign and return the attached permission slip',
      'along with the $12 admission fee by March 3rd. Bring a sack lunch.',
    ].join('\n');
    const t = triagePaperwork(text, NOW);
    expect(t.kind).toBe('permission_slip');
    expect(t.title).toContain('Field Trip');
    expect(t.due_on).toBe('2026-03-03');
    expect(t.amount).toBe(12);
    expect(t.urgency).toBe('urgent');
    expect(t.actions.map((a) => a.kind)).toEqual(expect.arrayContaining(['sign', 'pay', 'provide']));
    expect(t.summary).toContain('Permission slip');
  });
});

describe('deriveTitle', () => {
  it('uses the first meaningful line, capped', () => {
    expect(deriveTitle('\n\n  Book Fair Week!  \nmore text')).toBe('Book Fair Week!');
    expect(deriveTitle('')).toBe('Untitled paperwork');
  });
});
