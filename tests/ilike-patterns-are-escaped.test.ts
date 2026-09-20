import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { escapeLike } from '../lib/supabase/escape-like';

// `%` and `_` are LIKE/ILIKE wildcards, so an interpolated value is matched as a
// PATTERN unless it is escaped. This repository has shipped that defect twice —
// child sign-in (a guessable username widened the throttle budget) and inbound
// email routing (a sender's own `To` header reaching another family's inbox) —
// and BOTH fixes were local, so neither reached the next call site. Four
// identical private `escapeLike` helpers and two inline `.replace(/[%_]/g, …)`
// expressions existed; six call sites still interpolated raw.
//
// That is why the rule is enforced here rather than remembered: one helper, used
// at the call site, checked by a test that fails naming the file.

const ROOT = join(__dirname, '..');

// Patterns built from a CONSTANT, not from user input, have nothing to escape.
// Each exemption names why. A new entry here is a deliberate claim that the
// interpolated value cannot come from a user.
const CONSTANT_PATTERNS: Record<string, string> = {
  'lib/services/memory/index.ts': 'AI_SIGNATURE_PREFIX is a module constant, not user input',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

/**
 * Every `.ilike(...)` / `.like(...)` whose pattern is a BARE EXPRESSION — no
 * backticks, no quotes — e.g. `.ilike('email', email)`.
 *
 * The interpolating matcher below cannot see these: it requires a template
 * literal. That blind spot was not theoretical. `.ilike('email', email)` on
 * `crm_contacts` ran as the service role past admin-only RLS and chose the row a
 * following update OVERWROTE, and `.ilike('category', term)` in meals, finances
 * and the digital twin took a raw user search term. None was matched by the rule
 * above; all are matched by this one.
 */
function bareValueCalls() {
  const hits: { file: string; text: string }[] = [];
  for (const dir of ['app', 'lib']) {
    for (const abs of walk(join(ROOT, dir))) {
      const src = readFileSync(abs, 'utf8');
      // second argument starts with neither a quote nor a backtick
      for (const m of src.matchAll(/\.(i?like)\(\s*(?:'[^']*'|"[^"]*"),\s*([^`'"\s)][^)]*?)\)/g)) {
        const line = src.slice(src.lastIndexOf('\n', m.index ?? 0) + 1, m.index).trimStart();
        if (line.startsWith('*') || line.startsWith('//')) continue;
        hits.push({ file: relative(ROOT, abs).split(sep).join('/'), text: m[0] });
      }
    }
  }
  return hits;
}

/** Every `.ilike(...)` / `.like(...)` whose pattern interpolates something. */
function interpolatingCalls() {
  const hits: { file: string; text: string }[] = [];
  for (const dir of ['app', 'lib']) {
    for (const abs of walk(join(ROOT, dir))) {
      const src = readFileSync(abs, 'utf8');
      for (const m of src.matchAll(/\.(i?like)\(\s*(?:'[^']*'|"[^"]*"),\s*`[^`]*\$\{[^`]*`\s*\)/g)) {
        const text = m[0];
        // A doc comment showing the shape is not a call site.
        const line = src.slice(src.lastIndexOf('\n', m.index ?? 0) + 1, m.index).trimStart();
        if (line.startsWith('*') || line.startsWith('//')) continue;
        hits.push({ file: relative(ROOT, abs).split(sep).join('/'), text });
      }
    }
  }
  return hits;
}

describe('every ILIKE pattern built from a value escapes its wildcards', () => {
  it('finds call sites at all (guards the guard)', () => {
    // A matcher that silently found nothing would make the rule below vacuous —
    // this repository's signature defect.
    expect(interpolatingCalls().length).toBeGreaterThan(5);
  });

  it('uses the shared helper at the call site', () => {
    for (const { file, text } of interpolatingCalls()) {
      if (CONSTANT_PATTERNS[file]) continue;
      expect(
        text.includes('escapeLike('),
        `${file} interpolates into an ILIKE pattern without escapeLike(): ${text.trim()}`,
      ).toBe(true);
    }
  });

  it('finds bare-value call sites at all (guards the guard)', () => {
    expect(bareValueCalls().length).toBeGreaterThan(5);
  });

  it('escapes a pattern passed as a bare value, not just an interpolated one', () => {
    for (const { file, text } of bareValueCalls()) {
      if (CONSTANT_PATTERNS[file]) continue;
      expect(
        text.includes('escapeLike('),
        `${file} passes a value straight into an ILIKE pattern without escapeLike(): ${text.trim()}`,
      ).toBe(true);
    }
  });

  it('escapes exactly once — never a pre-escaped value', () => {
    // Escaping twice turns `50\%` into `50\\\%`, which LIKE reads as a literal
    // backslash then a literal percent, so the row stops matching at all.
    // Verified in Postgres 16: ilike '%50\% off groceries%' -> t,
    // ilike '%50\\\% off groceries%' -> f.
    const doubled = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib'))]
      .filter((f) => /replace\(\/\[%_\]\/g/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f).split(sep).join('/'))
      .filter((f) => f !== 'lib/supabase/escape-like.ts');
    expect(doubled, 'a hand-rolled wildcard escape remains; escapeLike() on top of it escapes twice').toEqual([]);
  });

  it('keeps exactly one definition of the helper', () => {
    // Four private copies are why two previous fixes did not propagate.
    const defs = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib'))]
      .filter((f) => /function escapeLike\s*\(|const escapeLike\s*=/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f).split(sep).join('/'));
    expect(defs).toEqual(['lib/supabase/escape-like.ts']);
  });

  it('escapes the wildcards, and the escape character itself', () => {
    expect(escapeLike('smit_')).toBe('smit\\_');
    expect(escapeLike('50%')).toBe('50\\%');
    expect(escapeLike('a_b%c')).toBe('a\\_b\\%c');
    // Without this a value ending in a backslash would escape the closing quote
    // of the pattern rather than a wildcard.
    expect(escapeLike('back\\slash')).toBe('back\\\\slash');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeLike('Weekly shop')).toBe('Weekly shop');
    expect(escapeLike('')).toBe('');
  });
});
