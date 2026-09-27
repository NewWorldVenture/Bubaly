import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unconfirmedWritesIn } from './helpers/unconfirmed-writes';

/**
 * Audit C1-S9-61 — the scanner under test, rather than trusted.
 *
 * Both unconfirmed-write ratchets are only as good as this function, and it has
 * been wrong six times: a twelve-line cap (C1-S9-46), a newline-eating comment
 * strip (C1-S9-52), trailing comments ending a statement early (C1-S9-60), and
 * — found while widening it — range filters read as "unfiltered" and builders
 * followed nowhere (C1-S9-61). Each rule gets a fixture here that it alone
 * decides, so a regression in any of them is a red test and not a quietly
 * different count that someone "fixes" by editing a baseline.
 */
const dir = mkdtempSync(join(tmpdir(), 'uw-scan-'));
let n = 0;
function scan(source: string) {
  const file = join(dir, `f${n++}.ts`);
  writeFileSync(file, source);
  return unconfirmedWritesIn(file).map((s) => s.line);
}

describe('what counts as an unconfirmed write', () => {
  it('a filtered update with no .select() counts', () => {
    expect(scan("await db.from('t').update({ a: 1 }).eq('id', id);")).toEqual([1]);
  });

  it('a filtered delete counts', () => {
    expect(scan("await db.from('t').delete().eq('id', id);")).toEqual([1]);
  });

  it('.select() confirms it', () => {
    expect(scan("await db.from('t').update({ a: 1 }).eq('id', id).select('id');")).toEqual([]);
  });

  it("count: 'exact' confirms it too (C1-S9-59)", () => {
    expect(scan("await db.from('t').update({ a: 1 }, { count: 'exact' }).eq('id', id);")).toEqual([]);
  });

  it('an unfiltered write is out of scope', () => {
    expect(scan("await db.from('t').update({ a: 1 });")).toEqual([]);
  });

  it('an insert is out of scope — it cannot match zero rows', () => {
    expect(scan("await db.from('t').insert({ a: 1 });")).toEqual([]);
  });

  it('a write through a table wrapper counts (C1-S9-61)', () => {
    // The guardian routes' `gFrom(t) => db.from(t)`.
    expect(scan("await gFrom('guardian_screening_sessions').update({ s: 1 }).eq('id', id);")).toEqual([1]);
    expect(scan("await gFrom('guardian_screening_sessions').update({ s: 1 }).eq('id', id).select('id');")).toEqual([]);
  });

  it('an ordinary …From() helper is not taken for a table', () => {
    expect(scan('const v = statusFrom(row).update(x).eq(1);')).toEqual([]);
  });

  it('a non-database .update() is out of scope', () => {
    expect(scan('hash.update(buffer);')).toEqual([]);
  });
});

describe('the rules that have each been wrong once', () => {
  it('a range filter makes a write targeted (C1-S9-61)', () => {
    // Was read as unfiltered and skipped — the write disappeared from the count.
    expect(scan("await db.from('t').delete().lt('expires_at', now);")).toEqual([1]);
    expect(scan("await db.from('t').update({ a: 1 }).gte('n', 3);")).toEqual([1]);
  });

  it('a trailing comment with a semicolon does not end the statement (C1-S9-60)', () => {
    const src = [
      "await db.from('t')",
      '  .update({ a: 1 })',
      "  .eq('id', id) // RLS also enforces this; explicit for clarity",
      "  .select('id');",
    ].join('\n');
    expect(scan(src)).toEqual([]);
  });

  it('the FIRST statement in a block is read alone (C1-S9-61)', () => {
    // The statement start looked back for the last `;`, which for the first
    // statement in a block is before the `if` — so the whole if/else became
    // one "statement", and the else branch's `.select(` confirmed this write.
    const src = [
      'if (existing) {',
      "  await db.from('t').update({ a: 1 }).eq('id', id);",
      '} else {',
      "  await db.from('t').insert({ a: 1 }).select('id');",
      '}',
    ].join('\n');
    expect(scan(src)).toEqual([2]);
  });

  it('a `{` inside a call does not end the walk early', () => {
    // A template literal's `${` or an arrow body inside an argument list must
    // not cut the statement off before its `.from(`.
    expect(scan("await db.from(`t_${suffix}`).delete().eq('id', id);")).toEqual([1]);
  });

  it('a trailing comment cannot hide a filter either — the worse direction', () => {
    const src = [
      "await db.from('t')",
      '  .delete() // gone; really',
      "  .eq('id', id);",
    ].join('\n');
    expect(scan(src)).toEqual([2]);
  });

  it('a URL in a string is not mistaken for a comment', () => {
    // `(?<=[ \t])` — a URL's `//` follows a colon.
    expect(scan("await db.from('t').update({ u: 'https://x.test/a' }).eq('id', id).select('id');")).toEqual([]);
  });

  it('line numbers survive a blank line above a comment (C1-S9-52)', () => {
    // The trigger is precisely a blank or whitespace-only line directly above a
    // comment: `^\s*` starts at the blank line and `\s` eats its newline on the
    // way to the `//`. (Consecutive comment lines alone do NOT trigger it — `^`
    // cannot match at a newline character, so a single pass never joins them.
    // The first version of this fixture used only those, and reverting the fix
    // left it green.)
    const src = ['const a = 1;', '', '// one', '   ', '// two', "await db.from('t').delete().eq('id', id);"].join('\n');
    expect(scan(src)).toEqual([6]);
  });

  it('line numbers survive a block comment', () => {
    const src = ['/* three', '   four */', "await db.from('t').delete().eq('id', id);"].join('\n');
    expect(scan(src)).toEqual([3]);
  });

  it('a long statement is read whole — no line cap (C1-S9-46)', () => {
    const src = ["await db.from('t').update({"]
      .concat(Array.from({ length: 30 }, (_, i) => `  f${i}: ${i},`))
      .concat(["}).eq('id', id).select('id');"]).join('\n');
    expect(scan(src)).toEqual([]);
  });
});

describe('writes built across statements (C1-S9-61)', () => {
  const builder = (run: string) => [
    "let q = db.from('t').update({ read: true });",
    "q = ids ? q.in('id', ids) : q.eq('read', false);",
    run,
  ].join('\n');

  it('is followed to its await and counted', () => {
    // Invisible before: the declaration has no filter, and the statements that
    // filter and run it contain no `.from(`.
    expect(scan(builder('const { error } = await q;'))).toEqual([1]);
  });

  it('is confirmed by a .select() at the await', () => {
    expect(scan(builder("const { data, error } = await q.select('id');"))).toEqual([]);
  });

  it('is confirmed by a .select() added in between', () => {
    expect(scan(builder("q = q.select('id');\nconst { data } = await q;"))).toEqual([]);
  });

  it('a builder handed on rather than run is not counted here', () => {
    // Whoever awaits it owns the confirmation.
    expect(scan("const q = db.from('t').update({ a: 1 }).eq('id', id);\nreturn q;")).toEqual([]);
  });

  it('is followed into an awaited EXPRESSION, not only `await <name>`', () => {
    // The shape in onboarding-calendar/setup.ts. Following the literal
    // `await update` found nothing, so the builder was treated as handed on and
    // skipped — confirmed or not.
    const decl = "const update = db.from('t').update({ a: 1 }).eq('user_id', u);";
    expect(scan(`${decl}\nconst r = await (c ? update.is('x', null) : update.eq('x', v)).maybeSingle();`)).toEqual([1]);
    expect(scan(`${decl}\nconst r = await (c ? update.is('x', null) : update.eq('x', v)).select('id').maybeSingle();`)).toEqual([]);
  });

  it('a builder returned WITH .select() is confirmed, returned bare is handed on', () => {
    const decl = "let query = db.from('t').delete().in('id', ids);\nif (f) query = query.eq('family_id', f);";
    expect(scan(`${decl}\nreturn query.select('id');`)).toEqual([]);
    expect(scan(`${decl}\nreturn query;`)).toEqual([]);
  });

  it('a directly awaited assignment is still a single statement', () => {
    expect(scan("const r = await db.from('t').update({ a: 1 }).eq('id', id);")).toEqual([1]);
  });
});
