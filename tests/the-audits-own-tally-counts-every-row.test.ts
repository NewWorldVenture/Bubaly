import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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

// Run the actual comparator, rather than reimplementing its regular expressions.
// UTF-8 keeps the CLI's documented refusal codes observable on Windows too.
const SCRIPT = resolve('docs/audit/tally-cross-check.py');
function compare(doc: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'bubaly-tally-cross-check-'));
  writeFileSync(join(cwd, 'finalaudit.md'), doc, 'utf8');
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [SCRIPT], {
    cwd, encoding: 'utf8', timeout: 5_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
  });
  expect(result.error, 'the actual Python comparator must run').toBeUndefined();
  return result;
}

interface Tally {
  g?: string; p?: string; gr?: number; gi?: number; pr?: number; pi?: number;
  modern?: boolean; missing?: boolean;
}
function tally({ g = 'FIXED 2', p = 'FIXED 2', gr = 2, gi = 2, pr = 2, pi = 2,
  modern = false, missing = false }: Tally = {}) {
  return (missing ? '' : `Generated by \`docs/audit/finding-index.py\`. ${gr} finding rows, ${gi} distinct ids. ${g}*`) + '\n' +
    `derives the tally from the\ndocument itself: **${p}** — ${modern ? `${pi} distinct ids over ` : ''}${pr} rows\n`;
}

describe('the actual tally comparator refuses ambiguous or empty evidence', () => {
  it('compares the actual repository prose and generated counts', () => {
    const result = compare(DOC);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/tallies agree: [1-9]\d* rows/);
    expect(result.stderr).toBe('');
  });

  const cases: [string, Tally, number][] = [
    ['legacy healthy', {}, 0],
    ['modern healthy distinct fewer than rows', { gr: 3, gi: 2, pr: 3, pi: 2, g: 'FIXED 3', p: 'FIXED 3', modern: true }, 0],
    ['legacy wrapped buckets', { g: 'FIXED 1 · OPEN 1', p: 'OPEN 1 ·\n> FIXED 1' }, 0],
    ['row mismatch', { pr: 3 }, 1],
    ['generated bucket arithmetic', { gr: 3, gi: 2 }, 1],
    ['prose bucket mismatch', { p: 'FIXED 1 · OPEN 1' }, 1],
    ['distinct id mismatch modern', { modern: true, pi: 1 }, 1],
    ['duplicate generated buckets', { g: 'FIXED 1 · FIXED 2' }, 2],
    ['duplicate prose buckets', { p: 'FIXED 1 · FIXED 2' }, 2],
    ['both duplicate buckets', { g: 'FIXED 1 · FIXED 2', p: 'FIXED 1 · FIXED 2' }, 2],
    ['zero rows and ids with nonempty bucket', { gr: 0, gi: 0, pr: 0, g: 'FIXED 0', p: 'FIXED 0' }, 2],
    ['zero distinct ids with positive rows', { gi: 0 }, 2],
    ['distinct ids greater than rows', { gi: 3 }, 2],
    ['empty tally', { g: '', p: '' }, 2],
    ['missing generated', { missing: true }, 2],
    ['unparseable bucket', { g: 'FIXED two' }, 2],
    ['blank indexed status', { g: '— 1 · FIXED 1', p: '— 1 · FIXED 1' }, 1],
    ['modern zero prose ids', { modern: true, pi: 0 }, 2],
    ['modern prose ids exceed rows', { modern: true, pi: 3 }, 2],
    ['normalized apostrophe duplicate', { g: "OWNER'S 1 · OWNER’S 2", p: "OWNER'S 2" }, 2],
    ['modern wrapped and reordered', { modern: true, g: 'FIXED 1 · OPEN 1', p: 'OPEN 1 ·\n> FIXED 1' }, 0],
  ];
  it.each(cases)('%s has the documented CLI exit code', (_name, input, expected) => {
    const result = compare(tally(input));
    expect(result.status).toBe(expected);
    if (expected === 0) {
      expect(result.stdout).toContain('tallies agree:');
      expect(result.stderr).toBe('');
    } else if (expected === 1) {
      expect(result.stdout).toContain('TALLIES DISAGREE:');
    } else {
      expect(result.stderr).toContain('CANNOT COMPARE:');
      expect(result.stdout).not.toContain('tallies agree:');
    }
  });

  it('refuses missing prose instead of trusting the generated half', () => {
    const result = compare(tally().split('\n')[0]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('the prose tally did not match');
  });
});

describe('the actual tally comparator requires one matching metadata record of each kind', () => {
  const generated = (bucket = 'FIXED 2', rows = 2, ids = 2) =>
    `Generated by \`docs/audit/finding-index.py\`. ${rows} finding rows, ${ids} distinct ids. ${bucket}*\n`;
  const prose = (bucket = 'FIXED 2', rows = 2, ids: number | null = null) =>
    `derives the tally from the\ndocument itself: **${bucket}** — ${ids === null ? '' : `${ids} distinct ids over `}${rows} rows\n`;
  const cases: [string, string, number][] = [
    ['single legacy', generated() + prose(), 0],
    ['single modern', generated() + prose('FIXED 2', 2, 2), 0],
    ['modern fewer IDs than rows', generated('FIXED 3', 3, 2) + prose('FIXED 3', 3, 2), 0],
    ['single bucket disagreement', generated() + prose('OPEN 2'), 1],
    ['missing prose', generated(), 2],
    ['duplicate bucket refusal', generated('FIXED 1 · FIXED 2') + prose(), 2],
    ['conflicting second generated', generated() + generated('OPEN 3', 3, 2) + prose(), 2],
    ['conflicting second prose', generated() + prose() + prose('OPEN 2'), 2],
    ['identical repeated generated', generated() + generated() + prose(), 2],
    ['identical repeated prose', generated() + prose() + prose(), 2],
    ['two distinct internally agreeing reports', generated() + prose() + generated('OPEN 3', 3, 2) + prose('OPEN 3', 3, 2), 2],
    ['second modern explicit ID mismatch', generated() + prose('FIXED 2', 2, 2) + prose('FIXED 2', 2, 1), 2],
  ];
  it.each(cases)('%s has the documented CLI exit code', (_name, doc, expected) => {
    const result = compare(doc);
    expect(result.status).toBe(expected);
    if (expected === 0) {
      expect(result.stdout).toContain('tallies agree:');
      expect(result.stderr).toBe('');
    } else if (expected === 1) {
      expect(result.stdout).toContain('TALLIES DISAGREE:');
    } else {
      expect(result.stderr).toContain('CANNOT COMPARE:');
      expect(result.stdout).not.toContain('tallies agree:');
    }
  });
});

// Real child CLI file boundaries. The Windows case holds a native exclusive
// handle on a synthetic file; no ACL/configuration change or mocked open/read.
import { mkdirSync } from 'node:fs';
const WINDOWS_EXCLUSIVE_READ = String.raw`
import ctypes, subprocess, sys
k = ctypes.WinDLL('kernel32', use_last_error=True)
k.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_ulong, ctypes.c_ulong,
                         ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_void_p]
k.CreateFileW.restype = ctypes.c_void_p
k.CloseHandle.argtypes = [ctypes.c_void_p]
handle = k.CreateFileW('finalaudit.md', 0x80000000, 0, None, 3, 0x80, None)
if handle == ctypes.c_void_p(-1).value:
    raise ctypes.WinError(ctypes.get_last_error())
try:
    result = subprocess.run([sys.executable, sys.argv[1]], capture_output=True, timeout=10)
finally:
    k.CloseHandle(handle)
sys.stdout.buffer.write(result.stdout)
sys.stderr.buffer.write(result.stderr)
sys.exit(result.returncode)
`;
function compareFileBoundary(data: string | Buffer | null, mode: 'file' | 'directory' | 'exclusive' = 'file', inheritedEncoding = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'bubaly-tally-file-boundary-'));
  if (mode === 'directory') mkdirSync(join(cwd, 'finalaudit.md'));
  else if (data !== null) writeFileSync(join(cwd, 'finalaudit.md'), data);
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
  if (inheritedEncoding) delete env.PYTHONIOENCODING;
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', mode === 'exclusive' ? ['-c', WINDOWS_EXCLUSIVE_READ, SCRIPT] : [SCRIPT], {
    cwd, encoding: 'utf8', timeout: 15_000, env,
  });
  expect(result.error, 'the actual Python comparator must run').toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}
function expectFileBoundary(result: ReturnType<typeof compareFileBoundary>, expected: number) {
  expect(result.status).toBe(expected);
  expect(result.stderr).not.toContain('Traceback (most recent call last):');
  if (expected === 0) {
    expect(result.stdout).toContain('tallies agree:');
    expect(result.stderr).toBe('');
  } else if (expected === 1) {
    expect(result.stdout).toContain('TALLIES DISAGREE:');
  } else {
    expect(result.stderr).toContain('CANNOT COMPARE:');
    expect(result.stdout).not.toContain('tallies agree:');
  }
}
describe('the actual tally comparator classifies unreadable inputs before comparison', () => {
  const agree = tally({ modern: true });
  const cases: [string, string | Buffer | null, 'file' | 'directory', boolean, number][] = [
    ['absent file', null, 'file', false, 2],
    ['directory instead of file', null, 'directory', false, 2],
    ['invalid UTF-8 file', Buffer.from([0xff, 0xfe, ...Buffer.from(' invalid synthetic bytes')]), 'file', false, 2],
    ['healthy UTF-8 agreement', agree, 'file', false, 0],
    ['healthy UTF-8 disagreement', tally({ modern: true, p: 'OPEN 2' }), 'file', false, 1],
    ['malformed UTF-8 metadata', 'Synthetic ordinary metadata with no tally\n', 'file', false, 2],
    ['healthy agreement with ordinary inherited encoding', agree, 'file', true, 0],
    ['metadata refusal with ordinary inherited encoding', 'Synthetic ordinary metadata with no tally\n', 'file', true, 2],
  ];
  it.each(cases)('%s retains the documented CLI disposition', (_name, data, mode, inheritedEncoding, expected) => {
    expectFileBoundary(compareFileBoundary(data, mode, inheritedEncoding), expected);
  });
  it.skipIf(process.platform !== 'win32')('native Windows sharing denial refuses without changing ACLs', () => {
    expectFileBoundary(compareFileBoundary(agree, 'exclusive'), 2);
  });
});

describe('the actual tally comparator classifies metadata numeric parsing refusal', () => {
  // Exercise an existing parsing refusal without changing Python's policy.
  // Older/unlimited runtimes can parse these counts and legitimately disagree.
  const probe = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import sys; print(getattr(sys, "get_int_max_str_digits", lambda: 0)())'], {
    encoding: 'utf8', timeout: 5_000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (probe.error || probe.status !== 0 || !/^\d+$/.test(probe.stdout.trim())) throw new Error('The active Python numeric boundary must be readable');
  const limit = Number(probe.stdout.trim());
  const exceedsActiveLimit = limit > 0 && limit < 4301;
  const huge = '9'.repeat(4301);
  const doc = (rows = '2', ids = '2', prows = '2', pids = '2', bucket = '2') =>
    `Generated by \`docs/audit/finding-index.py\`. ${rows} finding rows, ${ids} distinct ids. FIXED ${bucket}*\nderives the tally from the\ndocument itself: **FIXED 2** — ${pids} distinct ids over ${prows} rows\n`;
  const cases: [string, string, number][] = [
    ['generated rows exceed numeric parsing limit', doc(huge), 2],
    ['generated ids exceed numeric parsing limit', doc('2', huge), 2],
    ['prose rows exceed numeric parsing limit', doc('2', '2', huge), 2],
    ['prose ids exceed numeric parsing limit', doc('2', '2', '2', huge), 2],
    ['oversized bucket already refuses', doc('2', '2', '2', '2', huge), 2],
    ['healthy normal agreement', doc(), 0],
    ['normal count disagreement', doc('2', '2', '3'), 1],
  ];
  it.skipIf(!exceedsActiveLimit).each(cases.slice(0, 5))('%s has a named disposition without a traceback', (_name, data, expected) => {
    expectFileBoundary(compare(data), expected);
  });
  it.each(cases.slice(5))('%s has a named disposition without a traceback', (_name, data, expected) => {
    expectFileBoundary(compare(data), expected);
  });
});

describe('the actual tally comparator reports derived sum disagreement', () => {
  const probe = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import sys; print(getattr(sys, "get_int_max_str_digits", lambda: 0)())'], {
    encoding: 'utf8', timeout: 5_000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (probe.error || probe.status !== 0 || !/^\d+$/.test(probe.stdout.trim())) throw new Error('The active Python numeric boundary must be readable');
  const limit = Number(probe.stdout.trim());
  const huge = '9'.repeat(4300);
  const doc = (g = 'FIXED 2', p = 'FIXED 2') =>
    `Generated by \`docs/audit/finding-index.py\`. 2 finding rows, 2 distinct ids. ${g}*\nderives the tally from the\ndocument itself: **${p}** — 2 distinct ids over 2 rows\n`;
  const cases: [string, string, number][] = [
    ['generated derived sum format', doc(`FIXED ${huge} · OPEN ${huge}`), 1],
    ['prose derived sum format', doc('FIXED 2', `FIXED ${huge} · OPEN ${huge}`), 1],
    ['ordinary bucket sum disagreement', doc('FIXED 2 · OPEN 1'), 1],
    ['ordinary agreement', doc(), 0],
  ];
  // Below4300 the operands themselves cannot parse, so this output boundary
  // does not apply. Older/unlimited runtimes still report named disagreement.
  it.skipIf(limit > 0 && limit < 4300).each(cases.slice(0, 2))('%s retains named disagreement', (_name, data, expected) => {
    const result = compare(data);
    expectFileBoundary(result, expected);
    if (limit === 4300) {
      expect(result.stdout).toContain('bucket counts disagree, but their numeric details cannot be displayed');
      expect(result.stdout).not.toContain(huge);
      expect(result.stderr).not.toContain(huge);
    }
  });
  it.each(cases.slice(2))('%s retains ordinary numeric feedback', (_name, data, expected) => {
    const result = compare(data);
    expectFileBoundary(result, expected);
    if (expected === 1) expect(result.stdout).toContain('the generated buckets sum to 3 but it claims 2 rows');
  });
});
