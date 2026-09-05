import { describe, expect, it } from 'vitest';
import {
  MISSION_STATUSES, SCORE_LABELS, ZONE_KINDS, declutterSummary, missionPoints, missionsForZone, sessionStreak, weeklyPlan, zoneHealth, zoneKindMeta,
  type MissionLike, type SessionLike, type ZoneLike,
} from '@/lib/declutter/missions';

const TODAY = new Date('2026-09-05T10:00:00');
let n = 0;
function zone(p: Partial<ZoneLike> & { name: string }): ZoneLike {
  n += 1;
  return { id: `z${n}`, room: 'Kitchen', kind: 'surface', clutter_score: 3, last_reset_at: null, is_active: true, ...p };
}
function mission(p: Partial<MissionLike> & { id: string }): MissionLike {
  return { zone_id: null, title: 't', minutes: 15, assignee_id: null, status: 'planned', scheduled_for: null, completed_at: null, items_removed: 0, points: 5, ...p };
}

describe('catalogs', () => {
  it('has templates for every zone kind', () => {
    expect(ZONE_KINDS).toHaveLength(12);
    for (const k of ZONE_KINDS) expect(k.templates.length).toBeGreaterThan(0);
    expect(MISSION_STATUSES.map((s) => s.value)).toEqual(['planned', 'done', 'skipped']);
    expect(SCORE_LABELS[5]).toBe('Avalanche');
    expect(zoneKindMeta('nope' as never).value).toBe('other');
  });
});

describe('missionsForZone + zoneHealth', () => {
  it('scales missions with the clutter score and skips tidy or inactive zones', () => {
    expect(missionsForZone(zone({ name: 'tidy', clutter_score: 1 }))).toEqual([]);
    expect(missionsForZone(zone({ name: 'off', clutter_score: 5, is_active: false }))).toEqual([]);
    expect(missionsForZone(zone({ name: 'counter', clutter_score: 2 })).length).toBe(1);
    expect(missionsForZone(zone({ name: 'counter', clutter_score: 5 })).length).toBe(3);
    expect(missionsForZone(zone({ name: 'garage', kind: 'garage', clutter_score: 5 })).length).toBe(2);
  });
  it('decays faster for worse zones', () => {
    expect(zoneHealth(zone({ name: 'a' }), TODAY)).toEqual({ health: 'never', daysSinceReset: null, intervalDays: 14 });
    expect(zoneHealth(zone({ name: 'b', clutter_score: 4, last_reset_at: '2026-09-01T00:00:00Z' }), TODAY).health).toBe('fresh');
    expect(zoneHealth(zone({ name: 'c', clutter_score: 4, last_reset_at: '2026-08-27T00:00:00Z' }), TODAY).health).toBe('due');
    expect(zoneHealth(zone({ name: 'd', clutter_score: 4, last_reset_at: '2026-08-20T00:00:00Z' }), TODAY).health).toBe('overdue');
    expect(zoneHealth(zone({ name: 'e', clutter_score: 2, last_reset_at: '2026-08-20T00:00:00Z' }), TODAY).health).toBe('fresh');
  });
});

describe('weeklyPlan', () => {
  it('schedules worst zones first, two a day, round-robin across members, skipping zones already planned', () => {
    const zones = [
      zone({ name: 'Garage floor', kind: 'garage', clutter_score: 5 }),
      zone({ name: 'Counter', clutter_score: 4 }),
      zone({ name: 'Desk', kind: 'desk', clutter_score: 3 }),
      zone({ name: 'Tidy shelf', kind: 'shelf', clutter_score: 1 }),
      zone({ name: 'Already planned', clutter_score: 4 }),
    ];
    const existing = [mission({ id: 'm1', zone_id: zones[4].id, scheduled_for: '2026-09-06' })];
    const plan = weeklyPlan(zones, existing, ['mom', 'kid'], TODAY);
    expect(plan.map((p) => [p.day, p.zone.name, p.assigneeId])).toEqual([
      ['2026-09-05', 'Garage floor', 'mom'],
      ['2026-09-05', 'Counter', 'kid'],
      ['2026-09-06', 'Desk', 'mom'],
    ]);
    expect(plan[0].template.title).toContain('One bin');
    expect(plan[0].dayLabel).toBe('Sat');
  });
  it('caps at 7 days × perDay and copes with no members', () => {
    const zones = Array.from({ length: 20 }, (_, i) => zone({ name: `z${i}`, clutter_score: 3 }));
    const plan = weeklyPlan(zones, [], [], TODAY, 2);
    expect(plan).toHaveLength(14);
    expect(plan.every((p) => p.assigneeId === null)).toBe(true);
    expect(plan[13].day).toBe('2026-09-11');
  });
});

describe('streaks, summary, points', () => {
  const sessions: SessionLike[] = [
    { started_at: '2026-09-05T08:00:00', minutes: 15, items_removed: 4, member_id: null },
    { started_at: '2026-09-04T08:00:00', minutes: 10, items_removed: 2, member_id: null },
    { started_at: '2026-09-03T08:00:00', minutes: 20, items_removed: 6, member_id: null },
    { started_at: '2026-08-30T08:00:00', minutes: 20, items_removed: 1, member_id: null },
    { started_at: '2026-07-01T08:00:00', minutes: 60, items_removed: 30, member_id: null },
  ];
  it('counts consecutive days, allowing today to be pending', () => {
    expect(sessionStreak(sessions, TODAY)).toBe(3);
    expect(sessionStreak(sessions.slice(1), TODAY)).toBe(2);
    expect(sessionStreak([], TODAY)).toBe(0);
  });
  it('summarises zones, due counts, week/month totals', () => {
    const zones = [zone({ name: 'a', clutter_score: 4, last_reset_at: '2026-08-20T00:00:00Z' }), zone({ name: 'b', clutter_score: 2, last_reset_at: '2026-09-01T00:00:00Z' }), zone({ name: 'off', is_active: false })];
    const missions = [mission({ id: 'd1', status: 'done', completed_at: '2026-09-04T10:00:00Z', items_removed: 5 }), mission({ id: 'd2', status: 'done', completed_at: '2026-08-01T10:00:00Z', items_removed: 9 }), mission({ id: 'p1' })];
    const s = declutterSummary(zones, missions, sessions, TODAY);
    expect(s).toMatchObject({ zones: 2, avgScore: 3, dueZones: 1, doneThisWeek: 1, itemsRemovedMonth: 18, minutesMonth: 65, streak: 3 });
    expect(s.worst?.name).toBe('a');
    expect(s.text).toBe('1 zone due · avg clutter 3/5');
    expect(declutterSummary([], [], [], TODAY).text).toBe('No zones yet');
    expect(declutterSummary([zone({ name: 'x', clutter_score: 1 })], [], [], TODAY).text).toBe('Home is in great shape');
  });
  it('awards a bonus for items removed', () => {
    expect(missionPoints({ points: 5, items_removed: 0 })).toBe(5);
    expect(missionPoints({ points: 5, items_removed: 12 })).toBe(7);
    expect(missionPoints({ points: 8, items_removed: 500 })).toBe(18);
  });
});
