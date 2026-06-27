// lib/vacations/memories.ts — pure helpers for Trip Memories.
// Group memories by trip (newest entries first) and roll up counts. No I/O.

export type MemoryLike = { vacation_id: string | null; memory_date: string };

/** Group memories by vacation_id ('' bucket = not attached to a trip).
 *  Groups ordered by their most-recent memory; entries within newest-first. */
export function groupByTrip<T extends MemoryLike>(memories: T[]): Array<{ vacationId: string; memories: T[] }> {
  const map = new Map<string, T[]>();
  for (const m of memories) {
    const key = m.vacation_id ?? '';
    const a = map.get(key) ?? [];
    a.push(m);
    map.set(key, a);
  }
  const groups = [...map.entries()].map(([vacationId, list]) => ({
    vacationId,
    memories: [...list].sort((a, b) => b.memory_date.localeCompare(a.memory_date)),
  }));
  groups.sort((a, b) => {
    // Trips first (non-empty key), then by newest memory in the group.
    if (!a.vacationId && b.vacationId) return 1;
    if (a.vacationId && !b.vacationId) return -1;
    return (b.memories[0]?.memory_date ?? '').localeCompare(a.memories[0]?.memory_date ?? '');
  });
  return groups;
}

export function memoryCount(memories: unknown[]): number {
  return memories.length;
}
