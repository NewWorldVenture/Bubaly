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
