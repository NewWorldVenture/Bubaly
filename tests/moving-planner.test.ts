import { describe, expect, it } from 'vitest';
import {
  MOVE_TEMPLATE, applicableTemplate, planTasks, timeline, phaseFor, suggestedStatus, budgetHealth, moveSummary, nextBoxNumber, boxesByRoom, findInBoxes, addDays,
  type MoveLike, type TaskLike, type BoxLike,
} from '@/lib/moving/planner';

const TODAY = new Date('2026-09-05T12:00:00');
const move: MoveLike = { id: 'mv', move_date: '2026-10-03', status: 'planning', move_kind: 'local', has_kids: true, has_pets: false, is_renting_out: false, budget_cents: 500000, spent_cents: 120000, mover_quote_cents: 250000 };
const task = (p: Partial<TaskLike> & { id: string }): TaskLike => ({ move_id: 'mv', title: 'Task', category: 'admin', offset_days: -7, due_date: addDays(move.move_date, -7), status: 'todo', template_key: null, assignee_id: null, ...p });
const box = (p: Partial<BoxLike> & { id: string; box_number: number }): BoxLike => ({ move_id: 'mv', label: `Box ${p.box_number}`, to_room: 'Kitchen', status: 'packed', is_fragile: false, is_essential: false, contents: [], ...p });

describe('template', () => {
  it('has stable, unique keys sorted from T-8w to T+2w', () => {
    const keys = MOVE_TEMPLATE.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(MOVE_TEMPLATE[0].offsetDays).toBe(-56);
    expect(MOVE_TEMPLATE[MOVE_TEMPLATE.length - 1].offsetDays).toBe(14);
    for (let i = 1; i < MOVE_TEMPLATE.length; i++) expect(MOVE_TEMPLATE[i].offsetDays).toBeGreaterThanOrEqual(MOVE_TEMPLATE[i - 1].offsetDays);
  });
  it('filters by kids, pets, renting and move kind', () => {
    const base = applicableTemplate({ move_kind: 'local', has_kids: false, has_pets: false, is_renting_out: false });
    expect(base.some((t) => t.key === 'school-enrol')).toBe(false);
    expect(base.some((t) => t.key === 'vet')).toBe(false);
    expect(base.some((t) => t.key === 'visa')).toBe(false);
    expect(base.some((t) => t.key === 'quotes')).toBe(true);
    const full = applicableTemplate({ move_kind: 'international', has_kids: true, has_pets: true, is_renting_out: true });
    for (const k of ['school-enrol', 'vet', 'visa', 'tenant-ads', 'pet-tag']) expect(full.some((t) => t.key === k), k).toBe(true);
    const nextDoor = applicableTemplate({ move_kind: 'within_building', has_kids: false, has_pets: false, is_renting_out: false });
    expect(nextDoor.some((t) => t.key === 'book-movers')).toBe(false);
  });
});

describe('planTasks', () => {
  it('dates every task from move day and skips what is already generated', () => {
    const plan = planTasks(move, [task({ id: 'x', template_key: 'mail' })]);
    expect(plan.some((p) => p.key === 'mail')).toBe(false);
    const essentials = plan.find((p) => p.key === 'essentials-box');
    expect(essentials?.dueDate).toBe('2026-09-30');
    expect(plan.find((p) => p.key === 'unpack-all')?.dueDate).toBe('2026-10-17');
  });
  it('is empty once the whole template exists', () => {
    const all = applicableTemplate(move).map((t, i) => task({ id: String(i), template_key: t.key }));
    expect(planTasks(move, all)).toEqual([]);
  });
});

describe('timeline', () => {
  it('groups by phase in order and drops empty phases', () => {
    const tl = timeline([
      task({ id: 'a', offset_days: -56 }), task({ id: 'b', offset_days: 0 }), task({ id: 'c', offset_days: -3, title: 'Z' }), task({ id: 'd', offset_days: -3, title: 'A' }),
      task({ id: 'other', move_id: 'nope', offset_days: -20 }),
    ], 'mv');
    expect(tl.map((g) => g.phase.key)).toEqual(['w8', 'w1', 'day']);
    expect(tl[1].tasks.map((t) => t.title)).toEqual(['A', 'Z']);
    expect(phaseFor(30).key).toBe('after');
    expect(phaseFor(-10).key).toBe('w2');
  });
});

describe('suggestedStatus', () => {
  it('follows the calendar but never reopens a finished move', () => {
    expect(suggestedStatus({ move_date: '2026-10-03', status: 'planning' }, TODAY)).toBe('planning');
    expect(suggestedStatus({ move_date: '2026-09-12', status: 'planning' }, TODAY)).toBe('packing');
    expect(suggestedStatus({ move_date: '2026-09-05', status: 'packing' }, TODAY)).toBe('moving_day');
    expect(suggestedStatus({ move_date: '2026-08-30', status: 'packing' }, TODAY)).toBe('settling');
    expect(suggestedStatus({ move_date: '2026-06-01', status: 'settling' }, TODAY)).toBe('done');
    expect(suggestedStatus({ move_date: '2026-10-03', status: 'cancelled' }, TODAY)).toBe('cancelled');
  });
});

describe('budgetHealth', () => {
  it('counts spend plus the mover quote against the budget', () => {
    expect(budgetHealth(move)).toEqual({ status: 'under', committedCents: 370000, remainingCents: 130000, pct: 74 });
    expect(budgetHealth({ ...move, spent_cents: 200000 }).status).toBe('near');
    expect(budgetHealth({ ...move, spent_cents: 300000 }).status).toBe('over');
    expect(budgetHealth({ ...move, budget_cents: null }).status).toBe('no_budget');
  });
});

describe('moveSummary', () => {
  it('reports progress, overdue work and box counts', () => {
    const tasks = [
      task({ id: 'a', status: 'done' }), task({ id: 'b', due_date: '2026-09-01' }), task({ id: 'c', due_date: '2026-09-08' }), task({ id: 'd', status: 'skipped' }),
    ];
    const boxes = [box({ id: '1', box_number: 1, is_fragile: true }), box({ id: '2', box_number: 2, status: 'empty' }), box({ id: '3', box_number: 3, status: 'unpacked', is_essential: true })];
    const s = moveSummary(move, tasks, boxes, TODAY);
    expect(s.daysToMove).toBe(28);
    expect(s.total).toBe(3); // skipped excluded
    expect(s.done).toBe(1);
    expect(s.overdue).toBe(1);
    expect(s.dueThisWeek).toBe(1);
    expect(s.pct).toBe(33);
    expect(s.boxes).toEqual({ total: 3, packed: 2, unpacked: 1, fragile: 1, essentials: 1 });
    expect(s.onTrack).toBe(false);
    expect(s.text).toBe('28 days to go · 1 overdue');
  });
  it('speaks moving day and settling in', () => {
    expect(moveSummary({ ...move, move_date: '2026-09-05' }, [], [], TODAY).text).toBe('Moving day!');
    expect(moveSummary({ ...move, move_date: '2026-09-01' }, [], [box({ id: '1', box_number: 1, status: 'unpacked' })], TODAY).text).toBe('4 days in · 1/1 boxes unpacked');
  });
});

describe('boxes', () => {
  it('numbers, groups by room and searches contents', () => {
    const boxes = [
      box({ id: '1', box_number: 1, to_room: 'Kitchen', contents: ['Kettle', 'Mugs'], status: 'unpacked' }),
      box({ id: '2', box_number: 2, to_room: 'Kitchen', contents: ['Plates'] }),
      box({ id: '3', box_number: 3, to_room: null, contents: ['Cables'] }),
      box({ id: '9', box_number: 9, move_id: 'other' }),
    ];
    expect(nextBoxNumber(boxes, 'mv')).toBe(4);
    const rooms = boxesByRoom(boxes, 'mv');
    expect(rooms.map((r) => r.room)).toEqual(['Kitchen', 'Unassigned']);
    expect(rooms[0].boxes.map((b) => b.box_number)).toEqual([2, 1]); // unpacked last
    expect(findInBoxes(boxes, 'mv', 'kettle').map((b) => b.id)).toEqual(['1']);
    expect(findInBoxes(boxes, 'mv', '')).toEqual([]);
  });
});
