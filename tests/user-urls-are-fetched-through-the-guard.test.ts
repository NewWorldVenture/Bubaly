import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

// A server that fetches a URL a user chose is a request the user gets to aim.
// Aimed at `http://169.254.169.254/` it reads cloud instance credentials; aimed
// at a private address it reaches services nothing else can.
//
// This repository defends it properly, and the defence is worth naming because
// it is the part most implementations get wrong: `validatePublicCalendarUrl`
// RESOLVES the hostname and rejects the resolved addresses — link-local,
// loopback, RFC1918, CGNAT, multicast, IPv4-mapped IPv6, `metadata.google
// .internal` — rejects credentials in the URL, and then `fetchPublicText`
// re-validates EVERY REDIRECT with `redirect: 'manual'`, so a public host
// cannot 302 the fetch onto a private one.
//
// Audited call by call when this was written, and all of it was already sound:
//
//   family calendar feeds   -> fetchPublicCalendarText   (guarded)
//   library RSS feeds       -> fetchPublicFeed           (guarded)
//   weekend curated feeds   -> fetchPublicCalendarText   (guarded)
//   Ticketmaster / SeatGeek -> constant host, query only
//   OpenAI, TheMealDB       -> constant host
//   health probe            -> the Supabase URL from env
//
// So this guard exists to keep a property that HOLDS, not to fix one that
// broke. The risk it covers is the premise gap that has produced several
// findings in this audit: the helper is excellent, and nothing stops the next
// route from calling bare `fetch(userUrl)` beside it.
//
// The rule: a server-side `fetch()` whose URL is not a literal constant host
// must live in a file that goes through the guard, or be named below with the
// reason its host cannot be chosen by a user.
const ROOTS = ['app', 'lib'];
const GUARDS = /fetchPublicText|fetchPublicCalendarText|fetchPublicFeed|validatePublicCalendarUrl/;

/**
 * Files whose `fetch()` takes a non-literal URL that a user cannot aim. Each
 * entry is a claim a reviewer can check: the HOST is fixed, only a path or
 * query varies.
 */
const CONSTANT_HOST: Record<string, string> = {
  'lib/server/external-fetch.ts': 'a timeout wrapper; every caller passes a literal provider URL',
  'lib/client-fetch.ts': 'a timeout wrapper for same-origin browser calls',
  'lib/recipes/providers/themealdb.ts': 'BASE is a module constant; only the path varies',
  'lib/blog/posts.ts': 'overrides the Supabase client fetch; the URL is the project URL',
  'lib/health/probe.ts': 'the Supabase URL from env, plus a fixed path',
  'lib/marketing/visitor.ts': 'same-origin relative paths to this app own API',
};

const AUTH_TRANSPORTS = new Set([
  'lib/auth/password-client.ts', 'lib/auth/signup-client.ts',
  'lib/auth/revoke-session.ts', 'lib/auth/recovery-server.ts',
  'lib/auth/callback-server.ts',
]);

/**
 * These owned auth transports target the configured Supabase project,
 * not a user-selected host. Recognize the particular fetch call and its SDK
 * wiring, rather than exempting the file: a new fetch beside it must still fail.
 * The recovery and callback servers constrain origin/path and redirects.
 */
function configuredAuthFetchLines(file: string, source: string): Set<number> {
  const allowed = new Set<number>();
  if (!AUTH_TRANSPORTS.has(file)) return allowed;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const compact = (node: ts.Node) => node.getText(tree).replace(/\s/g, '');
  const descendants = (node: ts.Node, predicate: (child: ts.Node) => boolean): ts.Node[] => {
    const found: ts.Node[] = [];
    const visit = (child: ts.Node) => { if (predicate(child)) found.push(child); child.forEachChild(visit); };
    visit(node);
    return found;
  };
  const declaration = (node: ts.Node, name: string, initializer: string) => descendants(node,
    child => ts.isVariableDeclaration(child) && child.name.getText(tree) === name
      && !!child.initializer && compact(child.initializer) === initializer).length === 1;
  const calls = descendants(tree, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && node.expression.text === 'fetch') as ts.CallExpression[];
  for (const call of calls) {
    if (file === 'lib/auth/callback-server.ts') {
      let helper: ts.Node | undefined = call.parent;
      while (helper && !ts.isFunctionDeclaration(helper)) helper = helper.parent;
      if (!helper || !ts.isFunctionDeclaration(helper) || helper.name?.text !== 'boundedFetch'
        || helper.parameters[0]?.name.getText(tree) !== 'origin' || call.arguments[0]?.getText(tree) !== 'input'
        || !declaration(helper, 'url', 'newURL(inputinstanceofRequest?input.url:String(input))')) continue;
      const operation = descendants(tree, node => ts.isFunctionDeclaration(node) && node.name?.text === 'completeCallback')[0];
      const wiring = descendants(tree, node => ts.isCallExpression(node) && node.expression.getText(tree) === 'boundedFetch') as ts.CallExpression[];
      // Both the isolated PKCE SDK and optional attribution SDK use exactly the
      // environment-derived project origin. A user-chosen sibling is not allowed.
      if (!operation || !declaration(operation, 'origin', 'newURL(clean(process.env.NEXT_PUBLIC_SUPABASE_URL)).origin')
        || wiring.length !== 2 || wiring.some(node => node.arguments[0]?.getText(tree) !== 'origin'
          || node.getStart(tree) < operation.getStart(tree) || node.end > operation.end)) continue;
      const guard = descendants(helper, node => ts.isIfStatement(node)
        && compact(node.expression) === "url.origin!==origin||(!url.pathname.startsWith('/rest/v1/')&&!['/auth/v1/token','/auth/v1/user'].includes(url.pathname))"
        && compact(node.thenStatement) === "thrownewError('Unexpectedcallbackendpoint');");
      const init = call.arguments[1];
      if (guard.length !== 1 || guard[0].getStart(tree) > call.getStart(tree) || !init
        || compact(init) !== "{...init,redirect:'manual',cache:'no-store',signal:requestSignal}") continue;
    } else if (file === 'lib/auth/recovery-server.ts') {
      let arrow: ts.Node | undefined = call.parent;
      while (arrow && !ts.isArrowFunction(arrow)) arrow = arrow.parent;
      if (!arrow || !ts.isArrowFunction(arrow) || !ts.isVariableDeclaration(arrow.parent)
        || arrow.parent.name.getText(tree) !== 'request' || call.arguments[0]?.getText(tree) !== 'url') continue;
      const operation = arrow.parent.parent.parent.parent;
      const config = descendants(tree, node => ts.isFunctionDeclaration(node) && node.name?.text === 'configuration')[0];
      if (!config || !declaration(config, 'raw', 'cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL)')
        || !declaration(operation, 'config', 'configuration()')
        || !declaration(arrow, 'url', 'newURL(path,config.origin)')) continue;
      const guard = descendants(arrow, node => ts.isIfStatement(node)
        && compact(node.expression) === "url.origin!==config.origin||!['/auth/v1/user','/auth/v1/token','/auth/v1/.well-known/jwks.json'].includes(url.pathname)"
        && compact(node.thenStatement) === "fail('authRecovery.invalidLink');");
      const init = call.arguments[1];
      if (guard.length !== 1 || guard[0].getStart(tree) > call.getStart(tree)
        || !init || !ts.isObjectLiteralExpression(init)
        || !init.properties.some(prop => ts.isPropertyAssignment(prop)
          && prop.name.getText(tree) === 'redirect' && prop.initializer.getText(tree) === "'manual'")) continue;
    } else {
      let property: ts.Node | undefined = call.parent;
      while (property && !(ts.isPropertyAssignment(property) && property.name.getText(tree) === 'fetch')) property = property.parent;
      if (!property || !ts.isPropertyAssignment(property) || !ts.isArrowFunction(property.initializer)
        || property.initializer.parameters[0]?.name.getText(tree) !== 'input'
        || call.arguments[0]?.getText(tree) !== 'input') continue;
      if (file === 'lib/auth/revoke-session.ts') {
        const options = property.parent;
        const sdk = options.parent;
        if (!ts.isObjectLiteralExpression(options) || !ts.isNewExpression(sdk)
          || sdk.expression.getText(tree) !== 'AuthAdminApi'
          || !options.properties.some(prop => ts.isPropertyAssignment(prop) && prop.name.getText(tree) === 'url'
            && compact(prop.initializer) === '`${url.origin}/auth/v1`')
          || !declaration(tree, 'url', 'newURL(process.env.NEXT_PUBLIC_SUPABASE_URL!)')) continue;
      } else {
        const global = property.parent.parent;
        if (!ts.isPropertyAssignment(global) || global.name.getText(tree) !== 'global') continue;
        const sdk = global.parent.parent;
        if (!ts.isCallExpression(sdk) || sdk.expression.getText(tree) !== 'createBrowserClient'
          || sdk.arguments[0]?.getText(tree) !== 'url'
          || !declaration(tree, 'url', 'process.env.NEXT_PUBLIC_SUPABASE_URL!')) continue;
      }
    }
    allowed.add(tree.getLineAndCharacterOfPosition(call.getStart(tree)).line + 1);
  }
  return allowed;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (extname(p) === '.ts') out.push(p);
  }
  return out;
}

/** `fetch(` calls whose first argument is not a literal `https://constant-host`. */
export function nonLiteralFetches(source: string): number[] {
  const hits: number[] = [];
  for (const m of source.matchAll(/(?<![\w.])fetch\(\s*/g)) {
    const rest = source.slice(m.index + m[0].length, m.index + m[0].length + 90);
    // A quoted absolute URL, or a template whose host is written out, is fixed.
    if (/^['"]https?:\/\//.test(rest)) continue;
    if (/^`https?:\/\/[A-Za-z0-9.\-]+/.test(rest)) continue;
    hits.push(source.slice(0, m.index).split('\n').length);
  }
  return hits;
}

describe('a URL a user chose is only fetched through the SSRF guard', () => {
  const files = ROOTS.flatMap((r) => sourceFiles(r));

  it('scans a meaningful number of server files', () => {
    expect(files.length).toBeGreaterThan(400);
  });

  it('has no server-side fetch of a non-constant URL outside the guard', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (source.slice(0, 60).includes("'use client'")) continue;
      const lines = nonLiteralFetches(source);
      if (lines.length === 0) continue;
      if (GUARDS.test(source)) continue;
      const key = file.split('\\').join('/');
      if (CONSTANT_HOST[key]) continue;
      const configured = configuredAuthFetchLines(key, source);
      const unguarded = lines.filter(line => !configured.has(line));
      if (unguarded.length) offenders.push(`${key}:${unguarded.join(',')} — fetches a non-constant URL without the public-URL guard`);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the constant-host list honest — every entry still fetches one', () => {
    // An exemption that outlives its reason is how a guard rots.
    const stale: string[] = [];
    for (const file of Object.keys(CONSTANT_HOST)) {
      if (nonLiteralFetches(readFileSync(file, 'utf8')).length === 0) {
        stale.push(`${file} no longer needs its exemption — remove it`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('the guard still resolves the host and re-checks redirects', () => {
    // The two properties that make it a real defence rather than a string test.
    const src = readFileSync('lib/server/public-calendar-fetch.ts', 'utf8');
    expect(src, 'must resolve the hostname, not just parse it').toMatch(/lookup/);
    expect(src, 'link-local / metadata range must be blocked').toMatch(/0xa9fe0000/);
    expect(src, 'google metadata host must be blocked').toMatch(/metadata\.google\.internal/);
    expect(src, 'redirects must not be followed blindly').toMatch(/redirect: 'manual'/);
    expect(src, 'each redirect target must be re-validated').toMatch(/validatePublicCalendarUrl\(new URL\(location/);
    expect(src, 'credentials in the URL must be refused').toMatch(/url\.username \|\| url\.password/);
  });

  it('recognises the shape it forbids', () => {
    expect(nonLiteralFetches("await fetch(userUrl, { method: 'GET' })")).toEqual([1]);
    expect(nonLiteralFetches('await fetch(`${base}/events`)')).toEqual([1]);
    // A fixed host is not this rule's business.
    expect(nonLiteralFetches("await fetch('https://api.openai.com/v1/x')")).toEqual([]);
    expect(nonLiteralFetches('await fetch(`https://api.seatgeek.com/2/events?${p}`)')).toEqual([]);
  });

  it('recognizes only configured auth transports, and fails when their wiring is mutated', () => {
    for (const file of AUTH_TRANSPORTS) {
      const source = readFileSync(file, 'utf8');
      expect(configuredAuthFetchLines(file, source).size, file).toBe(1);
      const replacedHost = source.replace('process.env.NEXT_PUBLIC_SUPABASE_URL', 'userChosenUrl');
      expect(configuredAuthFetchLines(file, replacedHost).size, `${file}: user-chosen project`).toBe(0);
      const replacedTarget = source.replace(/fetch\((input|url),/, 'fetch(userChosenUrl,');
      expect(configuredAuthFetchLines(file, replacedTarget).size, `${file}: bypassed transport`).toBe(0);
      const sibling = `${source}\nfetch(userChosenUrl);`;
      const recognized = configuredAuthFetchLines(file, sibling);
      expect(nonLiteralFetches(sibling).filter(line => !recognized.has(line)), `${file}: new sibling fetch`).toHaveLength(1);
    }
  });

  it('does not recognize recovery requests with an origin or redirect boundary removed', () => {
    const file = 'lib/auth/recovery-server.ts';
    const source = readFileSync(file, 'utf8');
    expect(configuredAuthFetchLines(file, source.replace('url.origin !== config.origin', 'false')).size).toBe(0);
    expect(configuredAuthFetchLines(file, source.replace("redirect: 'manual'", "redirect: 'follow'")).size).toBe(0);
  });

  it('does not recognize callback requests after origin, endpoint, caller or redirect guards are weakened', () => {
    const file = 'lib/auth/callback-server.ts';
    const source = readFileSync(file, 'utf8');
    for (const mutated of [
      source.replace('url.origin !== origin', 'false'),
      source.replace("!url.pathname.startsWith('/rest/v1/')", 'false'),
      source.replace("throw new Error('Unexpected callback endpoint');", '{}'),
      source.replace('boundedFetch(origin, controller.signal)', 'boundedFetch(userChosenUrl, controller.signal)'),
      source.replace("redirect: 'manual'", "redirect: 'follow'"),
      source.replace("redirect: 'manual', cache: 'no-store', signal: requestSignal", "redirect: 'manual', cache: 'no-store', signal: requestSignal, ...init"),
    ]) expect(configuredAuthFetchLines(file, mutated).size).toBe(0);
  });
});
