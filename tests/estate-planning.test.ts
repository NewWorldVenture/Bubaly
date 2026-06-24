import { describe, expect, it } from 'vitest';
import {
  docTypeMeta,
  dayDiff,
  reviewUrgency,
  upcomingReviews,
  documentGaps,
  expiredDocuments,
  estateSummary,
  fmtDate,
  type DocumentLike,
} from '@/lib/estate/planning';

const TODAY = new Date('2026-06-24T12:00:00');

function doc(overrides: Partial<DocumentLike> & { id: string }): DocumentLike {
  return {
    document_type: 'will',
    title: 'Test',
    review_status: 'current',
    next_review: null,
    expiration_date: null,
    ...overrides,
  };
}

describe('docTypeMeta', () => {
  it('returns correct meta for known type', () => {
    const m = docTypeMeta('will');
    expect(m.label).toBe('Will');
    expect(m.emoji).toBe('📜');
  });
  it('falls back to other for unknown', () => {
    const m = docTypeMeta('other');
    expect(m.label).toBe('Other');
  });
});

describe('dayDiff', () => {
  it('computes positive days', () => {
    expect(dayDiff('2026-06-20', '2026-06-24')).toBe(4);
  });
  it('computes negative days', () => {
    expect(dayDiff('2026-06-28', '2026-06-24')).toBe(-4);
  });
  it('handles Date objects', () => {
    expect(dayDiff(new Date('2026-06-20T08:00:00'), new Date('2026-06-24T18:00:00'))).toBe(4);
  });
});

describe('reviewUrgency', () => {
  it('returns none for null', () => {
    expect(reviewUrgency(null, TODAY)).toBe('none');
  });
  it('returns overdue for past date', () => {
    expect(reviewUrgency('2026-06-01', TODAY)).toBe('overdue');
  });
  it('returns due_soon within 30 days', () => {
    expect(reviewUrgency('2026-07-10', TODAY)).toBe('due_soon');
  });
  it('returns upcoming beyond 30 days', () => {
    expect(reviewUrgency('2026-12-01', TODAY)).toBe('upcoming');
  });
});

describe('upcomingReviews', () => {
  it('sorts by soonest first', () => {
    const docs = [
      doc({ id: 'a', next_review: '2026-12-01' }),
      doc({ id: 'b', next_review: '2026-07-01' }),
    ];
    const result = upcomingReviews(docs, TODAY);
    expect(result[0].id).toBe('b');
    expect(result[1].id).toBe('a');
  });
  it('excludes docs without review date', () => {
    const docs = [doc({ id: 'a', next_review: null })];
    expect(upcomingReviews(docs, TODAY)).toHaveLength(0);
  });
});

describe('documentGaps', () => {
  it('returns all essential when empty', () => {
    expect(documentGaps([])).toEqual(['will', 'power_of_attorney', 'advance_directive']);
  });
  it('removes types that exist', () => {
    const docs = [doc({ id: 'a', document_type: 'will' })];
    expect(documentGaps(docs)).toEqual(['power_of_attorney', 'advance_directive']);
  });
  it('returns empty when all covered', () => {
    const docs = [
      doc({ id: 'a', document_type: 'will' }),
      doc({ id: 'b', document_type: 'power_of_attorney' }),
      doc({ id: 'c', document_type: 'advance_directive' }),
    ];
    expect(documentGaps(docs)).toEqual([]);
  });
});

describe('expiredDocuments', () => {
  it('finds expired by status', () => {
    const docs = [doc({ id: 'a', review_status: 'expired' })];
    expect(expiredDocuments(docs, TODAY)).toHaveLength(1);
  });
  it('finds expired by date', () => {
    const docs = [doc({ id: 'a', expiration_date: '2026-01-01' })];
    expect(expiredDocuments(docs, TODAY)).toHaveLength(1);
  });
  it('excludes non-expired', () => {
    const docs = [doc({ id: 'a', expiration_date: '2027-01-01' })];
    expect(expiredDocuments(docs, TODAY)).toHaveLength(0);
  });
});

describe('estateSummary', () => {
  it('handles empty list', () => {
    const s = estateSummary([], TODAY);
    expect(s.count).toBe(0);
    expect(s.text).toBe('No estate documents yet');
  });
  it('reports all current when no issues', () => {
    const docs = [
      doc({ id: 'a', document_type: 'will' }),
      doc({ id: 'b', document_type: 'power_of_attorney' }),
      doc({ id: 'c', document_type: 'advance_directive' }),
    ];
    const s = estateSummary(docs, TODAY);
    expect(s.text).toBe('All documents current');
    expect(s.gaps).toEqual([]);
  });
  it('reports overdue and gaps', () => {
    const docs = [doc({ id: 'a', document_type: 'trust', next_review: '2026-05-01' })];
    const s = estateSummary(docs, TODAY);
    expect(s.overdue).toBe(1);
    expect(s.gaps).toEqual(['will', 'power_of_attorney', 'advance_directive']);
    expect(s.text).toContain('1 overdue');
    expect(s.text).toContain('3 essential gaps');
  });
});

describe('fmtDate', () => {
  it('formats a date string', () => {
    expect(fmtDate('2026-06-24')).toBe('Jun 24, 2026');
  });
  it('returns dash for null', () => {
    expect(fmtDate(null)).toBe('—');
  });
});
