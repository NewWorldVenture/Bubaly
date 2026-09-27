import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A capability with a careful reader and no writer.
 *
 * `/api/sync/feeds/<token>` is a public, unauthenticated iCalendar endpoint. It
 * validates the token's shape, rate-limits by IP in memory AND in the database,
 * scopes strictly to `feed_enabled` rows, paginates with readAll so a busy
 * calendar cannot be silently truncated, and renders ICS. It reads like a live,
 * hardened public surface, and `lib/sync/feed-token.ts` sits beside it with 32
 * bytes of CSPRNG entropy, an HMAC signer and a timing-safe verifier.
 *
 * Nothing writes `sync_calendars.feed_token`. Nothing sets `feed_enabled` true.
 * The column is nullable with no DEFAULT (0018), `feed_enabled` defaults false,
 * and `generateFeedToken()` has no callers — `lib/sync/feed-token.ts` is not
 * imported by any file in the repository. So
 *
 *     .eq('feed_token', token).eq('feed_enabled', true)
 *
 * cannot match a row, for any family, ever. Every request to a feed URL is a
 * 404. `addToCalendarLinks()` in lib/calendar/providers.ts, which builds the
 * Google / Apple / webcal subscribe links, is likewise called only by its own
 * test.
 *
 * Why that is worse than ordinary dead code, and why it gets a guard rather
 * than a deletion: the danger is what the next reader concludes. A security
 * reviewer reads the rate limiters, the capability-token comment and the
 * `feed_enabled` scoping and concludes the feature is SAFE. The true state is
 * that it is ABSENT. Whoever eventually wires a publish button will reasonably
 * assume the token side is handled — and the single line that actually has to
 * be right, writing 32 random bytes rather than reusing the calendar's uuid, is
 * the one line nobody has written. Dead code that looks audited is how a
 * guessable capability URL ships.
 *
 * This is a RATCHET, and it only shrinks. When a writer appears, this test goes
 * red and the fix is to DELETE the entry — not to widen the allowances. The
 * list is a record of capabilities that cannot currently be issued, and it is
 * required to stop being true one entry at a time.
 *
 * Deliberately NOT done here: wiring the publish flow. Who may publish a family
 * calendar is a privacy decision with a real blast radius — these calendars can
 * carry a child's location-tagged events, and "any member" and "a manager only"
 * are different products. That is the owner's call, and it is filed rather than
 * guessed at.
 */

type Capability = {
  /** The column that holds the capability. */
  column: string;
  table: string;
  /** The file that reads it, and must still be reading it. */
  reader: string;
  why: string;
};

const CANNOT_BE_ISSUED: Capability[] = [
  {
    column: 'feed_token',
    table: 'sync_calendars',
    reader: 'app/api/sync/feeds/[token]/route.ts',
    why: 'the public ICS feed: generateFeedToken() has no callers, so no calendar can ever be published',
  },
];

/**
 * A column that IS written, used to prove the detector below can tell the
 * difference. Without this the guard passes by finding nothing, which is the
 * failure mode a detector is most prone to: `child_wallet_id` is written at
 * app/(app)/wallet/actions.ts in both the gift-link insert and the pay-handle
 * update, and read in several places as `.eq('child_wallet_id', …)`. A detector
 * that cannot see the first, or that mistakes the second for a write, is not
 * measuring anything.
 */
const CONTROL_COLUMN = 'child_wallet_id';

const TS_ROOTS = ['app', 'lib', 'components'];
const SQL_ROOTS = ['supabase'];

/**
 * Generated from the live schema, so it names every column in the database.
 * Including it would report a writer for everything.
 */
const GENERATED_TYPES = 'lib/database.types.ts';

function walk(dir: string, match: RegExp, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, match, out);
    else if (match.test(full)) out.push(full);
  }
  return out;
}

/** Everything a value could be assigned in, minus the generated types. */
function sourceFiles(): string[] {
  const ts = TS_ROOTS.flatMap((r) => walk(r, /\.tsx?$/));
  const sql = SQL_ROOTS.flatMap((r) => walk(r, /\.sql$/));
  return [...ts, ...sql]
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => f !== GENERATED_TYPES && !/\.test\.tsx?$/.test(f));
}

/**
 * A line with its comments and string literals removed.
 *
 * This is the whole mechanism, and it is the reason a regex is enough here
 * where elsewhere in this suite it was not. A READ names the column inside a
 * string — `.eq('feed_token', token)`, `.select('id, feed_enabled')` — and a
 * WRITE names it as an identifier: an object key, or a SQL SET target. Strip
 * the strings and the comments, and the two stop looking alike.
 */
function code(line: string): string {
  return line
    .replace(/--.*$/, '')
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * The one shape that names a column as an identifier and still cannot put a
 * value in it: its own declaration in `create table`, where the column name is
 * followed by its type.
 *
 * Anchored to a type keyword rather than to "first token on the line" on
 * purpose. A migration that backfills with
 *
 *     update sync_calendars
 *        set feed_token = encode(gen_random_bytes(32), 'base64')
 *
 * puts the column first on its line too, and that is exactly the writer this
 * guard exists to notice.
 */
const SQL_DECLARATION = /^\s*[a-z_]+\s+(text|uuid|varchar|char|boolean|bool|smallint|integer|int|int4|int8|bigint|serial|bigserial|numeric|decimal|real|double|timestamptz|timestamp|date|time|jsonb|json|bytea|citext|inet|interval)\b/i;

type Writer = { file: string; line: number; text: string };

/** Every line that could put a value into `column`. */
function writersOf(column: string): Writer[] {
  const named = new RegExp(`(^|[^A-Za-z0-9_$])${column}([^A-Za-z0-9_$]|$)`);
  const found: Writer[] = [];
  for (const file of sourceFiles()) {
    const source = readFileSync(file, 'utf8');
    // Cheap reject: the overwhelming majority of files never mention it.
    if (!source.includes(column)) continue;
    source.split('\n').forEach((raw, i) => {
      const stripped = code(raw);
      if (!named.test(stripped)) return;
      if (file.endsWith('.sql') && SQL_DECLARATION.test(stripped)) return;
      found.push({ file, line: i + 1, text: raw.trim() });
    });
  }
  return found;
}

describe('a capability nothing can issue', () => {
  it('can tell a written column from a read one', () => {
    // Non-vacuity. If this ever returns nothing, every assertion below is
    // passing by accident and the guard is measuring air.
    const control = writersOf(CONTROL_COLUMN);
    expect(
      control.length,
      `the detector found no writer for ${CONTROL_COLUMN}, which IS written — `
      + 'it is no longer able to tell a write from a read, so the rest of this '
      + 'file proves nothing',
    ).toBeGreaterThan(0);
    expect(
      control.some((w) => w.file.includes('wallet/actions.ts')),
      `${CONTROL_COLUMN} is written in app/(app)/wallet/actions.ts and the `
      + 'detector did not see it there',
    ).toBe(true);
  });

  it('does not mistake a read for a writer', () => {
    // Stated as the behaviour of code() on two literal lines rather than as a
    // filter over whatever writersOf currently returns. The first draft of this
    // assertion asked whether a reported line CONTAINED `.eq(` — and a real
    // write chains one:
    //
    //     .update({ feed_token: 'x' }).eq('id', id)
    //
    // so the guard's own probe was read back as a false accusation. Twice
    // before in this audit a guard has asked the right question through a
    // mechanism that assumed one shape of call site; this is the third, caught
    // on the bench rather than in the repository.
    expect(code(`    .eq('feed_token', token)`)).not.toContain('feed_token');
    expect(code(`    .select('id, name, feed_enabled')`)).not.toContain('feed_enabled');
    expect(code(`    .update({ feed_token: fresh }).eq('id', id)`)).toContain('feed_token');

    // And the reader's own read line, in the file as it actually stands, is not
    // among the writers found for it.
    for (const cap of CANNOT_BE_ISSUED) {
      const inReader = writersOf(cap.column).filter((w) => w.file === cap.reader);
      expect(
        inReader,
        `${cap.column}: the read in ${cap.reader} was counted as a writer — the `
        + 'string stripping in code() has stopped working',
      ).toEqual([]);
    }
  });

  it('still cannot be issued, or the entry is stale and must be deleted', () => {
    for (const cap of CANNOT_BE_ISSUED) {
      const writers = writersOf(cap.column);
      expect(
        writers,
        `${cap.table}.${cap.column} now has a writer, so this capability can be `
        + 'issued and the entry in CANNOT_BE_ISSUED is stale. DELETE the entry — '
        + 'do not widen the allowances to keep this test green.\n'
        + writers.map((w) => `  ${w.file}:${w.line}  ${w.text}`).join('\n'),
      ).toEqual([]);
    }
  });

  it('still has the reader that makes it look live', () => {
    // The other half of "the list never lies": an entry whose reader has been
    // deleted describes a capability that no longer exists in either direction,
    // and carrying it would overstate what this guard covers.
    for (const cap of CANNOT_BE_ISSUED) {
      expect(existsSync(cap.reader), `${cap.reader} is gone; drop the ${cap.column} entry`).toBe(true);
      const source = readFileSync(cap.reader, 'utf8');
      expect(
        source.includes(cap.column),
        `${cap.reader} no longer filters on ${cap.column}; drop the entry`,
      ).toBe(true);
    }
  });
});
