import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUARDED_TABLES } from './a-refused-write-is-not-a-success.test';

// AUTHZ-010. `tests/a-refused-write-is-not-a-success.test.ts` proved that a
// restrictive policy's `using` clause FILTERS an UPDATE or DELETE rather than
// raising, so a refused write arrives as a success. It scans `ROOTS =
// ['components']`.
//
// That scope is not stated anywhere, and it is not where all the writes are.
// Measured across `app/` and `lib/`: 67 update/delete calls on the same 44
// guarded tables, of which 17 go through the cookie-bound user client and are
// therefore subject to exactly the same silent filtering.
//
// Every one of them is safe today, and this records why rather than leaving it
// to be re-derived: 13 are behind an app-layer manager gate in the same
// function, one asks for its rows back, and the last — `revokeAssistantLinkAction`
// — writes with the service role, which bypasses RLS entirely. Nothing checks
// that. Drop the `isManager` line from one of those actions and RLS becomes the
// only guard, the refusal is silent, and the action still returns `{ ok: true }`.
//
// So this turns the currently-true property into a rule, for the surface where
// the rule is crisp: an exported action in a `'use server'` file under `app/`
// is an entry point a browser can call directly, so it must refuse a
// non-manager itself, ask for its rows back, or write with the service role.
//
// The rule deliberately stops there. The `lib/` service functions that also
// write these tables take their client as a parameter and are gated by their
// callers, and every one was read by hand rather than mechanised:
//
//   updateRunWhereState  compare-and-set — reads `(data ?? []).length > 0`
//   cancelRun            reads `(approvals ?? []).length`
//   updateRun/releaseRun go through `ledgerClient()`, which is the service role
//                        unless the caller supplies its own client
//   releaseCardHold      `.eq('status','processing')` — idempotent by design,
//                        and its own comment says so; zero rows means the hold
//                        was already released
//   recordAssistantEvent a `last_used_at` touch that logs and moves on
//   retryPrivatePurchaseAnswer  gated by `ownedApproval()`, not by role
//
// A mechanical rule over those would need four escape hatches, and a guard with
// four escape hatches is false confidence. This is the sibling guard's own
// reasoning about `family_members` and `notifications` — "zero rows is a normal
// outcome and must not be reported as a refusal" — applied one layer down.
//
// FIVE false positives of my own reached before that conclusion, every one from
// matching a name instead of a behaviour: the gate pattern omitted `canManage`;
// the client resolution missed `createServiceClient()` bound to `admin`, and
// then `ledgerClient()`; the rows-back pattern assumed the destructured binding
// is called `data`, so `(approvals ?? []).length` read as unchecked; and its
// search window was too short to reach past an intervening error block. The
// binding is now derived from the destructure rather than assumed.

/** An app-layer refusal of a non-manager, by any of the spellings in use. */
const MANAGER_GATE = /\b(?:isManager|isAdmin|canManage|managerCtx|requireManager|requireManagerContext|assertManager)\s*\(/;

/**
 * True when the write asks for its rows back AND the binding it put them in is
 * read afterwards. The binding name is taken from the destructure rather than
 * assumed to be `data`: assuming that made cancelRun's
 * `(approvals ?? []).length` look like no check at all.
 */
function readsItsRows(body: string): boolean {
  if (!/\.select\(/.test(body)) return false;
  const bindings = [...body.matchAll(/const\s*\{([^}]*)\}\s*=\s*await/g)]
    .flatMap((m) => m[1].split(',').map((part) => part.split(':').pop()!.trim()))
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'error');
  return bindings.some((name) => new RegExp(
    `(?:wroteNoRows|changedNothing)\\(\\s*${name}|!${name}\\b|${name}\\?\\.length|\\(${name} \\?\\? \\[\\]\\)\\.length|${name}\\.length`,
  ).test(body));
}

/**
 * A write that bypasses RLS cannot be filtered by it. `ledgerClient()` in
 * lib/ai/runs/store.ts is one of these: it returns `createServiceClient()`
 * unless the caller supplies its own client or the actor is the system.
 */
const SERVICE_CLIENT = /createServiceClient\s*\(|\bledgerClient\s*\(/;

type Finding = { file: string; line: number; fn: string; writes: string; gated: boolean; rowsBack: boolean; service: boolean };

export function guardedServerWrites(file: string, source: string): Finding[] {
  const out: Finding[] = [];
  const starts = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].index!;
    const body = source.slice(start, i + 1 < starts.length ? starts[i + 1].index! : source.length);
    // The optional `as …)` admits the cast wrapper the Guardian actions use —
    // `(db.from('guardian_contacts') as ReturnType<typeof supabase.from>).update(` —
    // which the first version of this pattern could not see, so an ungated
    // Guardian write passed here while its own test caught it.
    const writes = [...body.matchAll(/\.from\(\s*['"`]([a-z_0-9]+)['"`]\s*\)(?:\s*as\s+[^\n]*?\))?\s*\n?\s*\.(update|delete)\(/g)]
      .filter((m) => GUARDED_TABLES.has(m[1]));
    if (!writes.length) continue;
    out.push({
      file,
      line: source.slice(0, start).split('\n').length,
      fn: starts[i][1],
      writes: [...new Set(writes.map((w) => `${w[1]}.${w[2]}()`))].join(', '),
      gated: MANAGER_GATE.test(body),
      rowsBack: readsItsRows(body),
      service: SERVICE_CLIENT.test(body),
    });
  }
  return out;
}

/** Null when the function is accounted for, otherwise why it is not. */
export function unaccounted(finding: Finding): string | null {
  if (finding.service) return null;
  if (finding.gated) return null;
  if (finding.rowsBack) return null;
  return `${finding.fn}() writes ${finding.writes} through the user client with no manager gate and without asking for its rows back`;
}

/** `'use server'` files under `app/` — the entry points a browser can call. */
function serverActionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && /^\s*['"]use server['"]/.test(readFileSync(full, 'utf8'))) out.push(full);
    }
  };
  walk('app');
  return out;
}

const findings = serverActionFiles().flatMap((f) => guardedServerWrites(f, readFileSync(f, 'utf8')));

describe('a server action does not need RLS to refuse (AUTHZ-010)', () => {
  it('reads the guarded-table list from the guard that established it', () => {
    // If that set shrinks, this rule quietly stops covering tables.
    expect(GUARDED_TABLES.size).toBeGreaterThanOrEqual(44);
    expect(GUARDED_TABLES.has('allowance_rules')).toBe(true);
    expect(GUARDED_TABLES.has('family_places')).toBe(true);
  });

  it('found the server actions the components-only scan cannot see', () => {
    // The scope gap itself, as a number. If this collapses, the walk broke.
    expect(findings.length).toBeGreaterThanOrEqual(12);
    const files = new Set(findings.map((f) => f.file));
    expect([...files].every((f) => f.startsWith('app/'))).toBe(true);
    for (const file of files) {
      expect(readFileSync(file, 'utf8')).toMatch(/^\s*['"]use server['"]/);
    }
  });

  it('the components-only scope is still what that guard scans', () => {
    // This rule exists because of that line. If it widens, say so here.
    const sibling = readFileSync('tests/a-refused-write-is-not-a-success.test.ts', 'utf8');
    expect(sibling).toContain("const ROOTS = ['components']");
  });

  it('every guarded server write refuses a non-manager itself or checks its rows', () => {
    const problems = findings
      .map((f) => ({ f, why: unaccounted(f) }))
      .filter((r) => r.why)
      .map((r) => `${r.f.file}:${r.f.line} — ${r.why}`);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('rejects a function with neither', () => {
    // An absence-only rule is satisfied by a scan that looks nowhere.
    const source = [
      "export async function setRuleActive(input: { id: string; isActive: boolean }) {",
      '  const ctx = await requireUserContext();',
      '  const supabase = await createServer();',
      "  const { error } = await supabase.from('allowance_rules')",
      "    .update({ is_active: input.isActive }).eq('id', input.id).eq('family_id', ctx.active.familyId);",
      '  if (error) return { ok: false, error };',
      '  return { ok: true };',
      '}',
    ].join('\n');
    const [finding] = guardedServerWrites('synthetic.ts', source);
    expect(finding.fn).toBe('setRuleActive');
    expect(finding.writes).toBe('allowance_rules.update()');
    expect(unaccounted(finding)).toMatch(/no manager gate and without asking for its rows back/);
  });

  it('accepts each of the three ways a write is accounted for', () => {
    const base = (middle: string) => [
      'export async function act(input: { id: string }) {',
      '  const ctx = await requireUserContext();',
      middle,
      '}',
    ].join('\n');

    const gated = base([
      "  if (!isManager(ctx.active.role)) return { ok: false, error: 'no' };",
      '  const supabase = await createServer();',
      "  const { error } = await supabase.from('allowance_rules').update({ x: 1 }).eq('id', input.id);",
      '  return { ok: !error };',
    ].join('\n'));
    expect(unaccounted(guardedServerWrites('s.ts', gated)[0])).toBeNull();

    const checked = base([
      '  const supabase = await createServer();',
      "  const { data, error } = await supabase.from('allowance_rules').update({ x: 1 }).eq('id', input.id).select('id');",
      '  if (error || wroteNoRows(data)) return { ok: false };',
      '  return { ok: true };',
    ].join('\n'));
    expect(unaccounted(guardedServerWrites('s.ts', checked)[0])).toBeNull();

    const service = base([
      '  const admin = createServiceClient();',
      "  const { error } = await admin.from('allowance_rules').update({ x: 1 }).eq('id', input.id);",
      '  return { ok: !error };',
    ].join('\n'));
    expect(unaccounted(guardedServerWrites('s.ts', service)[0])).toBeNull();
  });

  it('sees a write through a cast wrapper', () => {
    const cast = [
      'export async function setTrust(id: string) {',
      '  const supabase = await createServer();',
      '  const db = withGuardianTables(supabase);',
      "  const { error } = await (db.from('allowance_rules') as ReturnType<typeof supabase.from>)",
      "    .update({ is_active: false }).eq('id', id);",
      '  return { ok: !error };',
      '}',
    ].join('\n');
    const [finding] = guardedServerWrites('s.ts', cast);
    expect(finding?.writes).toBe('allowance_rules.update()');
    expect(unaccounted(finding)).toMatch(/no manager gate/);
  });

  it('reads a rows-back check whatever the binding is called', () => {
    // Nothing under app/ currently binds its rows to anything but `data`, so
    // the real corpus cannot exercise this — a mutation that hard-coded `data`
    // passed the whole file. The shape is cancelRun's, one layer down, and it is
    // the reason the binding is derived rather than assumed.
    const named = [
      'export async function act(scope: { familyId: string }, runId: string) {',
      '  const db = await createServer();',
      "  const { data: approvals, error } = await db.from('approval_requests')",
      "    .update({ status: 'cancelled' }).eq('family_id', scope.familyId).eq('run_id', runId).select('id');",
      '  if (error) return { ok: false };',
      '  const cancelledApprovals = (approvals ?? []).length;',
      '  return { ok: true, cancelledApprovals };',
      '}',
    ].join('\n');
    const [finding] = guardedServerWrites('s.ts', named);
    expect(finding.gated, 'this body has no role gate, so only the rows check can account for it').toBe(false);
    expect(finding.service).toBe(false);
    expect(finding.rowsBack).toBe(true);
    expect(unaccounted(finding)).toBeNull();

    // And the same body with the check deleted is not accounted for.
    const unread = named.replace('  const cancelledApprovals = (approvals ?? []).length;\n', '');
    const [blind] = guardedServerWrites('s.ts', unread);
    expect(blind.rowsBack).toBe(false);
    expect(unaccounted(blind)).toMatch(/without asking for its rows back/);
  });

  it('counts the three kinds, so a change of shape is visible', () => {
    const service = findings.filter((f) => f.service).length;
    const gated = findings.filter((f) => !f.service && f.gated).length;
    const rows = findings.filter((f) => !f.service && !f.gated && f.rowsBack).length;
    expect(service + gated + rows).toBe(findings.length);
    // Most of these are manager-gated actions; if that stops being true the
    // reasoning in this file's header needs revisiting rather than the number.
    expect(gated).toBeGreaterThanOrEqual(10);
  });
});
