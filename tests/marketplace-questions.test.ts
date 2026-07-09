import { describe, it, expect } from 'vitest';
import { categorizeQuestions, unansweredCount, isAnswered, type QuestionLike } from '@/lib/marketplace/questions';

const Q = (over: Partial<QuestionLike> = {}): QuestionLike => ({
  id: 'q', listing_id: 'L1', asker_member: 'other', answer: null, created_at: '2026-07-01T00:00:00Z', ...over,
});

describe('isAnswered', () => {
  it('treats blank/whitespace answers as unanswered', () => {
    expect(isAnswered({ answer: null })).toBe(false);
    expect(isAnswered({ answer: '   ' })).toBe(false);
    expect(isAnswered({ answer: 'Yes!' })).toBe(true);
  });
});

describe('categorizeQuestions', () => {
  const questions = [
    Q({ id: 'a', listing_id: 'mine1', answer: null, created_at: '2026-07-05T00:00:00Z' }),   // on my listing, unanswered
    Q({ id: 'b', listing_id: 'mine1', answer: 'Sure', created_at: '2026-07-04T00:00:00Z' }),  // on my listing, answered
    Q({ id: 'c', listing_id: 'mine2', answer: null, created_at: '2026-07-06T00:00:00Z' }),    // on my listing, unanswered (newer)
    Q({ id: 'd', listing_id: 'other1', asker_member: 'me', answer: 'It is', created_at: '2026-07-03T00:00:00Z' }), // I asked
    Q({ id: 'e', listing_id: 'other2', asker_member: 'someone', answer: null }),              // not mine, not asked by me
  ];

  it('splits into toAnswer / answered / mine, newest first', () => {
    const r = categorizeQuestions(questions, 'me', ['mine1', 'mine2']);
    expect(r.toAnswer.map((q) => q.id)).toEqual(['c', 'a']); // both unanswered on my listings, newest first
    expect(r.answered.map((q) => q.id)).toEqual(['b']);
    expect(r.mine.map((q) => q.id)).toEqual(['d']);          // only the one I asked
  });

  it('accepts a Set for owned ids and excludes questions I asked on my own listing from "mine"', () => {
    const qs = [Q({ id: 'x', listing_id: 'mine1', asker_member: 'me', answer: null })];
    const r = categorizeQuestions(qs, 'me', new Set(['mine1']));
    expect(r.toAnswer.map((q) => q.id)).toEqual(['x']); // it's on my listing → I answer it
    expect(r.mine).toEqual([]);                          // not counted as "asked elsewhere"
  });

  it('with no member id, "mine" is empty', () => {
    const r = categorizeQuestions(questions, null, []);
    expect(r.mine).toEqual([]);
  });
});

describe('unansweredCount', () => {
  it('counts only unanswered questions on my listings', () => {
    const questions = [
      Q({ listing_id: 'mine', answer: null }),
      Q({ listing_id: 'mine', answer: 'done' }),
      Q({ listing_id: 'other', answer: null }),
    ];
    expect(unansweredCount(questions, ['mine'])).toBe(1);
    expect(unansweredCount(questions, new Set(['mine', 'other']))).toBe(2);
  });
});
