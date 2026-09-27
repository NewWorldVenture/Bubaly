// Page audit, signed-in sweep — a page's main column can shrink to the screen.
//
// Five admin pages (/admin/admins, /admin/content, /admin/marketing/content,
// /admin/support-tickets, /admin/users) overflowed a 1280 px window by 118 to
// 417 px: each lays out as `grid lg:grid-cols-[1fr_320px]`, and a `1fr` track
// is `minmax(auto, 1fr)` — it cannot shrink below its content's min-content
// width, so one wide table pushed the whole column, and the sidebar with it,
// off the right edge. `minmax(0,1fr)` lets the column shrink and the table
// scroll inside its own container. The same pattern sat in 31 more layouts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function tsx(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? tsx(p) : p.endsWith('.tsx') ? [p] : [];
  });
}

describe('grid columns can shrink', () => {
  it('no arbitrary grid template starts with a bare 1fr track', () => {
    const offenders = [...tsx('app'), ...tsx('components')].flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/grid-cols-\[1fr_[^\]]*\]/g)].map((m) => `${file}: ${m[0]}`));
    expect(offenders, 'write minmax(0,1fr) so the column can shrink below its content').toEqual([]);
  });
});
