import { describe, expect, it } from 'vitest';
import { analyzeEstate, buildEstatePrompt, parseEstateResponse, type EstateDocForAI } from '@/lib/estate/estate-ai';

function doc(overrides: Partial<EstateDocForAI> = {}): EstateDocForAI {
  return { document_type: 'will', title: 'Last Will', review_status: 'current', effective_date: '2024-01-01', expiration_date: null, next_review: '2025-01-01', ...overrides };
}

describe('analyzeEstate', () => {
  it('summarizes docs', () => {
    const r = analyzeEstate([doc(), doc({ document_type: 'trust', review_status: 'needs_review' })]);
    expect(r.totalDocuments).toBe(2);
    expect(r.needsReviewCount).toBe(1);
  });
  it('handles empty', () => {
    expect(analyzeEstate([]).summary).toContain('No estate');
  });
});

describe('buildEstatePrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildEstatePrompt([doc()]);
    expect(system).toContain('JSON');
    expect(user).toContain('Last Will');
  });
});

describe('parseEstateResponse', () => {
  it('parses valid JSON', () => {
    const r = parseEstateResponse('{"suggestions":["update will"],"reviewPriorities":["trust"],"planningTip":"review annually"}');
    expect(r.suggestions).toEqual(['update will']);
    expect(r.planningTip).toBe('review annually');
  });
  it('handles malformed', () => {
    expect(parseEstateResponse('bad').suggestions).toEqual([]);
  });
});
