// A query filtered by a MEMBER id is not scoped to a family.
//
// Every family table in this schema carries `family_id` — all 491 of them; the
// replayed catalogue says there is not one member-keyed table without it — and
// their RLS reads `is_family_member(family_id)`. That predicate admits EVERY
// family the caller belongs to, not the family the request is about. So a query
// that filters on `member_id` alone is scoped to "any household this person is
// a parent in", which is not the same question the page asked, and in a
// household they left or a second family they joined it is not the same answer.
//
// Two routes crossed that line. `/api/ai/health/coach` read `family_members`,
// `medical_profiles` and `symptom_logs` by member id while reading
// `medications` by family AND member — four reads in one Promise.all, three
// crossing and one not, so the coach described a person's blood type,
// allergies, conditions and last ten symptoms and then reported "Active
// medications: none on file". `/api/behavior/insight` read `behavior_logs` with
// no family filter at all, blending two households into one parenting insight
// behind a feature gate that had only ever been checked against one of them.
//
// This is PARSED, not grepped, for a reason this audit has already paid for
// once: Pass C's sweep required `.from('t')` on the same line as its `await`,
// so it read clean over two live defects and a reverted fix still passed. The
// `behavior_logs` query here is built across statements —
//
//     let q = supabase.from('behavior_logs').select(…)…;
//     if (body.memberId) q = q.eq('member_id', body.memberId);
//
// — so the member filter and the `.from()` are not in one expression at all. A
// scan that reads expressions misses it. The builder cases below exist to prove
// this one does not.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', 'supabase', 'mobile', 'tests', 'scripts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/** Columns that name a person. None of them names a household. */
const MEMBER_COLUMNS = new Set(['member_id', 'family_member_id', 'child_id', 'assigned_to', 'assignee_id']);

type Chain = { table: string; text: string; line: number; file: string };

/**
 * Every Supabase query chain in one file, with the filters added to it later
 * through a reassigned builder folded back in.
 *
 * A chain is found by its `.from('table')` call and then climbed to the
 * outermost call expression it belongs to, so `.select().eq().order().limit()`
 * spread over six lines is one chain and the line breaks are irrelevant.
 */
function chainsIn(file: string): Chain[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const chains: Chain[] = [];
  const byVariable = new Map<string, Chain>();

  /** Climb from a `.from(…)` call to the outermost call expression above it. */
  const outermost = (node: ts.Node): ts.Node => {
    let top = node;
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isPropertyAccessExpression(p) || ts.isCallExpression(p) || ts.isAwaitExpression(p)) top = p;
      else break;
    }
    return top;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'from'
      && node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0])) {
      const top = outermost(node);
      const chain: Chain = {
        table: (node.arguments[0] as ts.StringLiteral).text,
        text: top.getText(sf),
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        file: relative(ROOT, file),
      };
      chains.push(chain);
      // `let q = supabase.from('t')…` — remember the binding so that a later
      // `q = q.eq('member_id', …)` is folded into THIS chain.
      let owner: ts.Node | undefined = top;
      while (owner && !ts.isVariableDeclaration(owner) && !ts.isExpressionStatement(owner)) owner = owner.parent;
      if (owner && ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)) {
        byVariable.set(owner.name.text, chain);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Second walk: fold `q = q.eq(…)` reassignments back into the chain `q` holds.
  const fold = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)) {
      const chain = byVariable.get(node.left.text);
      if (chain && node.right.getText(sf).includes(node.left.text)) {
        chain.text += `\n${node.right.getText(sf)}`;
      }
    }
    ts.forEachChild(node, fold);
  };
  fold(sf);

  return chains;
}

const filtersOnMember = (text: string): string | null => {
  for (const m of text.matchAll(/\.(?:eq|in)\(\s*['"]([a-z_]+)['"]/g)) {
    if (MEMBER_COLUMNS.has(m[1])) return m[1];
  }
  return null;
};
const filtersOnFamily = (text: string): boolean => /\.(?:eq|in)\(\s*['"]family_id['"]/.test(text);

/**
 * Sites that filter by a member id and no family id, and are nonetheless right.
 *
 * A reason has to say WHY, in a sentence a reviewer can check against the code.
 * Two shapes qualify and no others: the member id came from the session rather
 * than the request (so it is the caller's own id, already family-resolved), or
 * the row is read first and its family_id compared to the caller's before
 * anything is done with it.
 */
const SCOPED_ANOTHER_WAY: Record<string, string> = {
  'app/(app)/family/child-login-actions.ts': 'Reads the child_logins row by member_id with the service client and then refuses unless row.family_id === ctx.active.familyId, which is the read-then-verify shape rather than a missing filter.',
  'app/(app)/marketplace/actions.ts': 'Every memberId here is ctx.active.member.id, the caller’s own id in the family they are acting in, so it cannot name a member of a different household.',
  'app/(app)/marketplace/creators/[id]/page.tsx': 'selfId is the signed-in member’s own id from the session context; the query asks whether the caller follows this creator.',
  'app/(app)/marketplace/item/[id]/page.tsx': 'selfId is the signed-in member’s own id from the session context; the query asks whether the caller saved this item.',
  'app/(app)/dashboard/locator/actions.ts': 'member.id is read from the caller’s own resolved membership row rather than from the request body.',
};

describe('a query filtered by member id also names its family', () => {
  const files = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib'))];
  const chains = files.flatMap(chainsIn);

  it('finds query chains to check at all', () => {
    // A sweep that parses nothing passes everything. This is the floor.
    expect(chains.length).toBeGreaterThan(500);
  });

  it('never scopes a read to a person without also scoping it to a household', () => {
    const offenders = chains
      .filter((c) => filtersOnMember(c.text) && !filtersOnFamily(c.text))
      .filter((c) => !(c.file in SCOPED_ANOTHER_WAY))
      .map((c) => `${c.file}:${c.line} ${c.table} filtered by ${filtersOnMember(c.text)} with no family_id`);
    expect(offenders).toEqual([]);
  });

  it('states a checkable reason for every site scoped another way', () => {
    const thin = Object.entries(SCOPED_ANOTHER_WAY)
      .filter(([, reason]) => reason.trim().length <= 40)
      .map(([file]) => file);
    expect(thin).toEqual([]);
  });

  it('keeps no exemption for a site that no longer needs one', () => {
    // A stale entry is worse than none: it reads as review of code that has
    // since changed, and it silently exempts whatever is written there next.
    const stale = Object.keys(SCOPED_ANOTHER_WAY).filter((file) =>
      !chains.some((c) => c.file === file && filtersOnMember(c.text) && !filtersOnFamily(c.text)));
    expect(stale).toEqual([]);
  });

  // The two routes this guard was written for. Named, so that losing the filter
  // fails with the route rather than with a number.
  it.each([
    ['app/api/ai/health/coach/route.ts', ['family_members', 'medical_profiles', 'symptom_logs']],
    ['app/api/behavior/insight/route.ts', ['behavior_logs']],
  ])('%s scopes every member-keyed read to the active family', (file, tables) => {
    const mine = chainsIn(join(ROOT, file));
    for (const table of tables) {
      const chain = mine.find((c) => c.table === table);
      expect(chain, `${file} no longer reads ${table}`).toBeTruthy();
      expect(filtersOnFamily(chain!.text), `${table} in ${file} is not scoped to family_id`).toBe(true);
    }
  });
});

// ── The other half of the same class ────────────────────────────────────────
//
// `family_members` is keyed by `id`, not `member_id`, so a read of it does not
// look like a member filter at all — and the sweep above cannot see it. One of
// the three crossing reads in `/api/ai/health/coach` was exactly that shape:
//
//     supabase.from('family_members').select('display_name, birthday').eq('id', memberId)
//
// with `memberId` taken straight from the request body. It was found by reading
// the route, not by the sweep, and a class half-covered by a guard is the kind
// of thing that reads as covered.
//
// There are 17 such reads in the tree and all 17 are right, for two reasons
// worth separating. Fifteen pass an id that was DERIVED — `cw.member_id` from a
// child_wallets row already resolved, `ctx.active.member.id` from the session,
// `memberProfile.member_id` from a signature-authenticated lookup — so the id
// could never name a stranger's member in the first place. That is a rule, not
// a list, and it is what this checks. The other two are super-admin actions,
// where naming any member is the point.
describe('a family_members read keyed by id did not get that id from the caller', () => {
  // Objects whose properties are request input, however they are spelled.
  //
  // NOT anchored at the start, and the difference is the whole guard. The
  // health coach wrote its id as
  //
  //     const memberId = typeof body.memberId === 'string' && body.memberId ? body.memberId : null;
  //
  // so an anchored pattern sees `typeof` and calls it derived — this sweep read
  // clean over the very defect it was written for until the revert exposed it.
  // The optional `)` is for Next's route params, which are read as
  // `(await params).memberId` — caller input with a paren in the way.
  const REQUEST_SHAPED = /\b(body|parsed|payload|input|params|json|raw|searchParams|formData|query)\s*\)?\s*[.[]/;

  /** `const memberId = <init>` — resolve one hop, so the rule sees the source. */
  function resolveIdentifier(sf: ts.SourceFile, name: string): string | null {
    let found: string | null = null;
    const visit = (node: ts.Node): void => {
      if (!found && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && node.name.text === name && node.initializer) {
        found = node.initializer.getText(sf);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  }

  const READ_THEN_VERIFY: Record<string, string> = {
    'app/(app)/family/child-login-actions.ts': 'input.memberId is read first and the action refuses unless the row that comes back has family_id === ctx.active.familyId, so the caller\u2019s id is checked rather than trusted.',
  };

  const files = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib'))];

  const offenders = files.flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    if (!text.includes("from('family_members')")) return [];
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const superAdminGated = /\bassertSuperAdmin\s*\(|\bisSuperAdmin\s*\(/.test(text);
    return chainsIn(file)
      .filter((c) => c.table === 'family_members' && !filtersOnFamily(c.text))
      .flatMap((c) => {
        const keyed = /\.eq\(\s*['"]id['"]\s*,\s*([^)]+)\)/.exec(c.text);
        if (!keyed) return [];
        const raw = keyed[1].trim();
        const resolved = /^[A-Za-z_$][\w$]*$/.test(raw) ? (resolveIdentifier(sf, raw) ?? raw) : raw;
        if (!REQUEST_SHAPED.test(resolved)) return [];        // derived, not supplied
        if (superAdminGated) return [];                        // naming any member is the point
        if (c.file in READ_THEN_VERIFY) return [];
        return [`${c.file}:${c.line} family_members keyed on ${raw} (${resolved}) with no family_id`];
      });
  });

  it('never reads a member row by an id the request handed it', () => {
    expect(offenders).toEqual([]);
  });

  it('states a checkable reason for each read-then-verify exemption', () => {
    const thin = Object.entries(READ_THEN_VERIFY)
      .filter(([, reason]) => reason.trim().length <= 40).map(([file]) => file);
    expect(thin).toEqual([]);
  });

  // The predicate itself, pinned. It was anchored at `^` when this was written
  // and therefore blind to the one initializer it most needed to read; these
  // cases are that mistake turned into a standing check rather than a memory.
  it.each([
    ["body.memberId", true],
    ["typeof body.memberId === 'string' && body.memberId ? body.memberId : null", true],
    ['(await params).memberId', true],
    ['searchParams.get(\'memberId\')', true],
    ['ctx.active.member.id', false],
    ['cw.member_id', false],
    ['memberProfile.member_id as string', false],
    ['wallet.member_id', false],
  ])('reads %s as caller-supplied: %s', (expression, supplied) => {
    expect(REQUEST_SHAPED.test(expression as string)).toBe(supplied);
  });
});

// The detector's own eyesight, on shapes written here rather than found. Four
// cases: the two the real code uses, and the two that must NOT be reported.
describe('the sweep sees the shapes it claims to', () => {
  const write = (source: string): Chain[] => {
    const file = join(ROOT, 'tests', '__member-scope-fixture.ts');
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    // chainsIn reads from disk; re-run its logic against the in-memory source.
    const chains: Chain[] = [];
    const byVariable = new Map<string, Chain>();
    const outermost = (node: ts.Node): ts.Node => {
      let top: ts.Node = node;
      for (let p = node.parent; p; p = p.parent) {
        if (ts.isPropertyAccessExpression(p) || ts.isCallExpression(p) || ts.isAwaitExpression(p)) top = p;
        else break;
      }
      return top;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'from'
        && node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0])) {
        const top = outermost(node);
        const chain: Chain = {
          table: (node.arguments[0] as ts.StringLiteral).text,
          text: top.getText(sf), line: 0, file: 'fixture',
        };
        chains.push(chain);
        let owner: ts.Node | undefined = top;
        while (owner && !ts.isVariableDeclaration(owner) && !ts.isExpressionStatement(owner)) owner = owner.parent;
        if (owner && ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)) byVariable.set(owner.name.text, chain);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    const fold = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        const chain = byVariable.get(node.left.text);
        if (chain && node.right.getText(sf).includes(node.left.text)) chain.text += `\n${node.right.getText(sf)}`;
      }
      ts.forEachChild(node, fold);
    };
    fold(sf);
    return chains;
  };
  const reported = (source: string): boolean =>
    write(source).some((c) => filtersOnMember(c.text) && !filtersOnFamily(c.text));

  it('reports a one-expression member filter with no family filter', () => {
    expect(reported(`const r = await db.from('symptom_logs').select('*').eq('member_id', memberId);`)).toBe(true);
  });

  it('reports a member filter added to a reassigned builder', () => {
    // The exact shape of /api/behavior/insight before the fix. A scan that reads
    // one expression at a time calls this clean.
    expect(reported(`
      let q = db.from('behavior_logs').select('*').gte('occurred_at', since).limit(200);
      if (body.memberId) q = q.eq('member_id', body.memberId);
      const { data } = await q;
    `)).toBe(true);
  });

  it('does not report a chain that names both', () => {
    expect(reported(`const r = await db.from('medications').select('*').eq('family_id', familyId).eq('member_id', memberId);`)).toBe(false);
  });

  it('does not report a family filter added to a reassigned builder', () => {
    expect(reported(`
      let q = db.from('behavior_logs').select('*').eq('member_id', memberId);
      q = q.eq('family_id', familyId);
      const { data } = await q;
    `)).toBe(false);
  });

  // Multi-line is the norm in this codebase and was the hole in the last sweep.
  it('reads a chain broken across six lines as one chain', () => {
    expect(reported(`
      const { data } = await db
        .from('symptom_logs')
        .select('symptom, severity')
        .eq('member_id', memberId)
        .order('started_at', { ascending: false })
        .limit(10);
    `)).toBe(true);
  });
});
