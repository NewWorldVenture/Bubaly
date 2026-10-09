import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A link one family member stores is OPENED only as a web link (SEC-002).
 *
 * tests/a-stored-link-is-a-web-link.test.ts holds `href={…}` sinks to
 * safeWebLink / safeSocialLink. `window.open(…)` is the same sink by another
 * name, and React's `javascript:` filtering does not apply to it. The Social
 * Feed's "Open post" passed `social_reader_items.permalink` straight to
 * `window.open`; any active family member (child, guest included) can write that
 * column under the 0101 policy, and `addFeedItemAction` stored it unchecked.
 * Whether a `javascript:` URL then runs depends on the browser's handling of
 * `noopener` popups — the guard must not.
 */

const ROOT = join(__dirname, '..');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

// The first argument of window.open is fine when it is a string literal, a
// template literal whose scheme and host are fixed in the source, or a value
// already passed through the shared web-link rule.
const SAFE_FIRST_ARG = /^\s*('[^']*'|"[^"]*"|`(tel:|mailto:|https:\/\/[a-z0-9.-]+[/?])|(safeWebLink|safeSocialLink)\(|href\b)/;

describe('window.open opens only a literal or a web link', () => {
  const files = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components')), ...walk(join(ROOT, 'lib'))]
    .map((p) => ({ path: p.slice(ROOT.length + 1).split(sep).join('/'), src: readFileSync(p, 'utf8') }));

  it('finds window.open calls (non-vacuity)', () => {
    const calls = files.flatMap(({ src }) => [...src.matchAll(/window\.open\(/g)]);
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it('no window.open call opens a stored value raw', () => {
    const raw: string[] = [];
    for (const { path, src } of files) {
      for (const m of src.matchAll(/^(?!\s*(\/\/|\*))[^\n]*?window\.open\(([^\n]*)/gm)) {
        if (!SAFE_FIRST_ARG.test(m[2])) raw.push(`${path}: window.open(${m[2].slice(0, 80)}`);
      }
    }
    expect(raw, 'pass these through safeWebLink / safeSocialLink first:\n' + raw.join('\n')).toEqual([]);
  });

  it('the Social Feed opens the permalink through safeSocialLink', () => {
    const src = readFileSync(join(ROOT, 'components/modules/social-feed-module.tsx'), 'utf8');
    expect(src).toMatch(/const href = safeSocialLink\(item\.permalink\);\s*if \(href\) window\.open\(href, '_blank', 'noopener'\)/);
  });
});

// ── The write path refuses what the reader would refuse ──────────────────────

const mocks = vi.hoisted(() => ({ insert: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-1' }, active: { familyId: 'family-1' } }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({ from: () => ({ insert: mocks.insert }) }),
}));

describe('addFeedItemAction stores only web links', () => {
  beforeEach(() => { mocks.insert.mockReset(); mocks.insert.mockResolvedValue({ error: null }); });
  afterEach(() => vi.clearAllMocks());

  const base = { platform: 'x', authorName: 'Ada' };

  it.each([
    ['permalink', { permalink: 'javascript:fetch("/api/privacy/export")' }],
    ['permalink', { permalink: 'data:text/html,<script>alert(1)</script>' }],
    ['thumbnailUrl', { thumbnailUrl: 'javascript:alert(1)' }],
    ['mediaUrls', { mediaUrls: ['https://cdn.example.com/a.jpg', 'javascript:alert(1)'] }],
  ])('refuses a non-web %s and writes nothing', async (_field, extra) => {
    const { addFeedItemAction } = await import('@/app/(app)/dashboard/social-feed/actions');
    const res = await addFeedItemAction({ ...base, ...extra });
    expect(res).toEqual({ ok: false, error: 'actions.enterAValidPublicWeb' });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('stores web links unchanged', async () => {
    const { addFeedItemAction } = await import('@/app/(app)/dashboard/social-feed/actions');
    const res = await addFeedItemAction({
      ...base, permalink: ' https://x.com/ada/status/1 ', thumbnailUrl: 'https://cdn.example.com/t.jpg',
      mediaUrls: ['https://cdn.example.com/a.jpg'],
    });
    expect(res).toEqual({ ok: true });
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({
      permalink: 'https://x.com/ada/status/1', thumbnail_url: 'https://cdn.example.com/t.jpg',
      media_urls: ['https://cdn.example.com/a.jpg'],
    }));
  });
});
