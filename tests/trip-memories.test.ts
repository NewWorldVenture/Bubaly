import { describe, expect, it } from 'vitest';
import { groupByTrip, memoryCount, type MemoryLike } from '@/lib/vacations/memories';

const mem = (vacation_id: string | null, memory_date: string): MemoryLike => ({ vacation_id, memory_date });

describe('groupByTrip', () => {
  it('groups by vacation, newest entries first within a group', () => {
    const groups = groupByTrip([
      mem('t1', '2026-06-01'),
      mem('t1', '2026-06-05'),
      mem('t2', '2026-07-01'),
    ]);
    const t1 = groups.find((g) => g.vacationId === 't1')!;
    expect(t1.memories.map((m) => m.memory_date)).toEqual(['2026-06-05', '2026-06-01']);
  });
  it('orders trips by most-recent memory, untagged last', () => {
    const groups = groupByTrip([
      mem(null, '2026-08-01'),
      mem('t1', '2026-06-05'),
      mem('t2', '2026-07-01'),
    ]);
    expect(groups.map((g) => g.vacationId)).toEqual(['t2', 't1', '']);
  });
  it('memoryCount', () => {
    expect(memoryCount([1, 2, 3])).toBe(3);
  });
});
