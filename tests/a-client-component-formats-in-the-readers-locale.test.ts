// B8 page audit (the signed-in pages in ten locales): /dashboard/social/accounts/connect
// failed hydration (React #418) in German and Spanish. `def.charLimit.toLocaleString()`
// with no locale drew "2,200" on the server (Node's default, en-US) and "2.200"
// in the browser, so the text the server sent was not the text the client drew.
// Any bare toLocaleString / toLocaleDateString / toLocaleTimeString in a client
// component does the same the moment a number reaches 1,000 or a date renders —
// and dates also take the browser's time zone. `useFormat()` binds the formatters
// to the reader's locale on both sides. This holds every client component to it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const BARE = /\.toLocale(?:String|DateString|TimeString)\(\)/;

describe('a client component formats numbers and dates in the reader\'s locale', () => {
  const clients = [...walk('app'), ...walk('components')]
    .filter((f) => /^\s*['"]use client['"]/.test(readFileSync(f, 'utf8')));

  it('finds the client components (a scan that finds none proves nothing)', () => {
    expect(clients.length).toBeGreaterThan(300);
  });

  it('none calls toLocaleString / toLocaleDateString / toLocaleTimeString with no locale', () => {
    const offenders: string[] = [];
    for (const f of clients) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/^\s*(\*|\/\*)/.test(line)) return; // prose in a block comment
        if (BARE.test(code)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
