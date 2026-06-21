import { describe, expect, it } from 'vitest';
import {
  computeNps, computeCsat, computeCes, npsCategory, distribution, summarize,
  isSurveyType, SURVEY_TYPES, generateSlug,
} from '@/lib/marketing/surveys';

describe('NPS', () => {
  it('categorizes scores', () => {
    expect(npsCategory(10)).toBe('promoter');
    expect(npsCategory(9)).toBe('promoter');
    expect(npsCategory(8)).toBe('passive');
    expect(npsCategory(7)).toBe('passive');
    expect(npsCategory(6)).toBe('detractor');
    expect(npsCategory(0)).toBe('detractor');
  });

  it('computes NPS = %promoters - %detractors', () => {
    // 6 promoters, 2 passives, 2 detractors of 10 → 60 - 20 = 40
    const scores = [10, 10, 9, 9, 9, 9, 8, 7, 3, 1];
    const r = computeNps(scores);
    expect(r.total).toBe(10);
    expect(r.promoters).toBe(6);
    expect(r.passives).toBe(2);
    expect(r.detractors).toBe(2);
    expect(r.nps).toBe(40);
  });

  it('handles all detractors and empty', () => {
    expect(computeNps([0, 1, 2]).nps).toBe(-100);
    expect(computeNps([]).nps).toBe(0);
    expect(computeNps([null, undefined]).total).toBe(0);
  });
});

describe('CSAT', () => {
  it('is the top-two-box percentage', () => {
    // 1-5 scale: 4s and 5s count. 3 of 5 in top box → 60%
    const r = computeCsat([5, 4, 3, 2, 5], 5);
    expect(r.csat).toBe(60);
    expect(r.total).toBe(5);
    expect(r.average).toBeCloseTo(3.8, 5);
  });
  it('handles empty', () => {
    expect(computeCsat([], 5).csat).toBe(0);
  });
});

describe('CES', () => {
  it('averages the scores', () => {
    const r = computeCes([7, 6, 5, 7]);
    expect(r.average).toBe(6.25);
    expect(r.total).toBe(4);
  });
});

describe('distribution + summarize', () => {
  it('counts each value across the scale', () => {
    const d = distribution([0, 0, 5, 10, 10, 10], 0, 10);
    expect(d).toHaveLength(11);
    expect(d.find((x) => x.value === 0)?.count).toBe(2);
    expect(d.find((x) => x.value === 10)?.count).toBe(3);
    expect(d.find((x) => x.value === 1)?.count).toBe(0);
  });

  it('summarize picks the right metric per type', () => {
    expect(summarize('nps', [10, 10, 0], 10).headline).toBe('NPS');
    expect(summarize('csat', [5, 5, 1], 5).headline).toBe('CSAT');
    expect(summarize('ces', [7, 7], 7).headline).toBe('CES');
    expect(summarize('csat', [5, 5, 5, 5], 5).value).toBe('100%');
  });
});

describe('config helpers', () => {
  it('validates survey types and exposes config', () => {
    expect(isSurveyType('nps')).toBe(true);
    expect(isSurveyType('bogus')).toBe(false);
    expect(SURVEY_TYPES.nps.scaleMax).toBe(10);
    expect(SURVEY_TYPES.csat.scaleMax).toBe(5);
    expect(SURVEY_TYPES.ces.scaleMax).toBe(7);
  });
  it('generates a url-safe slug', () => {
    expect(generateSlug('Q3 NPS Survey!')).toMatch(/^q3-nps-survey-[a-z0-9]{6}$/);
  });
});
