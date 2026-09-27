import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// An icon-only button has no text node, so the icon IS the name — and an <svg>
// from lucide-react carries none. A screen reader reads "button", twice, and one
// of the two found by this scan deleted a guardian contact.
//
// The overall result is good: two unnamed controls out of several hundred icon
// buttons, which is why this is a guard rather than a campaign. It exists so the
// third one is caught when it is written rather than in the next audit.
//
// House pattern: components/modules/devices-module.tsx:97-98 —
//   <button … aria-label={tr('devices.edit')}><Pencil className="h-4 w-4" /></button>

const ROOTS = ['app', 'components'];

// A button is NAMED if it carries any of these, or if its body has a text node.
const NAMING_ATTRS = /\b(aria-label|aria-labelledby|title)=/;
// Text that reaches the accessibility tree: a bare word, a {t('…')} call, or an
// sr-only span.
const HAS_TEXT = /sr-only|\{\s*(t|tr|tt)\s*\(|>[^<>{}]*[A-Za-z0-9][^<>{}]*</;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx$/.test(entry)) out.push(path);
  }
  return out;
}

/** Every `<button …>…</button>` written on ONE line, with its line number. */
function singleLineButtons(source: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  source.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/<button\b[^>]*>.*?<\/button>/g)) {
      found.push({ line: index + 1, text: match[0] });
    }
  });
  return found;
}

describe('an icon-only button carries a name', () => {
  const files = ROOTS.flatMap((root) => walk(root));

  it('scans enough of the tree for the assertion below to mean something', () => {
    expect(files.length).toBeGreaterThan(300);
    const buttons = files.flatMap((f) => singleLineButtons(readFileSync(f, 'utf8')));
    expect(buttons.length).toBeGreaterThan(100);
  });

  it('finds no button whose only content is an icon and whose only name is nothing', () => {
    const unnamed: string[] = [];
    for (const file of files) {
      for (const { line, text } of singleLineButtons(readFileSync(file, 'utf8'))) {
        if (NAMING_ATTRS.test(text)) continue;
        const body = text.slice(text.indexOf('>') + 1, text.lastIndexOf('</button>'));
        // Only flag a body that is nothing but self-closing element(s) — an
        // icon. A body with any text, or an interpolation that could be text,
        // is out of scope for this guard.
        const iconsOnly = body.trim().length > 0
          && /^(\s*<[A-Z][A-Za-z0-9]*\b[^>]*\/>\s*)+$/.test(body)
          && !HAS_TEXT.test(body);
        if (iconsOnly) unnamed.push(`${file}:${line}`);
      }
    }
    expect(unnamed).toEqual([]);
  });
});
