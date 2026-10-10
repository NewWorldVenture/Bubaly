import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import ts from 'typescript';
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

const SAFE_LINK = new Set(['safeWebLink', 'safeSocialLink']);
// A template may interpolate only after a scheme (and, for https, a host and
// a path or query separator) written out in the source.
const FIXED_TEMPLATE_HEAD = /^(tel:|mailto:|https:\/\/[a-z0-9.-]+[/?])/;

/** The nearest `const name = …` in a block enclosing `at`, declared before it. */
function constInitializer(name: string, at: ts.Node): ts.Expression | null {
  for (let scope: ts.Node | undefined = at.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (statement.pos >= at.pos) break;
      if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const d of statement.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) return d.initializer ?? null;
      }
    }
  }
  return null;
}

/**
 * Whether what window.open is given is a literal or a value already through the
 * shared web-link rule. Anything else — a stored field, a parameter, a `let`,
 * a concatenation (even after a literal prefix), a conditional — is not.
 */
function isSafeOpenTarget(node: ts.Expression, depth = 0): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) return isSafeOpenTarget(node.expression, depth);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (ts.isTemplateExpression(node)) return FIXED_TEMPLATE_HEAD.test(node.head.text);
  if (ts.isCallExpression(node)) return ts.isIdentifier(node.expression) && SAFE_LINK.has(node.expression.text);
  if (ts.isIdentifier(node) && depth === 0) {
    const init = constInitializer(node.text, node);
    return !!init && isSafeOpenTarget(init, depth + 1);
  }
  return false;
}

type Source = { path: string; src: string };
type Open = { at: string; safe: boolean };

/** Every `window.open(…)` call in the sources, and whether its URL is safe. */
function windowOpens(files: Source[]): Open[] {
  const out: Open[] = [];
  for (const { path, src } of files) {
    const file = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'open' && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'window') {
        const [url] = node.arguments;
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        out.push({ at: `${path}:${line}`, safe: !url || isSafeOpenTarget(url) });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return out;
}
const unsafe = (files: Source[]) => windowOpens(files).filter((o) => !o.safe).map((o) => o.at);

describe('window.open opens only a literal or a web link', () => {
  const files: Source[] = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components')), ...walk(join(ROOT, 'lib'))]
    .map((p) => ({ path: p.slice(ROOT.length + 1).split(sep).join('/'), src: readFileSync(p, 'utf8') }));

  it('finds the window.open calls (non-vacuity)', () => {
    expect(windowOpens(files).length).toBeGreaterThanOrEqual(4);
    expect(windowOpens(files).map((o) => o.at.split(':')[0])).toContain('components/modules/social-feed-module.tsx');
  });

  it('no window.open call opens a value that is not a literal or a checked web link', () => {
    expect(unsafe(files), 'pass these through safeWebLink / safeSocialLink first').toEqual([]);
  });

  it('an added unsafe call anywhere is reported, and only it', () => {
    const added = { path: 'components/synthetic-added.tsx', src: 'export const f = (row: { url: string }) => window.open(row.url, "_blank");' };
    expect(unsafe([...files, added])).toEqual(['components/synthetic-added.tsx:1']);
  });

  it('the Social Feed opens the permalink through safeSocialLink', () => {
    const src = readFileSync(join(ROOT, 'components/modules/social-feed-module.tsx'), 'utf8');
    expect(src).toMatch(/const href = safeSocialLink\(item\.permalink\);\s*if \(href\) window\.open\(href, '_blank', 'noopener'\)/);
  });
});

describe('what the ratchet refuses and accepts', () => {
  const one = (src: string) => windowOpens([{ path: 'x.tsx', src }]).map((o) => o.safe);

  it.each([
    ['a variable named href bound to a stored field', 'const href = item.permalink; window.open(href);'],
    ['a parameter', 'function go(href: string) { window.open(href); }'],
    ['a let, even one first set safely', 'let href = safeSocialLink(p); href = item.permalink; window.open(href);'],
    ['a const declared in another function', 'function a() { const href = safeSocialLink(p); } function b(href: string) { window.open(href); }'],
    ['an empty literal joined to a stored field', "window.open('' + item.permalink);"],
    ['a literal prefix joined to a stored field', "window.open('https://example.com/' + item.permalink);"],
    ['a template that starts with the stored field', 'window.open(`${item.permalink}`);'],
    ['a template with a stored scheme', 'window.open(`${item.scheme}//example.com`);'],
    ['a conditional', "window.open(ok ? safeSocialLink(p) : item.permalink);"],
    ['a call to another function', 'window.open(normalize(item.permalink));'],
  ])('refuses %s', (_label, src) => {
    expect(one(src)).toEqual([false]);
  });

  it.each([
    ['a literal', "window.open('about:blank', '_blank');"],
    ['no URL at all', 'window.open();'],
    ['a checked link', 'window.open(safeWebLink(row.url)!, "_blank");'],
    ['a const bound to a checked link', "const href = safeSocialLink(item.permalink); if (href) window.open(href, '_blank', 'noopener');"],
    ['a tel: template', 'window.open(`tel:${phone}`);'],
    ['a fixed-host template', 'window.open(`https://maps.google.com?q=${encodeURIComponent(address)}`, "_blank");'],
  ])('accepts %s', (_label, src) => {
    expect(one(src)).toEqual([true]);
  });

  it('ignores window.open written in a comment', () => {
    expect(one('// window.open(item.permalink)\n/* window.open(row.url) */')).toEqual([]);
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
