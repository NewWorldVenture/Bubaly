import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Launch-readiness ratchet (mandate: "remove mocks / placeholders / dead code").
// Shipping code (app/ + lib/ + components/) must carry no UNOWNED developer
// marker: a bare `// TODO: fix this` names nobody, tracks nothing, and is how
// work gets forgotten.
//
// ── what this guard used to do, and why it could not fail ──────────────────
//
// It stripped every comment from the file and then searched the remainder for
// TODO / FIXME / HACK / XXX. The stated reason was sound — a comment that says
// "no TODO stubs here" should not be flagged as a TODO. But a developer marker
// lives IN a comment, by definition; the file's own header called it "the
// comment-marker convention". Stripping comments removed the guard's entire
// search space, so it could only have matched a marker inside a string literal
// or an identifier, which is nowhere.
//
// It therefore reported, truthfully but uselessly, "0 hits across the whole
// tree" — while app/, lib/ and components/ carried NINETEEN markers:
//
//   TODO(M6 undo): reversing a run's writes from here needs a migration
//   TODO(M35 dead-letter): `ai_tool_calls` rows a dead worker left in
//   TODO(migration, owner approval required): an ESTIMATED total against a
//   TODO(M23 RLS migration): a caregiver preset that also pre-authorises a
//
// Every one of them is properly owned, which is the good news and also the
// point: the repository already follows the discipline this guard claimed to
// enforce, and the guard was not the reason.
//
// ── the rule now ───────────────────────────────────────────────────────────
//
// A marker must LEAD its comment and must carry a tracker reference:
//
//   // TODO(M6 undo): …            owned, passes
//   // TODO-0416 …                 owned, passes
//   // TODO: fix before launch     UNOWNED, fails
//   // FIXME                       UNOWNED, fails
//
// "Leads its comment" is what separates a marker from prose ABOUT a marker.
// `// shipped; see the TODO below.` is a sentence, and the TODO it refers to is
// real and owned twenty lines further down; `// habit presets … (TODO-0416).`
// is a ticket reference inside a description. Neither is a marker, and a guard
// that flagged them would be deleted as noise within a week — which is the
// other way a guard stops working.
const ROOTS = ['app', 'lib', 'components'];

/** A marker leading a comment: `// TODO…`, ` * FIXME…`, `{/* HACK…`. */
const LEADING_MARKER = /^(?:\/\/+|\/\*+|\{\/\*+|\*+)\s*(TODO|FIXME|HACK|XXX)\b(.*)$/;

/** What makes a marker owned: `(M6 undo)`, `-0416`, `#12`. */
const OWNED = /^\s*(?:\([^)]+\)|[-#]\s*\w+)/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry) && entry !== 'database.types.ts') {
      out.push(full);
    }
  }
  return out;
}

/** Unowned markers in a file, as `path:line — text`. */
export function unownedMarkers(source: string, path = ''): string[] {
  const found: string[] = [];
  source.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    const match = LEADING_MARKER.exec(line);
    if (!match) return;
    if (OWNED.test(match[2])) return;
    found.push(`${path}:${index + 1} — ${line.slice(0, 100)}`);
  });
  return found;
}

describe('shipping code carries no unowned developer markers', () => {
  const files = ROOTS.flatMap(sourceFiles);

  it('scans a non-trivial number of source files', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  // The failure path is the part that was broken for the whole of this guard's
  // life, so it is exercised directly rather than assumed to work.
  it('tells an owned marker from an unowned one (sanity: the matcher works)', () => {
    expect(unownedMarkers('// TODO: fix before launch')).toHaveLength(1);
    expect(unownedMarkers('  // FIXME')).toHaveLength(1);
    expect(unownedMarkers(' * XXX broken')).toHaveLength(1);
    expect(unownedMarkers('// TODO(M6 undo): needs a migration')).toEqual([]);
    expect(unownedMarkers('// TODO-0416 hydration streaks')).toEqual([]);
    // Prose about a marker is not a marker.
    expect(unownedMarkers('// shipped; see the TODO below.')).toEqual([]);
    expect(unownedMarkers('// habit presets, starting with hydration (TODO-0416).')).toEqual([]);
    // A string literal is not a comment.
    expect(unownedMarkers('const status = "todo";')).toEqual([]);
  });

  it('has no unowned TODO / FIXME / HACK / XXX in app/, lib/ or components/', () => {
    const offenders = files.flatMap((f) => unownedMarkers(readFileSync(f, 'utf8'), f));
    expect(offenders, `unowned dev markers:\n${offenders.join('\n')}`).toEqual([]);
  });
});
