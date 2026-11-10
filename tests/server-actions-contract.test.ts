import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', 'supabase', 'mobile']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const SOURCES = walk(process.cwd()).map((file) => [file, readFileSync(file, 'utf8')] as const);

// The directive is the module's first STATEMENT, not necessarily its first
// line: many action files open with a comment header explaining themselves, and
// Next treats those as server modules all the same.
function firstStatementLine(text: string): string {
  let rest = text;
  for (;;) {
    rest = rest.trimStart();
    if (rest.startsWith('//')) {
      const end = rest.indexOf('\n');
      rest = end === -1 ? '' : rest.slice(end);
    } else if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      rest = end === -1 ? '' : rest.slice(end + 2);
    } else return rest.split('\n')[0] ?? '';
  }
}
const isServerModule = (text: string) => /^['"]use server['"];?\s*$/m.test(firstStatementLine(text));
const SERVER_MODULES = SOURCES.filter(([, text]) => isServerModule(text));

// The one guard. The per-module cases and the canary both go through it, so a
// pattern that drifts cannot keep the canary green.
function offendingExports(text: string): string[] {
  const offenders: string[] = [];
  for (const line of text.split('\n')) {
    // `export type` / `export interface` are erased before the module
    // reaches the runtime, so they are not exports in the sense that
    // matters here.
    if (/^export\s+(type|interface)\b/.test(line)) continue;
    if (/^export\s+async\s+function\s/.test(line)) continue;
    if (/^export\s+(function|const|let|var|class)\s/.test(line)) offenders.push(line.trim());
    else if (/^export\s*\{/.test(line)) offenders.push(line.trim());
  }
  return offenders;
}

describe("a 'use server' module may only export async functions", () => {
  // Next.js refuses to build a 'use server' file that exports anything else —
  // its exports become HTTP endpoints and the framework has no way to expose a
  // synchronous one. Typecheck does not catch it; the build does, after CI has
  // already spent several minutes getting there.
  //
  // Found the hard way: the recurring-ads actions module exported two pure
  // string parsers. They belonged in lib/ anyway, for the same reason the
  // rule exists — a parser has no business being an endpoint.
  it('finds the server modules to check', () => {
    expect(SERVER_MODULES.length).toBeGreaterThan(50);
  });

  it('finds a server module whose directive follows a comment header', () => {
    const found = SERVER_MODULES.map(([file]) => relative(process.cwd(), file).split('\\').join('/'));
    for (const file of ['app/(app)/dashboard/calendar/actions.ts', 'app/(app)/dashboard/billing/actions.ts', 'app/(app)/dashboard/meals/actions.ts']) {
      expect(found, file).toContain(file);
    }
    // Every first-line module is still found, and the header-comment ones come on top.
    const firstLine = SOURCES.filter(([, text]) => /^['"]use server['"];?\s*$/m.test(text.split('\n')[0] ?? ''));
    for (const [file] of firstLine) expect(SERVER_MODULES.map(([f]) => f), file).toContain(file);
    expect(SERVER_MODULES.length).toBeGreaterThan(firstLine.length);
    expect(isServerModule("// why this file exists\n/* and\n more */\n\n'use server';\n\nexport async function a() {}\n")).toBe(true);
    // A comment that mentions the directive, or one inside a function body, is not a module directive.
    expect(isServerModule("// a 'use server' module is an endpoint\nimport { x } from './x';\n")).toBe(false);
    expect(isServerModule("import { x } from './x';\nexport async function a() {\n  'use server';\n}\n")).toBe(false);
  });

  it.each(SERVER_MODULES.map(([file]) => relative(process.cwd(), file)))(
    '%s',
    (relative) => {
      const text = readFileSync(join(process.cwd(), relative), 'utf8');
      expect(offendingExports(text)).toEqual([]);
    },
  );

  it('recognises the shape it is policing', () => {
    // A guard whose pattern never matches passes for every file forever.
    const bad = ['export function parseTimesOfDay(input: string) {', 'export const X = 1;', 'export { helper };'];
    const good = ['export async function doThing() {', 'export type Result = { ok: true };', 'export interface X {}'];
    const offends = (line: string) => !/^export\s+(type|interface)\b/.test(line)
      && !/^export\s+async\s+function\s/.test(line)
      && (/^export\s+(function|const|let|var|class)\s/.test(line) || /^export\s*\{/.test(line));
    expect(bad.filter(offends)).toEqual(bad);
    expect(good.filter(offends)).toEqual([]);
    // …and the guard the modules are actually held to agrees, line for line.
    expect(offendingExports(bad.join('\n'))).toEqual(bad);
    expect(offendingExports(good.join('\n'))).toEqual([]);
    expect(offendingExports(["'use server';", ...good, ...bad].join('\n'))).toEqual(bad);
  });
});
