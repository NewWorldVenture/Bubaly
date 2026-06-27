// Pure, unit-tested search for the Family Memory timeline. Kept out of the React
// component so the matching rules are deterministic and covered by tests. The UI
// (components/family/memory-timeline.tsx) is a thin shell over filterMemories.

export type SearchableMemory = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  memory_date: string;
  member_id: string | null;
  is_favorite: boolean | null;
};

export type MemoryFilter = {
  query?: string;
  favoritesOnly?: boolean;
};

/**
 * Returns true when `m` matches the filter. A memory matches when:
 *  - favoritesOnly is off OR the memory is a favorite, AND
 *  - the (trimmed, case-insensitive) query is empty, OR appears in any of
 *    title / body / kind / the resolved member name / the date.
 * `nameOf` resolves a member_id to a display name (so search covers "who").
 */
export function memoryMatches(
  m: SearchableMemory,
  filter: MemoryFilter,
  nameOf: (memberId: string | null) => string,
): boolean {
  if (filter.favoritesOnly && !m.is_favorite) return false;
  const q = (filter.query ?? '').trim().toLowerCase();
  if (!q) return true;
  const haystack = [m.title, m.body ?? '', m.kind, nameOf(m.member_id), m.memory_date]
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

/** Filters a list of memories by the same rules as memoryMatches. */
export function filterMemories<T extends SearchableMemory>(
  memories: T[],
  filter: MemoryFilter,
  nameOf: (memberId: string | null) => string,
): T[] {
  return memories.filter((m) => memoryMatches(m, filter, nameOf));
}
