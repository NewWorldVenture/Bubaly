import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// `docs/audit/finding-index.py` derives the tally printed at the top of
// finalaudit.md — FIXED n · OPEN n · … — from the document itself, so nobody has
// to keep a count by hand. That makes the tally evidence, and evidence can be
// corrupted quietly.
//
// It was. A verdict written as `fam.timezone || 'UTC'` put TWO PIPES inside a
// markdown table row. A pipe in a code span is still a column separator, so the
// row gained two empty cells, the generator read the wrong one as the verdict,
// and TIME-005 — a row that says **Fixed** in its first three words — was
// tallied as `—`. FIXED dropped from 90 to 89 and a category that should not
// exist appeared with a count of 1.
//
// Nothing rendered wrong enough to notice: the row still looks like prose in a
// diff, and the only symptom was a number moving by one in a block nobody reads
// line by line. So this holds the shape the generator depends on, rather than
// trusting that a `|` will be spotted in review.

const DOC = readFileSync('finalaudit.md', 'utf8');
const LINES = DOC.split('\n');

/** A finding row: `| **ID** | … | … | … |`. */
const FINDING_ROW = /^\| \*\*[A-Z][A-Za-z0-9-]*/;

describe("the audit's own tally counts every row", () => {
  // The GENERATED block is skipped, exactly as finding-index.py skips it on
  // read: its rows are `| id | status | finding | section |`, so their last cell
  // is a section name and would fail every check below. Its own integrity is
  // checked separately, further down.
  const begin = LINES.findIndex((l) => l.startsWith('<!-- finding-index:begin -->'));
  const end = LINES.findIndex((l) => l.startsWith('<!-- finding-index:end -->'));
  const rows = LINES.map((line, i) => ({ line, n: i + 1 }))
    .filter((r) => !(begin >= 0 && r.n - 1 > begin && r.n - 1 < end))
    .filter((r) => FINDING_ROW.test(r.line));

  it('finds the finding rows at all', () => {
    // Non-vacuity: everything below iterates this set, and an empty set would
    // make all of it pass while checking nothing — which is the shape AUDIT-007
    // is about.
    expect(rows.length).toBeGreaterThan(100);
  });

  // WHAT THIS FILE DOES NOT DO, and why. Two drafts tried to catch the broken
  // row by its SHAPE — first "every row has exactly four cells", then "the last
  // cell starts with a status keyword". Both flagged dozens of healthy rows: 49
  // legitimately contain a pipe somewhere harmless (a regex like `OK \| PASSED`,
  // a version range), and re-deriving which rows the generator even counts means
  // re-implementing its id pattern, its section tracking and its de-duplication,
  // at which point the test is a second copy of the thing it is checking and
  // wrong in its own way.
  //
  // So this checks the OUTCOME instead: the generated block must classify every
  // row it lists, and the prose tally must agree with it. That is the property
  // the corruption actually violated — TIME-005 appeared as `—` and FIXED fell
  // by one — and it holds however a future row gets broken, including ways a
  // shape rule would not anticipate.

  it('the generated index classified every row', () => {
    const begin = DOC.indexOf('<!-- finding-index:begin -->');
    const end = DOC.indexOf('<!-- finding-index:end -->');
    expect(begin, 'the generated index is missing').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    const indexed = DOC.slice(begin, end).split('\n').filter((l) => FINDING_ROW.test(l));
    expect(indexed.length, 'the index is empty').toBeGreaterThan(100);
    const unclassified = indexed
      .map((l) => ({ id: l.split('|')[1]?.trim(), status: l.split('|')[2]?.trim() }))
      .filter((r) => !r.status || r.status === '—');
    expect(unclassified, 'a row the generator could not classify — usually a broken cell count above').toEqual([]);
  });

  it('the prose tally and the generated tally agree', () => {
    const prose = DOC.match(/FIXED (\d+) · CHECKED (\d+) · PARTIAL (\d+) · OWNER'S (\d+) · OPEN (\d+)/);
    const gen = DOC.match(/FIXED (\d+) · OPEN (\d+) · OWNER'S (\d+) · PARTIAL (\d+)/);
    expect(prose, 'the prose tally block is missing or reworded').toBeTruthy();
    expect(gen, 'the generated tally line is missing or reworded').toBeTruthy();
    // FIXED and OPEN are the two the rest of the document argues from.
    expect(prose![1], 'prose FIXED disagrees with the generated count').toBe(gen![1]);
    expect(prose![5], 'prose OPEN disagrees with the generated count').toBe(gen![2]);
  });
});
