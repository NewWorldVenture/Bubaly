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
const SERVER_MODULES = SOURCES.filter(([, text]) => /^['"]use server['"];?\s*$/m.test(text.split('\n')[0] ?? ''));

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

  it.each(SERVER_MODULES.map(([file]) => relative(process.cwd(), file)))(
    '%s',
    (relative) => {
      const text = readFileSync(join(process.cwd(), relative), 'utf8');
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
      expect(offenders).toEqual([]);
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
  });
});
