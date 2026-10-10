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
 *
 * The rule below once listed link fields by name, and four member-written
 * fields were not on the list: a warranty's claim link, a favorite's link, a
 * trip document's file link and a library item's page link (SEC-006, with
 * four provider-written ones beside them). It now covers every field whose
 * name ends in "url", and names the exceptions. Measured on React 19, which
 * this app now runs: React replaces a `javascript:` href with a throwing stub,
 * but a `data:` href is rendered as written
 * (tests/e2e/a-stored-link-is-inert-in-the-page.spec.ts), so the rule still
 * stands between a stored value and an anchor.
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

/**
 * Fields whose name ends in "url" that hold no stored or provider value: each
 * is a constant in the code, or built by the server from one, and naming them
 * keeps the rule below exhaustive.
 */
const CONSTANT_FIELDS: Record<string, string> = {
  'retailer.storeUrl': 'lib/grocery/retailers.ts, a constant table of store pages',
  'def.docsUrl': 'lib/social/capabilities.ts, a constant per provider',
  'provider.connectUrl': 'lib/calendar/providers.ts, a constant same-origin /api path',
  'ai.searchUrl': 'app/api/ai/home/find-pro builds it as https://www.google.com/search?q=…',
};

// `href={x.url}`, `href={x.claim_url}`, `href={item.pageUrl}`: a member
// expression on any field whose name ends in "url" (or a website/homepage),
// not passed through safeWebLink / safeSocialLink / media.
const RAW_LINK = /href=\{(?![^}]*\b(safeWebLink|safeSocialLink|media)\()([^}]*\b([a-zA-Z_]+\.(?:[a-zA-Z_]*(?:url|Url|URL)|website|homepage))\b[^}]*)\}/g;

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
      for (const m of src.matchAll(RAW_LINK)) {
        // Only the named field is exempt in those files: a whole-file skip once
        // hid a second, provider-written link (feedback-admin's GitHub issue).
        if (path in SERVER_WRITTEN && m[2].trim() === 'n.url') continue;
        // The passwords vault forces an https:// prefix onto anything that is
        // not already http(s), so `javascript:x` becomes a harmless host name.
        if (/\^https\?:/.test(m[2])) continue;
        if (m[2].trim() in CONSTANT_FIELDS) continue;
        raw.push(`${path}: href={${m[2].trim()}}`);
      }
    }
    expect(raw, 'wrap these in safeWebLink(...) ?? undefined:\n' + raw.join('\n')).toEqual([]);
  });

  it('every CONSTANT_FIELDS entry is still rendered, raw, somewhere', () => {
    for (const field of Object.keys(CONSTANT_FIELDS)) {
      expect(files.some((f) => f.src.includes(`href={${field}}`)), `${field} is no longer rendered raw — drop it`).toBe(true);
    }
  });

  it('every SERVER_WRITTEN entry still renders a stored url', () => {
    for (const p of Object.keys(SERVER_WRITTEN)) {
      const f = files.find((x) => x.path === p);
      expect(f, `${p} moved or is gone`).toBeTruthy();
      expect(/href=\{n\.url\}/.test(f!.src), `${p} no longer renders n.url — drop it`).toBe(true);
    }
  });
});
