import { describe, it, expect } from 'vitest';
import { buildFrontDoor, frontDoorHeadline } from '@/lib/home/front-door';

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
