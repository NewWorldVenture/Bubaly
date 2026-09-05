import { describe, expect, it } from 'vitest';
import {
  STARTER_DECKS, starterDeck, sm2, dueCards, deckStats, weekProgress, streak, levelEstimate, suggestToday, languageSummary,
  type GoalLike, type SessionLike, type CardLike,
} from '@/lib/language/practice';

const TODAY = new Date('2026-09-05T12:00:00');
const goal = (p: Partial<GoalLike> & { id: string }): GoalLike => ({ member_id: 'm1', language_code: 'es', current_level: 'A1', target_level: 'B1', weekly_minutes: 90, is_active: true, started_on: '2026-06-01', ...p });
const session = (p: Partial<SessionLike> & { id: string }): SessionLike => ({ goal_id: 'g1', kind: 'vocab', minutes: 15, score: null, practiced_on: '2026-09-05', ...p });
const card = (p: Partial<CardLike> & { id: string }): CardLike => ({ goal_id: 'g1', term: p.id, ease: 2.5, interval_days: 0, repetitions: 0, lapses: 0, due_on: '2026-09-05', is_suspended: false, ...p });

describe('starter decks', () => {
  it('ship 20 unique terms per language', () => {
    for (const [code, deck] of Object.entries(STARTER_DECKS)) {
      expect(deck, code).toHaveLength(20);
      expect(new Set(deck.map((c) => c.term)).size, code).toBe(20);
    }
    expect(starterDeck('xx')).toEqual([]);
  });
});

describe('sm2', () => {
  it('grows intervals on good answers and resets on a lapse', () => {
    const first = sm2({ ease: 2.5, interval_days: 0, repetitions: 0, lapses: 0 }, 4, TODAY);
    expect(first).toMatchObject({ interval_days: 1, repetitions: 1, ease: 2.5, due_on: '2026-09-06', last_reviewed_on: '2026-09-05' });
    const second = sm2({ ...first }, 4, TODAY);
    expect(second.interval_days).toBe(6);
    const third = sm2({ ...second }, 4, TODAY);
    expect(third.interval_days).toBe(15); // 6 × 2.5
    const easy = sm2({ ...second }, 5, TODAY);
    expect(easy.interval_days).toBe(21); // 6 × 2.6 → 16 × 1.3
    expect(easy.ease).toBe(2.6);
    const lapse = sm2({ ...third }, 1, TODAY);
    expect(lapse).toMatchObject({ interval_days: 1, repetitions: 0, lapses: 1 });
    expect(lapse.ease).toBe(1.96);
    expect(sm2({ ease: 1.3, interval_days: 1, repetitions: 0, lapses: 5 }, 0, TODAY).ease).toBe(1.3); // floor
  });
});

describe('deck', () => {
  it('orders due reviews before new cards and reports stats', () => {
    const cards = [
      card({ id: 'new', due_on: '2026-09-01' }),
      card({ id: 'old', repetitions: 3, interval_days: 30, due_on: '2026-09-03' }),
      card({ id: 'learning', repetitions: 1, interval_days: 6, due_on: '2026-09-04', lapses: 1 }),
      card({ id: 'future', repetitions: 2, interval_days: 6, due_on: '2026-09-09' }),
      card({ id: 'off', is_suspended: true }),
      card({ id: 'other', goal_id: 'g2' }),
    ];
    expect(dueCards(cards, 'g1', TODAY).map((c) => c.id)).toEqual(['old', 'learning', 'new']);
    // reviews: old 3 + learning 1 + lapse 1 + future 2 = 7, one lapse → 86 %
    expect(deckStats(cards, 'g1', TODAY)).toEqual({ total: 5, due: 3, new: 1, learning: 2, mature: 1, suspended: 1, retention: 86 });
  });
});

describe('progress', () => {
  it('sums the last seven days against the goal, counts the streak and estimates hours', () => {
    const sessions = [
      session({ id: 'a', practiced_on: '2026-09-05', minutes: 20, score: 80 }),
      session({ id: 'b', practiced_on: '2026-09-04', minutes: 30, kind: 'conversation', score: 60 }),
      session({ id: 'c', practiced_on: '2026-09-03', minutes: 10 }),
      session({ id: 'd', practiced_on: '2026-08-29', minutes: 60 }), // 7 days ago: outside the window
      session({ id: 'e', practiced_on: '2026-08-01', minutes: 600 }),
    ];
    const w = weekProgress(sessions, goal({ id: 'g1' }), TODAY);
    expect(w).toMatchObject({ minutes: 60, goal: 90, pct: 67, days: 3, sessions: 3, avgScore: 70 });
    expect(w.byKind).toEqual({ vocab: 30, conversation: 30 });
    expect(streak(sessions, 'g1', TODAY)).toBe(3);
    expect(streak([session({ id: 'y', practiced_on: '2026-09-04' })], 'g1', TODAY)).toBe(1);
    expect(streak([session({ id: 'z', practiced_on: '2026-09-02' })], 'g1', TODAY)).toBe(0);
    const est = levelEstimate(goal({ id: 'g1' }), sessions); // 720 min = 12 h of 300
    expect(est).toEqual({ hoursDone: 12, hoursToTarget: 288, pct: 4, weeksAtGoal: 192, targetLabel: 'B1 · Intermediate' });
  });
});

describe('suggestToday + summary', () => {
  it('prioritises a heavy review queue, then speaking, then the weakest skill', () => {
    const g = goal({ id: 'g1' });
    const dueMany = Array.from({ length: 12 }, (_, i) => card({ id: `c${i}` }));
    expect(suggestToday(g, [], dueMany, TODAY).title).toBe('Review 12 due cards');
    expect(suggestToday(g, [], [], TODAY).kind).toBe('tutor');
    const spoke = [session({ id: 's', kind: 'tutor', practiced_on: '2026-09-03', minutes: 10 })];
    expect(suggestToday(g, spoke, [card({ id: 'c1' })], TODAY).title).toBe('Clear 1 due card');
    const s = suggestToday(g, [...spoke, session({ id: 'v', kind: 'listening', practiced_on: '2026-09-04', minutes: 20 })], [], TODAY);
    expect(s.kind).toBe('reading');
    expect(s.minutes).toBe(20);
    const done = suggestToday(g, [...spoke, session({ id: 'big', minutes: 90, practiced_on: '2026-09-05' })], [], TODAY);
    expect(done.kind).toBe('immersion');
    const sum = languageSummary([g, goal({ id: 'g2', is_active: false })], [session({ id: 'x', minutes: 90 })], [], TODAY);
    expect(sum).toEqual({ goals: 1, minutesWeek: 90, dueCards: 0, longestStreak: 1, onTrack: 1, text: 'Everyone hit this week’s goal' });
  });
});
