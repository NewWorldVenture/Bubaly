import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? tsxFiles(path) : path.endsWith('.tsx') ? [path] : [];
  });
}

// M-028: every <video> element must carry playsInline. Without it, iOS Safari
// hijacks playback into the native fullscreen player (breaking lightbox/live
// preview UX); the photos lightbox video was missing it (camera-capture already
// had it). This walks all rendered .tsx and asserts no <video ...> opening tag
// lacks a playsInline attribute.
describe('all <video> elements are playsInline (M-028)', () => {
  it('has zero <video> tags without playsInline in app/ + components/', () => {
    const offenders: string[] = [];
    for (const path of tsxFiles('app').concat(tsxFiles('components'))) {
      // Strip line + block comments so prose like "live <video>, and…" can't flag.
      const src = readFileSync(path, 'utf8')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      // Match each <video ...> opening tag (multi-line) and check its attributes.
      for (const m of src.matchAll(/<video\b[^>]*>/gs)) {
        if (!m[0].includes('playsInline')) offenders.push(`${path}: ${m[0].slice(0, 60)}…`);
      }
    }
    expect(offenders, `videos missing playsInline:\n${offenders.join('\n')}`).toEqual([]);
  });
});
