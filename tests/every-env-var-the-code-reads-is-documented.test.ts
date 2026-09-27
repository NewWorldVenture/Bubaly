import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * F-C07: every environment variable the app reads is named in .env.example.
 *
 * The code read 88 variables and .env.example documented 82 of a different
 * set, leaving nineteen undocumented. The sharpest was
 * CONTACT_CENTER_INBOUND_SECRET: the inbound-email endpoint is correctly
 * fail-closed in production, so with it unset every inbound message was
 * rejected — silently, with nothing anywhere saying why. Apple calendar sync
 * was simply off until someone read lib/sync/providers/apple.ts.
 *
 * They are all documented now, each with what breaks when it is unset. This
 * keeps it that way: a new `process.env.X` fails here until .env.example
 * mentions X — as a real entry, or under "Set by the platform" for the ones
 * Node, Next.js and Vercel provide.
 */

const ROOTS = ['app', 'lib', 'components'];
const EXT = /\.(ts|tsx|mjs|js)$/;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (EXT.test(entry)) out.push(p);
  }
  return out;
}

const readByCode = new Set<string>();
for (const root of ROOTS) {
  for (const f of files(root)) {
    for (const m of readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) readByCode.add(m[1]);
  }
}
const example = readFileSync('.env.example', 'utf8');

describe('.env.example names every variable the code reads', () => {
  it('found the variables to check', () => {
    expect(readByCode.size).toBeGreaterThan(50);
  });

  it('leaves none undocumented', () => {
    const missing = [...readByCode].filter((name) => !new RegExp(`\\b${name}\\b`).test(example)).sort();
    expect(missing, 'read by the app but absent from .env.example').toEqual([]);
  });

  it('says what happens when the sharpest one is unset', () => {
    // The fail-closed secret is the one whose absence is silent; its entry has
    // to say so, or documenting it changes nothing.
    const entry = example.slice(example.indexOf('# ---- Contact center'), example.indexOf('CONTACT_CENTER_INBOUND_SECRET='));
    expect(entry).toMatch(/rejects EVERY inbound message/);
  });
});
