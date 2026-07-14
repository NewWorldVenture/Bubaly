import { describe, it, expect } from 'vitest';
import {
  statusMeta, isFeedbackStatus, categoryMeta, impactMeta, LEGEND_STATUSES,
  normalizeIdea, sortIdeas, toggleVote, trendingScore, ageInDays, statusTally,
  TITLE_MAX, type IdeaRow,
} from '@/lib/feedback/board';

function idea(over: Partial<IdeaRow>): IdeaRow {
  return {
    id: over.id ?? 'x', title: over.title ?? 'Idea', problem: null, body: null,
    category: over.category ?? 'other', impact: over.impact ?? 'helpful', audience: 'me',
    status: over.status ?? 'under_review', admin_note: null, image_url: null,
    author_name: 'Test', vote_count: over.vote_count ?? 0, comment_count: over.comment_count ?? 0,
    pinned: over.pinned ?? false, created_at: over.created_at ?? '2026-01-01T00:00:00Z',
  };
}

describe('status metadata', () => {
  it('maps every legend status to a distinct tone', () => {
    const tones = LEGEND_STATUSES.map((s) => statusMeta(s).tone);
    expect(new Set(tones).size).toBe(LEGEND_STATUSES.length);
  });
  it('falls back to under_review for junk', () => {
    expect(statusMeta('bogus').label).toBe('Under review');
    expect(isFeedbackStatus('shipped')).toBe(true);
    expect(isFeedbackStatus('nope')).toBe(false);
  });
});

describe('category/impact lookups', () => {
  it('resolves known + unknown categories', () => {
    expect(categoryMeta('meals').label).toBe('Meals');
    expect(categoryMeta('zzz').label).toBe(categoryMeta('other').label);
  });
  it('orders impact by weight', () => {
    expect(impactMeta('game_changer').weight).toBeGreaterThan(impactMeta('nice_to_have').weight);
    expect(impactMeta('junk').label).toBe('Helpful');
  });
});

describe('normalizeIdea', () => {
  it('requires a title', () => {
    expect(normalizeIdea({ title: '   ' })).toEqual({ ok: false, error: expect.any(String) });
  });
  it('rejects an over-long title', () => {
    const r = normalizeIdea({ title: 'a'.repeat(TITLE_MAX + 1) });
    expect(r.ok).toBe(false);
  });
  it('trims, defaults optionals, and blanks → null', () => {
    const r = normalizeIdea({ title: '  Dark mode  ', problem: '', body: '  ', category: 'mobile', impact: 'game_changer', audience: 'everyone' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe('Dark mode');
      expect(r.value.problem).toBeNull();
      expect(r.value.body).toBeNull();
      expect(r.value.category).toBe('mobile');
      expect(r.value.impact).toBe('game_changer');
      expect(r.value.audience).toBe('everyone');
    }
  });
  it('coerces invalid enums to defaults', () => {
    const r = normalizeIdea({ title: 'x', category: 'nope', impact: 'nope', audience: 'nope' });
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.value.category, r.value.impact, r.value.audience]).toEqual(['other', 'helpful', 'me']);
  });
});

describe('sortIdeas', () => {
  const now = new Date('2026-07-14T00:00:00Z').getTime();
  const a = idea({ id: 'a', vote_count: 10, created_at: '2026-07-13T00:00:00Z' });
  const b = idea({ id: 'b', vote_count: 50, created_at: '2026-01-01T00:00:00Z' });
  const c = idea({ id: 'c', vote_count: 2, created_at: '2026-07-14T00:00:00Z' });

  it('top → by votes desc', () => {
    expect(sortIdeas([a, b, c], 'top', now).map((i) => i.id)).toEqual(['b', 'a', 'c']);
  });
  it('new → by recency desc', () => {
    expect(sortIdeas([a, b, c], 'new', now).map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });
  it('trending → recent-with-votes beats old-with-more-votes', () => {
    const order = sortIdeas([a, b, c], 'trending', now).map((i) => i.id);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
  });
  it('pinned always floats to the top regardless of sort', () => {
    const pinned = idea({ id: 'p', vote_count: 0, pinned: true, created_at: '2020-01-01T00:00:00Z' });
    expect(sortIdeas([a, b, pinned], 'top', now)[0].id).toBe('p');
  });
  it('does not mutate the input array', () => {
    const input = [a, b, c];
    sortIdeas(input, 'top', now);
    expect(input.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('toggleVote', () => {
  it('adds when absent, removes when present', () => {
    const on = toggleVote(['x'], 'y');
    expect(on).toEqual({ next: ['x', 'y'], voted: true });
    const off = toggleVote(['x', 'y'], 'y');
    expect(off.voted).toBe(false);
    expect(off.next).toEqual(['x']);
  });
});

describe('trendingScore / ageInDays', () => {
  it('newer with equal votes scores higher', () => {
    const now = Date.now();
    const fresh = trendingScore({ vote_count: 5, created_at: new Date(now - 3_600_000).toISOString() }, now);
    const stale = trendingScore({ vote_count: 5, created_at: new Date(now - 240 * 3_600_000).toISOString() }, now);
    expect(fresh).toBeGreaterThan(stale);
  });
  it('ageInDays never negative and handles junk', () => {
    expect(ageInDays('not-a-date')).toBe(0);
    expect(ageInDays(new Date(Date.now() + 1000).toISOString())).toBe(0);
  });
});

describe('statusTally', () => {
  it('counts by status', () => {
    const t = statusTally([idea({ status: 'shipped' }), idea({ status: 'shipped' }), idea({ status: 'planned' })]);
    expect(t.shipped).toBe(2);
    expect(t.planned).toBe(1);
    expect(t.under_review).toBe(0);
  });
});
