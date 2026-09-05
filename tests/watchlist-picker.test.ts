import { describe, expect, it } from 'vitest';
import {
  AGE_RATINGS, TIME_PRESETS, WATCH_KINDS, WATCH_SERVICES, WATCH_STATUSES, ageOn, kindMeta, pickTonight, ratingMinAge,
  serviceLabel, voteScore, watchlistSummary, type TitleLike, type VoteLike,
} from '@/lib/watchlist/picker';

const TODAY = new Date('2026-09-05T20:00:00');
let n = 0;
function title(p: Partial<TitleLike> & { title: string }): TitleLike {
  n += 1;
  return { id: `t${n}`, kind: 'movie', min_age: 0, runtime_min: 90, service: 'netflix', status: 'want', priority: 2, genres: [], ...p };
}

describe('catalogs', () => {
  it('cover the enums and map ratings to ages', () => {
    expect(WATCH_KINDS).toHaveLength(5);
    expect(WATCH_SERVICES).toHaveLength(12);
    expect(WATCH_STATUSES.map((s) => s.value)).toEqual(['want', 'watching', 'watched', 'skipped']);
    expect(AGE_RATINGS.find((r) => r.value === 'PG-13')?.minAge).toBe(13);
    expect(ratingMinAge('R')).toBe(17);
    expect(ratingMinAge(null)).toBe(0);
    expect(kindMeta('kids').emoji).toBe('🧸');
    expect(serviceLabel('disney')).toBe('Disney+');
    expect(TIME_PRESETS).toContain(90);
  });
});

describe('ageOn', () => {
  it('computes whole years and tolerates unknown birthdays', () => {
    expect(ageOn('2016-09-06', TODAY)).toBe(9);
    expect(ageOn('2016-09-05', TODAY)).toBe(10);
    expect(ageOn(null, TODAY)).toBeNull();
    expect(ageOn('nope', TODAY)).toBeNull();
  });
});

describe('pickTonight', () => {
  const titles = [
    title({ id: 'a', title: 'Family adventure', min_age: 8, runtime_min: 100, priority: 1 }),
    title({ id: 'b', title: 'Teen thriller', min_age: 13, runtime_min: 110 }),
    title({ id: 'c', title: 'Long epic', min_age: 8, runtime_min: 180 }),
    title({ id: 'd', title: 'Cartoon short', min_age: 0, runtime_min: 25, kind: 'kids', service: 'disney', status: 'watching' }),
    title({ id: 'e', title: 'Already seen', status: 'watched' }),
  ];
  const votes: VoteLike[] = [
    { title_id: 'a', member_id: 'mom', vote: 'love' },
    { title_id: 'a', member_id: 'kid', vote: 'up' },
    { title_id: 'b', member_id: 'kid', vote: 'love' },
    { title_id: 'c', member_id: 'mom', vote: 'down' },
    { title_id: 'd', member_id: 'guest', vote: 'love' },
  ];

  it('ranks by audience votes + priority, excluding titles the youngest cannot watch or that do not fit the time', () => {
    const { picks, excluded } = pickTonight(titles, votes, { audienceIds: ['mom', 'kid'], audienceAges: [41, 9], availableMinutes: 120 });
    expect(picks.map((p) => p.title.id)).toEqual(['a', 'd']);
    expect(picks[0].reasons).toEqual(expect.arrayContaining(['1 loves it', 'nobody voted it down', 'top priority', '100 min fits', 'fine for everyone']));
    expect(excluded.map((p) => p.title.id).sort()).toEqual(['b', 'c']);
    expect(excluded.find((p) => p.title.id === 'b')?.blockers).toEqual(['rated 13+, youngest tonight is 9']);
    expect(excluded.find((p) => p.title.id === 'c')?.blockers).toEqual(['180 min, you have 120']);
    expect(picks.some((p) => p.title.id === 'e')).toBe(false);
  });

  it('only counts votes from tonight’s audience and applies service/kind filters', () => {
    expect(voteScore('d', votes, ['mom', 'kid'])).toBe(0);
    expect(voteScore('d', votes)).toBe(3);
    const { picks, excluded } = pickTonight(titles, votes, { audienceIds: ['kid'], audienceAges: [14], availableMinutes: 200, service: 'disney' });
    expect(picks.map((p) => p.title.id)).toEqual(['d']);
    expect(excluded.find((p) => p.title.id === 'a')?.blockers).toEqual(['on Netflix']);
    const kids = pickTonight(titles, votes, { audienceIds: [], audienceAges: [], availableMinutes: 200, kind: 'kids' });
    expect(kids.picks.map((p) => p.title.id)).toEqual(['d']);
  });

  it('ignores the age filter when no ages are known', () => {
    // Only mom is on the couch: the kid's love for 'b' does not count, so the
    // in-progress cartoon outranks it, and mom's down-vote sinks the epic.
    const { picks } = pickTonight(titles, votes, { audienceIds: ['mom'], audienceAges: [], availableMinutes: 200 });
    expect(picks.map((p) => p.title.id)).toEqual(['a', 'd', 'b', 'c']);
    expect(picks[3].reasons).toContain('1 would rather not');
  });
});

describe('watchlistSummary', () => {
  it('counts the queue, this month’s sessions, average rating and the busiest service', () => {
    const titles = [title({ title: 'x' }), title({ title: 'y', service: 'disney' }), title({ title: 'z', service: 'disney', status: 'watching' })];
    const sessions = [
      { title_id: 't1', title_name: 'x', watched_on: '2026-09-01', rating: 4, member_ids: [] },
      { title_id: null, title_name: 'old', watched_on: '2026-07-01', rating: 5, member_ids: [] },
      { title_id: null, title_name: 'unrated', watched_on: '2026-09-03', rating: null, member_ids: [] },
    ];
    const s = watchlistSummary(titles, sessions, TODAY);
    expect(s).toMatchObject({ want: 2, watching: 1, watchedThisMonth: 2, avgRating: 4.5, topService: 'Netflix' });
    expect(s.text).toBe('2 to watch · 1 in progress');
    expect(watchlistSummary([], [], TODAY).text).toMatch(/add a few titles/);
  });
});
