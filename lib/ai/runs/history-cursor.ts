import { formatExactInstant, parseExactInstant } from '@/lib/calendar/exact-instant';

// A cursor is data, never PostgREST filter syntax. Bound its size and admit
// only exact instants and canonical UUIDs before interpolating the tuple.
const MAX_CURSOR_LENGTH = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type RunHistoryCursor = { createdAt: string; id: string | null };

/** Timestamp-only bookmarks retain their historical strict-before meaning.
 * New cursors carry the ID too, so rows at the boundary instant are not lost. */
export function decodeRunHistoryCursor(raw: unknown): RunHistoryCursor | null {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_CURSOR_LENGTH || raw.trim() !== raw) return null;
  const parts = raw.split('|');
  let clock = raw;
  let id: string | null = null;
  if (parts.length !== 1) {
    if (parts.length !== 3 || parts[0] !== 'v1' || !UUID.test(parts[2])) return null;
    clock = parts[1];
    id = parts[2].toLowerCase();
  }
  try {
    const instant = parseExactInstant(clock);
    // PostgreSQL timestamps have microsecond precision. Do not round a finer
    // input into a different boundary; trailing zero digits remain harmless.
    if (instant % 1000n !== 0n) return null;
    return { createdAt: formatExactInstant(instant), id };
  } catch {
    return null;
  }
}

export function normalizeRunHistoryCursor(raw: unknown): string | null {
  const cursor = decodeRunHistoryCursor(raw);
  return cursor ? cursor.id === null ? cursor.createdAt : `v1|${cursor.createdAt}|${cursor.id}` : null;
}

/** The tuple is taken from the last rendered row, after all sources merge. */
export function runHistoryCursorFor(row: { id: string; createdAt: string }): string {
  const encoded = normalizeRunHistoryCursor(`v1|${row.createdAt}|${row.id}`);
  if (!encoded) throw new Error('Invalid persisted run-history cursor');
  return encoded;
}
