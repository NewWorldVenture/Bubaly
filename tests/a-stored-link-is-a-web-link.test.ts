import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeWebLink } from '@/lib/utils/safe-link';
import { safeSocialLink } from '@/lib/social/links';

/**
 * A link one person saves must not run script in another person's session.
 *
 * Twelve places rendered a stored, typed link straight into `<a href>` —
 * a reminder's link, a wishlist item, a renewal, a sign-up, a project, a job
 * application, a recipe's source, a gift idea, two weekend links, a pro's
 * website and the public review links. React 18 renders `javascript:` hrefs
 * (with a console warning), and `<input type="url">` accepts them, so a child
 * could save `javascript:…` on a reminder assigned to a parent and it would run
 * as the parent on click. SEC-004 fixed exactly this for social posts; this is
 * the same rule, for everything else.
 */

describe('safeWebLink', () => {
  it('keeps a web link', () => {
    expect(safeWebLink('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeWebLink('http://example.com')).toBe('http://example.com/');
  });

  it('refuses anything that is not one', () => {
    for (const bad of [
      'javascript:alert(document.domain)', 'JavaScript:alert(1)', ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd',
      'https://user:pass@example.com', 'https://exa mple.com', 'example.com', '', null, undefined, 42,
      `https://example.com/${'a'.repeat(5000)}`,
    ]) expect(safeWebLink(bad), String(bad)).toBeNull();
  });

  it('is the same rule SEC-004 settled for social links', () => {
    for (const v of ['https://x.com/a', 'javascript:alert(1)', 'https://u:p@x.com', 'mailto:a@b.c']) {
      expect(safeSocialLink(v)).toBe(safeWebLink(v));
    }
  });
});

const ROOT = join(__dirname, '..');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * Hrefs over a stored field that are NOT user-typed: each is a constant path
 * the server writes, and naming them keeps the rule below exact.
 */
const SERVER_WRITTEN: Record<string, string> = {
  'app/(app)/admin/page.tsx': 'admin_notifications.url — only ever a constant /admin path (lib/admin/notify, lib/feedback/notify)',
  'components/admin/admin-notification-bell.tsx': 'admin_notifications.url, as above',
  'components/admin/admin-notifications-list.tsx': 'admin_notifications.url, as above',
  'components/admin/feedback-admin.tsx': 'admin_notifications.url, as above',
};

// `href={x.url}` and friends: a member expression on a field that holds a
// stored link, not passed through safeWebLink / safeSocialLink.
const RAW_LINK = /href=\{(?![^}]*\b(safeWebLink|safeSocialLink|media)\()([^}]*\b[a-zA-Z_]+\.(url|website|website_url|link_url|source_url|recipe_url|registry_url|listing_url|product_url|ticket_url|portal_url|booking_url|homepage|external_url)\b[^}]*)\}/g;

describe('a stored link is rendered only as a web link', () => {
  const files = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components'))]
    .map((p) => ({ path: p.slice(ROOT.length + 1).split(sep).join('/'), src: readFileSync(p, 'utf8') }));

  it('finds the guarded sites (non-vacuity)', () => {
    const guarded = files.filter((f) => /href=\{safeWebLink\(/.test(f.src)).map((f) => f.path);
    expect(guarded.length).toBeGreaterThanOrEqual(11);
    expect(guarded).toContain('components/modules/reminders-module.tsx');
  });

  it('no href renders a stored link field raw', () => {
    const raw: string[] = [];
    for (const { path, src } of files) {
      if (path in SERVER_WRITTEN) continue;
      for (const m of src.matchAll(RAW_LINK)) {
        // The passwords vault forces an https:// prefix onto anything that is
        // not already http(s), so `javascript:x` becomes a harmless host name.
        if (/\^https\?:/.test(m[2])) continue;
        raw.push(`${path}: href={${m[2].trim()}}`);
      }
    }
    expect(raw, 'wrap these in safeWebLink(...) ?? undefined:\n' + raw.join('\n')).toEqual([]);
  });

  it('every SERVER_WRITTEN entry still renders a stored url', () => {
    for (const p of Object.keys(SERVER_WRITTEN)) {
      const f = files.find((x) => x.path === p);
      expect(f, `${p} moved or is gone`).toBeTruthy();
      expect(/href=\{n\.url\}/.test(f!.src), `${p} no longer renders n.url — drop it`).toBe(true);
    }
  });
});
