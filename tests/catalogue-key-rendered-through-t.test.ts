// A catalogue KEY must reach the screen through t(), not as itself.
//
// WHY THIS EXISTS, and why the test next door did not catch it.
// tests/catalogue-key-not-rendered-raw.test.ts flags a key-shaped value only
// where the SAME array also holds real copy — "one of these is not like the
// others". That is deliberate and it is blind in exactly one direction: when
// EVERY value in the field is a key, the array is internally consistent and it
// reports nothing, however the render site treats them.
//
// Both halves of that blind spot were live:
//
//   * components/marketing/ai-showcase.tsx rendered `{d.prompt}` and
//     `{demo.prompt}` while its neighbours `reply`, `title` and `meta` all went
//     through tr(). The /ai page printed
//     "aiShowcase.addSoccerPracticeEveryTuesday" — a forty-character word with
//     no space in it — and blew the page 91px past a 320px viewport. The E2E
//     overflow spec caught that, on ten device projects, which is a slow and
//     indirect way to learn that a key was printed.
//   * app/(marketing)/pricing/pricing-content.tsx rendered `{item}` for every
//     plan-card bullet, so www.bubaly.com/pricing has been showing
//     "pricingContent.sharedFamilyCalendar" to everyone, in every language.
//
// So this asks the narrower question the other test cannot: for a field whose
// values are ALL keys the catalogue actually has, is there a render site in the
// same file that prints it with no call around it?
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import enUS from '@/lib/i18n/messages/en-US.json';

const ROOT = process.cwd();
const CATALOGUE = new Set(Object.keys(enUS as Record<string, string>));

const IGNORE_DIRS = new Set([
  'node_modules', '.next', '.git', 'out', 'dist', 'coverage',
  'test-results', 'playwright-report', 'ios', 'android', 'mobile', 'tests',
]);

/** `word.word` or deeper, no spaces — the shape of a catalogue key. */
const KEY_SHAPED = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // Dot-directories are tooling. `.claude/worktrees` holds whole checkouts of
    // this repo, and walking into one reports every file in it a second time.
    if (entry.startsWith('.') || IGNORE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

export type RawRender = { file: string; declaration: string; field: string; rendered: string };

/** The `const NAME = [ … ]` blocks in a file, by name, with their spans. */
function arrayDeclarations(source: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  for (const m of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*\[/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '[') depth += 1;
      else if (source[i] === ']') { depth -= 1; if (depth === 0) { out.push({ name: m[1], body: source.slice(open, i) }); break; } }
    }
  }
  return out;
}

/**
 * A key printed where a person can read it.
 *
 * SCOPED TO THE DECLARATION, not the file — the same lesson the sibling test
 * writes down. Judged per file, `title` in pricing-content.tsx is "all keys"
 * because one array declares it that way, and the case-study card's
 * `{study.title}` — a row out of the database — gets reported for it. So a
 * render only counts when its identifier traces back to the array that made the
 * field key-carrying: bound by `NAME.map((x) =>` or read as `NAME[i]`.
 *
 * `key={d.prompt}` is not a render — React never shows it — so an expression in
 * ATTRIBUTE position (the character before `{` is `=`) is never reported.
 */
export function rawKeyRenders(source: string, catalogue: Set<string>): Omit<RawRender, 'file'>[] {
  const out: Omit<RawRender, 'file'>[] = [];

  for (const { name, body } of arrayDeclarations(source)) {
    const values = new Map<string, string[]>();
    for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*'([^'\\\n]+)'/g)) {
      values.set(m[1], [...(values.get(m[1]) ?? []), m[2]]);
    }
    // A property holding an array of strings: `items: ['a', 'b']`.
    const nested = new Set<string>();
    for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*\[([^\]]*)\]/g)) {
      const inner = [...m[2].matchAll(/'([^'\\\n]+)'/g)].map((v) => v[1]);
      if (!inner.length) continue;
      nested.add(m[1]);
      values.set(m[1], [...(values.get(m[1]) ?? []), ...inner]);
    }

    // Identifiers that hold one element of THIS array.
    const holders = new Set<string>();
    for (const m of source.matchAll(new RegExp(`\\b${name}\\.map\\(\\(\\s*([A-Za-z_$][\\w$]*)`, 'g'))) holders.add(m[1]);
    for (const m of source.matchAll(new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*=\\s*${name}\\[`, 'g'))) holders.add(m[1]);

    for (const [field, vals] of values) {
      // Two or more, every one a key the catalogue actually has. One value
      // proves nothing, and a key-SHAPED string the catalogue lacks is some
      // other kind of identifier.
      if (vals.length < 2) continue;
      if (!vals.every((v) => KEY_SHAPED.test(v) && catalogue.has(v))) continue;

      for (const holder of holders) {
        for (const m of source.matchAll(new RegExp(`(?<![=])\\{\\s*${holder}\\.${field}\\s*\\}`, 'g'))) {
          void m;
          out.push({ declaration: name, field, rendered: `{${holder}.${field}}` });
        }
      }
      // `something.items.map((item) => … {item} …)` — the loop variable over a
      // key-carrying nested array, wherever that array reaches the component.
      if (!nested.has(field)) continue;
      for (const m of source.matchAll(new RegExp(`\\.${field}\\.map\\(\\(\\s*([A-Za-z_$][\\w$]*)\\s*[,)]`, 'g'))) {
        const param = m[1];
        for (const hit of source.matchAll(new RegExp(`(?<![=])\\{\\s*${param}\\s*\\}`, 'g'))) {
          void hit;
          out.push({ declaration: name, field, rendered: `{${param}} from .${field}.map()` });
        }
      }
    }
  }
  return out;
}

describe('catalogue keys reach the screen through t()', () => {
  it('finds a raw render in a sample the other test would call consistent', () => {
    const sample = `
      const DEMOS = [
        { prompt: 'aiShowcase.addSoccerPracticeEveryTuesday' },
        { prompt: 'aiShowcase.planDinnersForThisWeek' },
      ];
      const x = DEMOS.map((d) => <span key={d.prompt}>{d.prompt}</span>);
    `;
    const found = rawKeyRenders(sample, CATALOGUE);
    // The key={} is not reported; the visible one is.
    expect(found).toEqual([{ declaration: 'DEMOS', field: 'prompt', rendered: '{d.prompt}' }]);
  });

  it('renders no catalogue key raw anywhere', () => {
    const offenders: RawRender[] = [];
    for (const file of walk(ROOT)) {
      const rel = file.slice(ROOT.length + 1);
      for (const hit of rawKeyRenders(readFileSync(file, 'utf8'), CATALOGUE)) {
        offenders.push({ file: rel, ...hit });
      }
    }
    expect(
      offenders,
      'these print a catalogue key where a person can read it — wrap the render in t()',
    ).toEqual([]);
  });
});
