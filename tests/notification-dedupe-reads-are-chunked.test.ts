import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// MAIN-F-014. The notification dedupe read put every candidate's related_id in
// one `.in()` filter. Those ids are composite strings (`moment:<eventId>:<date>`,
// about 60 characters encoded), so a few hundred built a request line past the
// gateway limit. The read failed "URI too long", `seen` came back empty, and
// every run re-notified everyone. Both dedupe reads now go through readInChunks
// at 50 per batch; nothing pinned that.

const code = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
const FILES = ['lib/server/notifications.ts', 'lib/services/approvals/index.ts'];

describe('a dedupe read by related_id travels in batches', () => {
  it.each(FILES)('%s filters related_id only on a chunk, at most 50 wide', (f) => {
    const src = code(f);
    const filters = [...src.matchAll(/\.in\('related_id',\s*([^)]+)\)/g)].map((m) => m[1].trim());
    expect(filters.length, 'the dedupe read is gone; re-read MAIN-F-014 before removing this').toBeGreaterThan(0);
    expect(filters.every((arg) => arg === 'chunk'), filters.join(', ')).toBe(true);
    // Every such call sits in a readInChunks callback whose width is ≤ 50.
    const widths = [...src.matchAll(/readInChunks<[\s\S]*?\.in\('related_id', chunk\),\s*(\d+)\)/g)].map((m) => Number(m[1]));
    expect(widths).toHaveLength(filters.length);
    expect(widths.every((w) => w > 0 && w <= 50), widths.join(', ')).toBe(true);
  });

  it('a failed dedupe read is logged, never silently treated as "nothing seen"', () => {
    expect(code('lib/server/notifications.ts')).toContain("console.error('[notifications] dedup read failed'");
    expect(code('lib/services/approvals/index.ts')).toContain("console.error('[service:approvals] reminder dedupe read failed'");
  });
});
