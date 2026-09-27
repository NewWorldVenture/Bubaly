// Page audit, signed-in sweep — an old route is one HTTP redirect, not a page
// that redirects after the app has started drawing.
//
// /parent, /admin/tiers and three consolidated dashboard routes were pages whose
// only line was redirect(). Inside the signed-in app that runs after
// app/(app)/loading.tsx has already streamed the shell, so it answered 200, the
// sidebar mounted and started its reads, and the "redirect" was a client-side
// navigation that cut them off ("[sidebar] preference read failed: Failed to
// fetch" on each). next.config.mjs now answers them with a 308 before anything
// renders, and a page whose whole job is to redirect is not allowed back.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ALIASES: [string, string][] = [
  ['/parent', '/dashboard/family-operations'],
  ['/admin/tiers', '/admin/tier-features'],
  ['/dashboard/family-ai-assistant', '/dashboard/assistant'],
  ['/dashboard/family-knowledge-graph', '/dashboard/graph'],
  ['/dashboard/family-memory', '/dashboard/memories'],
];

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? pages(p) : entry === 'page.tsx' ? [p] : [];
  });
}

describe('old routes are config redirects', () => {
  it('each alias is a permanent redirect in next.config.mjs', async () => {
    const { default: config } = await import('../next.config.mjs');
    expect(config.redirects, 'next.config.mjs defines redirects()').toBeTypeOf('function');
    const redirects = await config.redirects!();
    for (const [source, destination] of ALIASES) {
      expect(redirects, source).toContainEqual({ source, destination, permanent: true });
    }
  });

  it('no page in the signed-in app exists only to call redirect()', () => {
    const onlyRedirects = pages(join('app', '(app)')).filter((file) => {
      const body = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const fn = /export default (?:async )?function \w*\([^)]*\)\s*\{([\s\S]*)\}\s*$/.exec(body)?.[1] ?? '';
      return /^\s*redirect\([^)]*\);?\s*$/.test(fn);
    });
    expect(onlyRedirects, 'move the alias into next.config.mjs redirects()').toEqual([]);
  });
});
