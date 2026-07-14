import { describe, it, expect } from 'vitest';
import { buildFrontDoor, frontDoorHeadline, mergeHandled } from '@/lib/home/front-door';

describe('frontDoorHeadline', () => {
  it('combines done + pending', () => {
    expect(frontDoorHeadline(3, 2)).toBe('I already handled 3 things — 2 need your OK.');
    expect(frontDoorHeadline(1, 1)).toBe('I already handled 1 thing — 1 needs your OK.');
  });
  it('done only', () => {
    expect(frontDoorHeadline(2, 0)).toBe('I already handled 2 things for you — nothing needs you right now.');
  });
  it('pending only', () => {
    expect(frontDoorHeadline(0, 1)).toBe('One thing is waiting on your OK.');
    expect(frontDoorHeadline(0, 4)).toBe('4 things are waiting on your OK.');
  });
  it('nothing', () => {
    expect(frontDoorHeadline(0, 0)).toContain('all caught up');
  });
});

describe('buildFrontDoor', () => {
  it('hides when there is nothing', () => {
    expect(buildFrontDoor({}).show).toBe(false);
  });
  it('shows and uses explicit totals over sample sizes', () => {
    const fd = buildFrontDoor({
      done: [{ id: 'a', title: 'Reordered milk' }],
      doneCount: 4,               // more than the one listed
      pending: [{ id: 'p', title: 'Approve field-trip payment', priority: 'high' }],
      pendingCount: 1,
    });
    expect(fd.show).toBe(true);
    expect(fd.doneCount).toBe(4);
    expect(fd.headline).toBe('I already handled 4 things — 1 needs your OK.');
  });
  it('sorts pending most-urgent first', () => {
    const fd = buildFrontDoor({
      pending: [
        { id: '1', title: 'low', priority: 'low' },
        { id: '2', title: 'urgent', priority: 'urgent' },
        { id: '3', title: 'normal', priority: 'normal' },
      ],
    });
    expect(fd.pending.map((p) => p.priority)).toEqual(['urgent', 'normal', 'low']);
  });
});

describe('mergeHandled', () => {
  it('lists autopilot first, then agent actions, tagging source + prefixed ids', () => {
    const merged = mergeHandled(
      [{ id: 'a1', title: 'Reordered milk', kind: 'groceries' }],
      [{ id: 'g1', title: 'Resolved a calendar conflict', agent: 'scheduler' }],
    );
    expect(merged).toEqual([
      { id: 'ap:a1', title: 'Reordered milk', kind: 'groceries', source: 'autopilot' },
      { id: 'ag:g1', title: 'Resolved a calendar conflict', kind: 'scheduler', source: 'agent' },
    ]);
  });
  it('collapses a duplicate title surfaced by both systems (autopilot wins)', () => {
    const merged = mergeHandled(
      [{ id: 'a1', title: 'Filed the field-trip form' }],
      [{ id: 'g1', title: 'filed the field-trip form', agent: 'assistant' }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('autopilot');
  });
  it('caps the merged list', () => {
    const ap = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, title: `auto ${i}` }));
    const ag = Array.from({ length: 10 }, (_, i) => ({ id: `g${i}`, title: `agent ${i}` }));
    expect(mergeHandled(ap, ag, 6)).toHaveLength(6);
  });
});

describe('mergeHandled', () => {
  it('puts autopilot (undoable) first, then agent actions, with source tags', () => {
    const merged = mergeHandled(
      [{ id: '1', title: 'Reordered milk', kind: 'groceries' }],
      [{ id: '9', title: 'Booked a checkup', agent: 'health_aide' }],
    );
    expect(merged).toEqual([
      { id: 'ap:1', title: 'Reordered milk', kind: 'groceries', source: 'autopilot' },
      { id: 'ag:9', title: 'Booked a checkup', kind: 'health_aide', source: 'agent' },
    ]);
  });
  it('collapses duplicate titles across sources (autopilot wins)', () => {
    const merged = mergeHandled(
      [{ id: '1', title: 'Built this week’s dinner plan' }],
      [{ id: '9', title: 'built this week’s dinner plan ', agent: 'meal_planner' }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('autopilot');
  });
  it('caps the merged list', () => {
    const ap = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, title: `Autopilot ${i}` }));
    const ag = Array.from({ length: 10 }, (_, i) => ({ id: `g${i}`, title: `Agent ${i}` }));
    expect(mergeHandled(ap, ag, 6)).toHaveLength(6);
    expect(mergeHandled(ap.slice(0, 2), ag, 4)).toHaveLength(4);
  });
  it('handles empty inputs', () => {
    expect(mergeHandled([], [])).toEqual([]);
    expect(mergeHandled([], [{ id: '1', title: 'Solo agent action' }])[0].source).toBe('agent');
  });
});
