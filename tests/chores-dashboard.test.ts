import { describe, it, expect } from 'vitest';
import {
  pointsByMember,
  topEarners,
  totalFamilyPoints,
  streakDays,
  streaksByMember,
  groupByRecurrence,
  rewardsProgress,
  dueLabel,
  choreEmoji,
  type AssignmentLike,
  type ChoreLike,
  type MemberLike,
} from '@/lib/chores/dashboard';

const members: MemberLike[] = [
  { id: 'm1', display_name: 'Ava', color: '#f00' },
  { id: 'm2', display_name: 'Liam', color: '#0f0' },
  { id: 'm3', display_name: 'Mia', color: '#00f' },
];

function chore(over: Partial<ChoreLike> = {}): ChoreLike {
  return { id: 'c', title: 'Make Bed', description: null, points: 10, recurrence: 'daily', icon: null, category: null, ...over };
}
function asg(over: Partial<AssignmentLike> = {}): AssignmentLike {
  return {
    id: Math.random().toString(36), chore_id: 'c', member_id: 'm1', status: 'todo',
    due_at: null, submitted_at: null, approved_at: null, points_awarded: null, chore: chore(), ...over,
  };
}

describe('pointsByMember / totalFamilyPoints', () => {
  it('sums points_awarded over completed assignments only', () => {
    const rows = [
      asg({ member_id: 'm1', status: 'approved', points_awarded: 10 }),
      asg({ member_id: 'm1', status: 'done', points_awarded: 15 }),
      asg({ member_id: 'm2', status: 'approved', points_awarded: 20 }),
      asg({ member_id: 'm2', status: 'todo', points_awarded: 99 }), // not completed → ignored
    ];
    const totals = pointsByMember(rows);
    expect(totals.get('m1')).toBe(25);
    expect(totals.get('m2')).toBe(20);
    expect(totalFamilyPoints(rows)).toBe(45);
  });

  it('falls back to chore.points when points_awarded is null', () => {
    const rows = [asg({ member_id: 'm3', status: 'approved', points_awarded: null, chore: chore({ points: 30 }) })];
    expect(pointsByMember(rows).get('m3')).toBe(30);
  });
});

describe('topEarners', () => {
  it('ranks by points desc, includes zero-point members, breaks ties by name', () => {
    const rows = [
      asg({ member_id: 'm2', status: 'approved', points_awarded: 50 }),
      asg({ member_id: 'm1', status: 'approved', points_awarded: 50 }),
    ];
    const ranked = topEarners(members, rows);
    expect(ranked.map((r) => r.member.id)).toEqual(['m1', 'm2', 'm3']); // tie m1(Ava) before m2(Liam)
    expect(ranked[0].rank).toBe(1);
    expect(ranked[2].points).toBe(0);
  });
});

describe('streakDays', () => {
  it('counts consecutive days ending today', () => {
    expect(streakDays(['2026-06-30', '2026-06-29', '2026-06-28'], '2026-06-30')).toBe(3);
  });
  it('counts a streak ending yesterday as still live', () => {
    expect(streakDays(['2026-06-29', '2026-06-28'], '2026-06-30')).toBe(2);
  });
  it('returns 0 when the last completion is older than yesterday', () => {
    expect(streakDays(['2026-06-25'], '2026-06-30')).toBe(0);
  });
  it('breaks the streak at the first gap and dedupes same-day entries', () => {
    expect(streakDays(['2026-06-30', '2026-06-30', '2026-06-29', '2026-06-27'], '2026-06-30')).toBe(2);
  });
  it('returns 0 for no data', () => {
    expect(streakDays([], '2026-06-30')).toBe(0);
  });
});

describe('streaksByMember', () => {
  it('computes and ranks live streaks, dropping members with none', () => {
    const rows = [
      asg({ member_id: 'm1', status: 'approved', approved_at: '2026-06-30T10:00:00Z' }),
      asg({ member_id: 'm1', status: 'approved', approved_at: '2026-06-29T10:00:00Z' }),
      asg({ member_id: 'm2', status: 'approved', approved_at: '2026-06-30T10:00:00Z' }),
      asg({ member_id: 'm3', status: 'approved', approved_at: '2026-06-01T10:00:00Z' }), // lapsed
    ];
    const streaks = streaksByMember(members, rows, '2026-06-30');
    expect(streaks.map((s) => [s.member.id, s.days])).toEqual([['m1', 2], ['m2', 1]]);
  });
});

describe('groupByRecurrence', () => {
  it('splits active assignments by cadence and excludes completed', () => {
    const rows = [
      asg({ chore: chore({ recurrence: 'daily' }) }),
      asg({ chore: chore({ recurrence: 'weekly' }) }),
      asg({ chore: chore({ recurrence: 'monthly' }) }),
      asg({ status: 'approved', chore: chore({ recurrence: 'daily' }) }),
    ];
    const g = groupByRecurrence(rows);
    expect(g.daily).toHaveLength(1);
    expect(g.weekly).toHaveLength(1);
    expect(g.other).toHaveLength(1);
  });
});

describe('rewardsProgress', () => {
  const rewards = [
    { title: 'Ice Cream', cost_points: 50, redeemed_at: null },
    { title: 'Movie Night', cost_points: 200, redeemed_at: null },
    { title: 'Redeemed', cost_points: 10, redeemed_at: '2026-01-01' },
  ];
  it('targets the cheapest reward the leader cannot yet afford', () => {
    const rows = [asg({ member_id: 'm1', status: 'approved', points_awarded: 120 })];
    const p = rewardsProgress(members, rows, rewards);
    expect(p?.rewardTitle).toBe('Movie Night');
    expect(p?.remaining).toBe(80);
    expect(p?.pct).toBe(60);
  });
  it('returns null when there are no available rewards', () => {
    expect(rewardsProgress(members, [], [{ title: 'x', cost_points: 5, redeemed_at: '2026-01-01' }])).toBeNull();
  });
});

describe('dueLabel', () => {
  const now = new Date('2026-06-30T12:00:00');
  it('labels today, tomorrow, overdue and none', () => {
    expect(dueLabel('2026-06-30T09:00:00', now).tone).toBe('today');
    expect(dueLabel('2026-07-01T09:00:00', now).tone).toBe('soon');
    expect(dueLabel('2026-06-28T09:00:00', now).tone).toBe('overdue');
    expect(dueLabel(null, now).tone).toBe('none');
  });
});

describe('choreEmoji', () => {
  it('uses an explicit emoji icon verbatim', () => {
    expect(choreEmoji(chore({ icon: '🚀' }))).toBe('🚀');
  });
  it('derives an emoji from title keywords', () => {
    expect(choreEmoji(chore({ title: 'Clean Dishes', icon: null }))).toBe('🍽️');
    expect(choreEmoji(chore({ title: 'Take Out Trash', icon: null }))).toBe('🗑️');
  });
  it('falls back to a broom when nothing matches', () => {
    expect(choreEmoji(chore({ title: 'Xyzzy', icon: 'not-an-emoji', description: null, category: null }))).toBe('🧹');
  });
});
