import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const src = readFileSync(join(ROOT, 'app/(marketing)/blog/[slug]/share-buttons.tsx'), 'utf8');

describe('blog share bar', () => {
  it('uses the X logo, not the legacy Twitter bird', () => {
    expect(src).toMatch(/const XIcon =/);
    // must NOT import or render the lucide Twitter (bird) icon
    expect(src).not.toMatch(/from 'lucide-react'[^\n]*Twitter/);
    expect(src).not.toMatch(/<Twitter[\s/>]/);
    // X share intent still targets the X/Twitter posting endpoint
    expect(src).toMatch(/x\.com\/intent\/tweet/);
  });

  it('lists the most popular social networks', () => {
    for (const net of ['Facebook', 'LinkedIn', 'WhatsApp', 'Reddit', 'Pinterest', 'Telegram']) {
      expect(src).toContain(net);
    }
    // canonical share endpoints are wired
    expect(src).toMatch(/facebook\.com\/sharer/);
    expect(src).toMatch(/linkedin\.com\/sharing/);
    expect(src).toMatch(/wa\.me/);
    expect(src).toMatch(/reddit\.com\/submit/);
    expect(src).toMatch(/pinterest\.com\/pin\/create/);
    expect(src).toMatch(/t\.me\/share/);
    expect(src).toMatch(/mailto:/);
  });

  it('keeps copy-link and opens shares safely in a new tab', () => {
    expect(src).toMatch(/navigator\.clipboard\.writeText/);
    expect(src).toMatch(/rel="noopener noreferrer"/);
    expect(src).toMatch(/target="_blank"/);
  });
});

// Audit C1-S9-95 — found by the page audit crawl: every blog post raised a
// hydration mismatch (React #418) because the share links were built from
// `window.location.origin` in the browser and a hard-coded host on the server.
// The address now comes from canonicalUrl on both sides, so there is one href.
describe('share links are the same on the server and in the browser (C1-S9-95)', () => {
  it('builds the shared address from the canonical URL, not the current origin', () => {
    // Comments stripped: the component's own note quotes the old expression.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/window\.location/);
    expect(src).toContain('canonicalUrl(`/blog/${slug}`)');
    expect(src).toContain('navigator.clipboard.writeText(url)');
  });
});
