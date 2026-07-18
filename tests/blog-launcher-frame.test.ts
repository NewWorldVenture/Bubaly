import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config.mjs';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

type HeaderRule = { source: string; headers: { key: string; value: string }[] };
const xfo = (r: HeaderRule) => r.headers.find((h) => h.key === 'X-Frame-Options')?.value;

describe('blog launcher — same-origin framing scoped to the public blog only', () => {
  it('serves the public blog with SAMEORIGIN (so the in-app modal can embed it)', async () => {
    const rules = (await nextConfig.headers!()) as HeaderRule[];
    const blogRules = rules.filter((r) => r.source === '/blog' || r.source === '/blog/:path*');
    expect(blogRules.length).toBe(2);
    for (const r of blogRules) expect(xfo(r)).toBe('SAMEORIGIN');
  });

  it('keeps X-Frame-Options: DENY everywhere except the blog', async () => {
    const rules = (await nextConfig.headers!()) as HeaderRule[];
    const denyRule = rules.find((r) => xfo(r) === 'DENY');
    expect(denyRule).toBeTruthy();
    // The DENY rule must exclude blog paths via negative lookahead.
    expect(denyRule!.source).toContain('(?!blog)');
    // And no rule may DENY the blog.
    for (const r of rules) {
      if (r.source === '/blog' || r.source === '/blog/:path*') expect(xfo(r)).not.toBe('DENY');
    }
  });

  it('still applies the common security headers to every route', async () => {
    const rules = (await nextConfig.headers!()) as HeaderRule[];
    const all = rules.find((r) => r.source === '/(.*)');
    expect(all).toBeTruthy();
    const keys = all!.headers.map((h) => h.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy', 'Strict-Transport-Security',
      ]),
    );
  });
});

describe('blog launcher — header button + embedded modal', () => {
  const launcher = read('components/app/blog-launcher.tsx');
  const shell = read('components/app/app-shell.tsx');

  it('embeds the blog same-origin and offers an open-in-new-tab fallback', () => {
    expect(launcher).toMatch(/<iframe[\s\S]*src=\{BLOG_URL\}/);
    expect(launcher).toMatch(/const BLOG_URL = '\/blog'/);
    expect(launcher).toMatch(/target="_blank"/);
  });

  it('is an accessible dialog that closes on Escape', () => {
    expect(launcher).toMatch(/role="dialog"/);
    expect(launcher).toMatch(/aria-modal="true"/);
    expect(launcher).toMatch(/e\.key === 'Escape'/);
  });

  it('uses theme tokens so the icon adapts to light + dark', () => {
    expect(launcher).toMatch(/text-muted/);
    expect(launcher).toMatch(/hover:text-fg/);
  });

  it('is mounted in the app header', () => {
    expect(shell).toMatch(/import \{ BlogLauncher \} from '\.\/blog-launcher'/);
    expect(shell).toMatch(/<BlogLauncher \/>/);
  });
});
