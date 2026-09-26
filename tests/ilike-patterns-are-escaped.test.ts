import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { escapeLike, escapeOrValue } from '../lib/supabase/escape-like';

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

/**
 * A hand-rolled escape of the LIKE wildcards: a character class holding both `%`
 * and `_`, with a replacement that backslash-QUOTES rather than removes. The
 * second half is what keeps a strip (a different, legitimate strategy) out.
 */
const PRIVATE_ESCAPE = /replace\(\s*\/\[[^\]]*%[^\]]*_[^\]]*\]\/g\s*,[^\n]*\\\\/;

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

/**
 * Every `.or(...)` whose expression interpolates into an `ilike.` fragment.
 *
 * Both scanners above require `.ilike(column, pattern)` — a METHOD, whose pattern
 * is its own query parameter. `.or(filter)` is not that. It sends one string in
 * PostgREST's filter grammar, so a search written as
 * `` .or(`feature.ilike.${like},error.ilike.${like}`) `` is invisible to both,
 * and the repository's one documented rule is not enough for it anyway:
 * `escapeLike` quotes `%` and `_` and leaves `,` `(` `)`, which are not LIKE
 * characters — they are the or-grammar's own punctuation. Follow the rule
 * faithfully here and the filter is still splittable.
 *
 * Narrowed to `ilike.` on purpose. Every other `.or()` in this repository
 * interpolates a UUID or a timestamp from server context — a member id, a cursor
 * validated against a UUID regex before it becomes one, `new Date().toISOString()`
 * — and demanding a text sanitiser there would be asserting something untrue. An
 * `ilike` fragment inside an or-expression is a text search by construction, and
 * a text search takes a person's typing by construction.
 */
function orIlikeFiles(): string[] {
  const files = new Set<string>();
  for (const dir of ['app', 'lib']) {
    for (const abs of walk(join(ROOT, dir))) {
      const src = readFileSync(abs, 'utf8');
      if (/\.or\(\s*`[^`]*i?like\.[^`]*\$\{[^`]*`/.test(src)) files.add(relative(ROOT, abs).split(sep).join('/'));
    }
  }
  return [...files];
}

describe('an ILIKE inside an or() needs more than escapeLike', () => {
  it('finds the call site at all (guards the guard)', () => {
    // One today. A scanner that found none would make the rule below vacuous,
    // and would keep doing so as the second one is added.
    expect(orIlikeFiles().length).toBeGreaterThan(0);
  });

  it('escapes the grammar as well as the wildcards', () => {
    const offenders = orIlikeFiles().filter((f) => !/escapeOrValue\s*[<(]/.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(
      offenders,
      'these build an ILIKE pattern inside an or() expression. escapeLike alone '
      + 'leaves `,` `(` `)` — the or-grammar\'s separators — so a term carrying one '
      + 'either breaks the filter (PostgREST 400) or adds a disjunct that matches '
      + 'every row. Use escapeOrValue from @/lib/supabase/escape-like:\n'
      + offenders.map((o) => `  ${o}`).join('\n'),
    ).toEqual([]);
  });

  it('matches escapeOrValue through a generic argument too', () => {
    // `readAll(` vs `readAll<Row>(` cost this audit two wrong sweeps. The
    // pattern is `\s*[<(]` by construction rather than by luck.
    expect(/escapeOrValue\s*[<(]/.test('const term = escapeOrValue(filters.q ?? \'\');')).toBe(true);
    expect(/escapeOrValue\s*[<(]/.test('escapeOrValue<T>(x)')).toBe(true);
    expect(/escapeOrValue\s*[<(]/.test('// escapeOrValue is not called here')).toBe(false);
  });

  it('sees an or-ilike call site and not an ordinary or()', () => {
    // The narrowing is the claim, so it is checked: a member-id disjunct must
    // NOT be demanded to sanitise text it never carries.
    const matcher = /\.or\(\s*`[^`]*i?like\.[^`]*\$\{[^`]*`/;
    expect(matcher.test('query.or(`feature.ilike.${like},error.ilike.${like}`)')).toBe(true);
    expect(matcher.test('.or(memberId ? `member_id.is.null,member_id.eq.${memberId}` : \'member_id.is.null\')')).toBe(false);
    expect(matcher.test('.or(`expires_at.is.null,expires_at.gt.${now.toISOString()}`)')).toBe(false);
  });
});

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

  it('keeps no private copy under another NAME either', () => {
    // A fifth copy did exist and this file could not see it. `safeSearchTerm` in
    // lib/ai/activity.ts escaped the same wildcards under a name the scan above
    // does not look for, and one character away from the scan below it —
    // `replace(/[\\%_]/g` rather than `replace(/[%_]/g`. So the rule is about the
    // ESCAPE, not about what it was called.
    //
    // It is about the escape SPECIFICALLY, and that distinction was earned: the
    // first draft of this scan matched any character class containing % and _,
    // and its first finding was a false accusation. lib/services/search/index.ts
    // NEUTRALISES those characters — `replace(/[%_,()"\\]/g, ' ')` — which is a
    // different and perfectly good strategy for a search box, already the single
    // definition for that service, and nothing escape-like.ts offers. Flagging it
    // would have demanded a change that makes the code worse. So the rule
    // requires a backslash-QUOTING replacement, which is the thing there must be
    // exactly one of.
    const copies = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib'))]
      .filter((f) => PRIVATE_ESCAPE.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f).split(sep).join('/'))
      .filter((f) => f !== 'lib/supabase/escape-like.ts');
    expect(
      copies,
      'these backslash-escape the LIKE wildcards privately. One definition, in '
      + 'lib/supabase/escape-like.ts, is what makes the next fix reach them:\n'
      + copies.map((c) => `  ${c}`).join('\n'),
    ).toEqual([]);
  });

  it('matches an escape, and not a strip', () => {
    // Recorded rather than trusted: this audit has three times now shipped a
    // scanner whose question was right and whose pattern was wrong, so the
    // pattern is checked against the literal text on both sides of the line.
    expect(PRIVATE_ESCAPE.test(String.raw`value.replace(/[\\%_]/g, (c) => ` + '`\\\\${c}`)')).toBe(true);
    expect(PRIVATE_ESCAPE.test(String.raw`value.replace(/[%_\\]/g, (m) => ` + '`\\\\${m}`)')).toBe(true);
    expect(PRIVATE_ESCAPE.test(String.raw`value.replace(/[%_]/g, (m) => '\\' + m)`)).toBe(true);
    // The strip that was falsely accused, and a class that is not about LIKE.
    expect(PRIVATE_ESCAPE.test(String.raw`query.replace(/[%_,()"\\]/g, ' ')`)).toBe(false);
    expect(PRIVATE_ESCAPE.test(String.raw`label.replace(/[()]/g, ' ')`)).toBe(false);
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

describe('escapeOrValue', () => {
  it('does everything escapeLike does', () => {
    // Composition, not a second implementation: the wildcard half must not drift.
    for (const value of ['50%', 'smit_', 'a_b%c', 'back\\slash', 'Weekly shop', '']) {
      expect(escapeOrValue(value)).toBe(escapeLike(value));
    }
  });

  it('neutralises the or-grammar characters escapeLike leaves behind', () => {
    // The finding: each of these survives escapeLike untouched, because none of
    // them is a LIKE character.
    for (const ch of [',', '(', ')']) expect(escapeLike(`a${ch}b`)).toBe(`a${ch}b`);
    expect(escapeOrValue('a,b')).toBe('a b');
    expect(escapeOrValue('timeout (503), retry')).toBe('timeout  503   retry');
  });

  it('cannot add a disjunct to an or-expression', () => {
    // `status.neq.zzz` as a fourth disjunct matches every row, so the search
    // stops filtering. Built here as the call site builds it.
    const filter = (q: string) => {
      const like = `%${escapeOrValue(q)}%`;
      return `feature.ilike.${like},error.ilike.${like}`;
    };
    expect(filter('x,status.neq.zzz').split(',')).toHaveLength(2);
    // Calibration: the same term through escapeLike alone splits into four.
    const unsafe = `%${escapeLike('x,status.neq.zzz')}%`;
    expect(`feature.ilike.${unsafe},error.ilike.${unsafe}`.split(',')).toHaveLength(4);
  });

  it('leaves a term that was nothing but grammar as the empty string', () => {
    // Which the call site reads as "no search", rather than as `%   %`.
    expect(escapeOrValue('  (),  ')).toBe('');
  });

  it('keeps the dots, because feature names are full of them', () => {
    // A dot in the value half of `column.operator.value` is not structural.
    expect(escapeOrValue('wallet.coach')).toBe('wallet.coach');
  });
});
