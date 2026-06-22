import { describe, it, expect } from 'vitest';
import {
  contactDisplayName, dealsByStage, openPipelineValueCents, weightedPipelineValueCents,
  wonValueCents, winRate, formatCents, DEAL_STAGES, LIFECYCLE_STAGES, LEAD_STATUSES,
  type DealStage,
} from '@/lib/marketing/crm';

const deal = (stage: DealStage, amount_cents: number, id: string = stage) => ({ id, stage, amount_cents });

describe('contactDisplayName', () => {
  it('uses full name when present', () => {
    expect(contactDisplayName({ first_name: 'Ada', last_name: 'Lovelace', email: 'a@b.com' })).toBe('Ada Lovelace');
  });
  it('falls back to email then Unknown', () => {
    expect(contactDisplayName({ first_name: '', last_name: null, email: 'a@b.com' })).toBe('a@b.com');
    expect(contactDisplayName({ first_name: null, last_name: null, email: null })).toBe('Unknown contact');
  });
});

describe('dealsByStage', () => {
  it('groups by stage with every stage present', () => {
    const grouped = dealsByStage([deal('lead', 100), deal('won', 500, 'w'), deal('lead', 200, 'l2')]);
    expect(Object.keys(grouped).sort()).toEqual([...DEAL_STAGES].sort());
    expect(grouped.lead).toHaveLength(2);
    expect(grouped.won).toHaveLength(1);
    expect(grouped.negotiation).toHaveLength(0);
  });
});

describe('pipeline value', () => {
  const deals = [deal('lead', 10_000), deal('proposal', 20_000), deal('won', 50_000), deal('lost', 99_000)];
  it('open pipeline excludes won/lost', () => {
    expect(openPipelineValueCents(deals)).toBe(30_000);
  });
  it('weighted applies stage probability', () => {
    // lead 10000*0.1=1000 + proposal 20000*0.6=12000 = 13000
    expect(weightedPipelineValueCents(deals)).toBe(13_000);
  });
  it('won value sums won deals', () => {
    expect(wonValueCents(deals)).toBe(50_000);
  });
});

describe('winRate', () => {
  it('is won / (won+lost)', () => {
    expect(winRate([deal('won', 1), deal('won', 1, 'w2'), deal('lost', 1)])).toBeCloseTo(2 / 3);
  });
  it('is 0 when nothing closed', () => {
    expect(winRate([deal('lead', 1), deal('proposal', 1, 'p')])).toBe(0);
  });
});

describe('formatCents', () => {
  it('formats whole dollars with separators', () => {
    expect(formatCents(1_234_500)).toBe('$12,345');
    expect(formatCents(0)).toBe('$0');
  });
});

describe('stage constants', () => {
  it('expose the expected sets', () => {
    expect(LEAD_STATUSES).toContain('qualified');
    expect(LIFECYCLE_STAGES).toContain('evangelist');
    expect(DEAL_STAGES).toContain('negotiation');
  });
});
