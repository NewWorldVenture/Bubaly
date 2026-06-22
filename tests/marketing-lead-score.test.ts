import { describe, it, expect } from 'vitest';
import { scoreLead, summarizeLeads, bandFor } from '@/lib/marketing/lead-score';

const now = new Date('2026-06-22T00:00:00Z').getTime();

describe('bandFor', () => {
  it('maps scores to bands', () => {
    expect(bandFor(80)).toBe('hot');
    expect(bandFor(50)).toBe('warm');
    expect(bandFor(20)).toBe('cold');
  });
});

describe('scoreLead', () => {
  it('scores a fresh, detailed, open lead as hot', () => {
    const s = scoreLead({
      createdAt: '2026-06-21T00:00:00Z', status: 'new', name: 'Sam',
      message: 'x'.repeat(220), isCustomer: false,
    }, now);
    expect(s.band).toBe('hot');          // 40 +30 +15 +10 +5 = 100
    expect(s.ageDays).toBe(1);
    expect(s.reasons).toContain('Detailed message');
  });

  it('scores an old, closed, empty lead as cold', () => {
    const s = scoreLead({
      createdAt: '2026-04-01T00:00:00Z', status: 'closed', name: null,
      message: '', isCustomer: false,
    }, now);
    expect(s.band).toBe('cold');         // 40 -10 -20 = 10
    expect(s.reasons).toContain('Already closed/resolved');
  });

  it('flags existing customers and bad dates', () => {
    const s = scoreLead({ createdAt: 'n/a', status: 'open', message: null, name: null, isCustomer: true }, now);
    expect(s.ageDays).toBe(999);
    expect(s.reasons).toContain('Existing customer');
  });
});

describe('summarizeLeads', () => {
  it('tallies bands and open count', () => {
    const out = summarizeLeads([
      { band: 'hot', status: 'new' },
      { band: 'cold', status: 'closed' },
      { band: 'warm', status: 'open' },
    ]);
    expect(out).toEqual({ total: 3, hot: 1, warm: 1, cold: 1, open: 2 });
  });
});
