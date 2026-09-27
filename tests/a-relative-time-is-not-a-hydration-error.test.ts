import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// "Just now" on the server and "1m ago" in the browser a second later is the
// same fact, not a defect, but React treats the different text as a failed
// hydration (#418) and throws. The signed-in page sweep caught it on
// /admin/notifications, whose first row is the sweep's own new-family alert,
// written seconds earlier. The house answer is React's own escape hatch for
// timestamps: the element that holds the relative time carries
// suppressHydrationWarning, so the server's text stands until the next render.
//
// Every client component that renders timeAgo(...) or relativeTime(...) as
// text is held to it, including those whose rows only arrive after mount
// today: a cache or a server prop added tomorrow would bring the rows into
// the server render without anyone looking at this line again.

function clientComponents(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) clientComponents(p, out);
    else if (p.endsWith('.tsx') && /^['"]use client['"]/.test(readFileSync(p, 'utf8'))) out.push(p);
  }
  return out;
}

const RELATIVE_TIME_TEXT = /\{\s*(?:timeAgo|relativeTime)\(/;

describe('a relative time rendered by a client component', () => {
  const sites = [...clientComponents('app'), ...clientComponents('components')].flatMap((file) =>
    readFileSync(file, 'utf8').split('\n').flatMap((line, i) => (RELATIVE_TIME_TEXT.test(line) ? [{ file, line: i + 1, text: line.trim() }] : [])));

  it('is found where the sweep found it', () => {
    expect(sites.some((s) => s.file === join('components', 'admin', 'admin-notifications-list.tsx'))).toBe(true);
  });

  it('sits in an element that expects the server and the browser to differ', () => {
    const bare = sites.filter((s) => !s.text.includes('suppressHydrationWarning')).map((s) => `${s.file}:${s.line}`);
    expect(bare).toEqual([]);
  });
});
