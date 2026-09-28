// INTEGRATION-maps.google.com: the contacts "open in Maps" button and the
// profile's "Rate the app" row opened an external site with
// window.open(url, '_blank') and no 'noopener', so that page received
// window.opener, a handle to the Bubaly tab (reverse tabnabbing). Links carry
// rel="noreferrer"; a scripted open has to say it in its third argument.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('an external tab gets no handle back', () => {
  it('every window.open of an external page into a new tab says noopener', () => {
    const offenders: string[] = [];
    for (const file of [...files('app'), ...files('components'), ...files('lib')]) {
      for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        if (/window\.open\(\s*[`'"]https?:/.test(line) && !/noopener/.test(line)) offenders.push(`${file}:${index + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
