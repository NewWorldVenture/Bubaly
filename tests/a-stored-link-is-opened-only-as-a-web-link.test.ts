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

// The shared web-link guards, by the module that exports them. A call counts
// only when its name is bound by an import of that name from that module — a
// local function that happens to be called safeWebLink does not.
const GUARDS: Record<string, string> = { safeWebLink: '@/lib/utils/safe-link', safeSocialLink: '@/lib/social/links' };
// A template may interpolate only after a scheme (and, for https, a host and
// a path or query separator) written out in the source.
const FIXED_TEMPLATE_HEAD = /^(tel:|mailto:|https:\/\/[a-z0-9.-]+[/?])/;

const bindsName = (name: ts.BindingName, wanted: string): boolean =>
  ts.isIdentifier(name) ? name.text === wanted
    : name.elements.some((e) => !ts.isOmittedExpression(e) && bindsName(e.name, wanted));

/** `var` declarations anywhere in a function body, outside nested functions: they bind at function scope. */
function hoistedVars(body: ts.Node, wanted: string, out: ts.Node[]) {
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isVariableDeclarationList(node) && !(node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) {
      for (const d of node.declarations) if (bindsName(d.name, wanted)) out.push(d);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
}

/** Every declaration of `wanted` that `scope` itself introduces. */
function bindingsIn(scope: ts.Node, wanted: string): ts.Node[] {
  const out: ts.Node[] = [];
  if (ts.isFunctionLike(scope)) {
    for (const p of scope.parameters) if (bindsName(p.name, wanted)) out.push(p);
    if ((ts.isFunctionExpression(scope) || ts.isClassExpression(scope)) && scope.name?.text === wanted) out.push(scope);
    const body = (scope as ts.FunctionLikeDeclaration).body;
    if (body) hoistedVars(body, wanted, out);
  } else if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseBlock(scope)) {
    const statements = ts.isCaseBlock(scope) ? scope.clauses.flatMap((c) => [...c.statements]) : scope.statements;
    for (const st of statements) {
      if (ts.isVariableStatement(st) && st.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) {
        for (const d of st.declarationList.declarations) if (bindsName(d.name, wanted)) out.push(d);
      } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name?.text === wanted) {
        out.push(st);
      } else if (ts.isImportDeclaration(st) && st.importClause) {
        const { name, namedBindings } = st.importClause;
        if (name?.text === wanted) out.push(name);
        if (namedBindings && ts.isNamespaceImport(namedBindings) && namedBindings.name.text === wanted) out.push(namedBindings);
        if (namedBindings && ts.isNamedImports(namedBindings)) for (const el of namedBindings.elements) if (el.name.text === wanted) out.push(el);
      }
    }
    if (ts.isSourceFile(scope)) hoistedVars(scope, wanted, out);
  } else if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope))
    && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
    for (const d of scope.initializer.declarations) if (bindsName(d.name, wanted)) out.push(d);
  } else if (ts.isCatchClause(scope) && scope.variableDeclaration && bindsName(scope.variableDeclaration.name, wanted)) {
    out.push(scope.variableDeclaration);
  }
  return out;
}

/**
 * The declaration an identifier actually refers to: the bindings of the
 * nearest enclosing scope that declares the name. More than one, or none in
 * the file, is reported as no single binding.
 */
function resolve(id: ts.Identifier): ts.Node | null {
  for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
    const found = bindingsIn(scope, id.text);
    if (found.length) return found.length === 1 ? found[0] : null;
  }
  return null;
}

/** True when `id` is bound by `import { <name> } from '<module>'` for one of the shared guards. */
function isGuard(id: ts.Identifier): boolean {
  const source = GUARDS[id.text];
  const binding = source ? resolve(id) : null;
  if (!binding || !ts.isImportSpecifier(binding) || (binding.propertyName ?? binding.name).text !== id.text) return false;
  const decl = binding.parent.parent.parent;
  return ts.isStringLiteral(decl.moduleSpecifier) && decl.moduleSpecifier.text === source;
}

/**
 * Whether what window.open is given is a literal or a value already through the
 * shared web-link rule. An identifier is followed to the binding it actually
 * refers to, and is safe only if that is a plain `const name = <safe>` declared
 * before the use; a nearer parameter, `let`, `var`, destructuring, catch or loop
 * binding stops the search, as does anything else — a stored field, a
 * concatenation (even after a literal prefix), a conditional, another call.
 */
function isSafeOpenTarget(node: ts.Expression, depth = 0): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) return isSafeOpenTarget(node.expression, depth);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (ts.isTemplateExpression(node)) return FIXED_TEMPLATE_HEAD.test(node.head.text);
  if (ts.isCallExpression(node)) return ts.isIdentifier(node.expression) && isGuard(node.expression);
  if (ts.isIdentifier(node) && depth === 0) {
    const d = resolve(node);
    return !!d && ts.isVariableDeclaration(d) && ts.isIdentifier(d.name)
      && !!(d.parent.flags & ts.NodeFlags.Const) && !ts.isForOfStatement(d.parent.parent) && !ts.isForInStatement(d.parent.parent)
      && d.end <= node.pos && !!d.initializer && isSafeOpenTarget(d.initializer, depth + 1);
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
  const IMPORTS = "import { safeWebLink } from '@/lib/utils/safe-link';\nimport { safeSocialLink } from '@/lib/social/links';\n";
  const one = (src: string) => windowOpens([{ path: 'x.tsx', src: IMPORTS + src }]).map((o) => o.safe);

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

  // An outer safe const and an inner binding of the same name: the call sees the inner one.
  const OUTER = 'const href = safeSocialLink(p);\n';
  it.each([
    ['a parameter', 'function go(href: string) { window.open(href); }'],
    ['an arrow parameter', 'const go = (href: string) => window.open(href);'],
    ['a destructured parameter', 'function go({ href }: { href: string }) { window.open(href); }'],
    ['an inner let', 'function go() { let href = item.permalink; window.open(href); }'],
    ['an inner var, declared after the call', 'function go() { window.open(href); if (x) { var href = item.permalink; } }'],
    ['an inner destructured const', 'function go() { const { href } = item; window.open(href); }'],
    ['an inner const bound to a stored field', 'function go() { const href = item.permalink; window.open(href); }'],
    ['a catch binding', 'try { run(); } catch (href) { window.open(href); }'],
    ['a for-of binding', 'for (const href of links) { window.open(href); }'],
  ])('refuses an outer safe const shadowed by %s', (_label, inner) => {
    expect(one(OUTER + inner)).toEqual([false]);
  });

  it('accepts the outer safe const when nothing shadows it, and an inner safe const over an outer unsafe one', () => {
    expect(one(OUTER + 'function go() { window.open(href); }')).toEqual([true]);
    expect(one('const href = item.permalink;\nfunction go() { const href = safeSocialLink(p); window.open(href); }')).toEqual([true]);
  });

  it('refuses a const used before it is declared', () => {
    expect(one('function go() { window.open(href); const href = safeSocialLink(p); }')).toEqual([false]);
  });

  it('counts a guard only when it is the shared one, imported from its module', () => {
    const open = 'window.open(safeWebLink(row.url)!);';
    expect(windowOpens([{ path: 'x.tsx', src: open }]).map((o) => o.safe), 'not imported at all').toEqual([false]);
    expect(windowOpens([{ path: 'x.tsx', src: 'const safeWebLink = (u: string) => u;\n' + open }]).map((o) => o.safe), 'a local look-alike').toEqual([false]);
    expect(windowOpens([{ path: 'x.tsx', src: "import { safeWebLink } from './elsewhere';\n" + open }]).map((o) => o.safe), 'another module').toEqual([false]);
    expect(windowOpens([{ path: 'x.tsx', src: "import { passThrough as safeWebLink } from '@/lib/utils/safe-link';\n" + open }]).map((o) => o.safe), 'a renamed import').toEqual([false]);
    expect(one('function go(safeWebLink: (u: string) => string) { ' + open + ' }'), 'shadowed by a parameter').toEqual([false]);
    expect(one(open), 'the shared guard').toEqual([true]);
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
