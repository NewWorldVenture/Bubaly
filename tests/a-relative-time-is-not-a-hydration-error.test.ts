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

// Every helper in the app that turns a timestamp into words relative to now.
const RELATIVE_TIME_TEXT = /\{\s*(?:timeAgo|relativeTime|relativeDate|fmtRelative|fmtTimeAgo\d*|formatRelativeTime)\(/g;

/** The opening tag of the element whose text the call at `at` is. */
function enclosingOpenTag(src: string, at: number): string {
  let depth = 0;
  for (let i = at; i >= 0; i--) {
    if (src[i] !== '<') continue;
    if (src[i + 1] === '/') { depth++; continue; }
    if (!/[a-zA-Z]/.test(src[i + 1] ?? '')) continue;
    const end = src.indexOf('>', i);
    const tag = src.slice(i, end + 1);
    if (tag.endsWith('/>')) continue;
    if (depth === 0) return tag;
    depth--;
  }
  return '';
}

describe('a relative time rendered by a client component', () => {
  const sites = [...clientComponents('app'), ...clientComponents('components')].flatMap((file) => {
    const src = readFileSync(file, 'utf8');
    return [...src.matchAll(RELATIVE_TIME_TEXT)].map((m) => ({
      file, line: src.slice(0, m.index).split('\n').length, tag: enclosingOpenTag(src, m.index!),
    }));
  });

  it('is found where the sweep found it', () => {
    expect(sites.some((s) => s.file === join('components', 'admin', 'admin-notifications-list.tsx'))).toBe(true);
    expect(sites.length).toBeGreaterThan(15);
  });

  it('sits in an element that expects the server and the browser to differ', () => {
    const bare = sites.filter((s) => !s.tag.includes('suppressHydrationWarning')).map((s) => `${s.file}:${s.line} ${s.tag.slice(0, 60)}`);
    expect(bare).toEqual([]);
  });
});
