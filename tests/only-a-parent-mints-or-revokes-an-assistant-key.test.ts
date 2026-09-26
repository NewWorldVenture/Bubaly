import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROLE_ORDER, isAdmin, type MemberRole } from '../lib/constants/roles';

/**
 * An assistant key is a standing bearer grant over the household: hold it and
 * POST /api/assistant will read the family's calendar, tasks and shopping list
 * out loud and write events, notes, groceries and to-dos back (lib/assistant/
 * service.ts). app/(app)/dashboard/assistants/actions.ts says who may hand one
 * out — `canManage = isAdmin(role)`, i.e. a parent — and refuses everyone else
 * at :37 and :78. Migration 0283's own header says the same thing in words:
 * "only a parent/admin can create or revoke one".
 *
 * The database did not say it. 0283 wrote its INSERT/UPDATE/DELETE policies
 * against can_manage_family(), which is parent OR adult, and granted
 * `insert, update, delete` on the table to `authenticated`. Both of the action's
 * writes go through the SERVICE-ROLE client, which is BYPASSRLS — so on the
 * app's own path RLS never runs and the parent-only rule was a TypeScript `if`,
 * while /rest/v1/assistant_links stayed reachable with any member's own JWT.
 * An adult could therefore mint a key whose secret only they knew, widen a
 * parent's read-only kitchen speaker to one that writes, revoke or un-revoke a
 * parent's key, or DELETE one — which cascades assistant_link_events and erases
 * the "every use is recorded" trail the page promises at page.tsx:150.
 *
 * ── why this test is built the way it is ──────────────────────────────────────
 *
 * The outcome that matters is a decision Postgres makes: given a signed-in
 * member of a family, does the database accept their write to assistant_links?
 * Asserting that some migration CONTAINS a policy line does not answer that —
 * a later migration can drop it, a permissive policy can be added beside it, the
 * grant can move, and the string is still there. So this reads the WHOLE
 * migration corpus in order, replays every create/drop policy and every
 * grant/revoke on public.assistant_links, and then evaluates the request the way
 * Postgres does: the command must be granted to the client role, at least one
 * PERMISSIVE policy must pass, and EVERY RESTRICTIVE policy must pass.
 *
 * The predicates are evaluated from their own definitions — can_manage_family
 * and is_family_admin are parsed out of the migration that defines them — so
 * widening either function moves this test, and an unrecognised predicate or an
 * unparseable policy is a failure rather than a silent pass.
 *
 * The live half was run by hand against a replay of all 353 migrations: before
 * the fix an `adult` minted an ask+capture key with a token_hash of their own
 * choosing attributed to the parent, widened the parent's read-only speaker,
 * revoked and un-revoked it, and deleted it (audit rows 1 -> 0); after
 * 0343 the same four attempts are "new row violates row-level security policy
 * assistant_links_admin_insert_guard" and UPDATE 0 / UPDATE 0 / DELETE 0, while
 * the parent still inserts, updates and deletes and the adult still SELECTs.
 */

const TABLE = 'public.assistant_links';
const DIR = 'supabase/migrations';

/** Strip `--` comments without eating apostrophes that live inside them. */
function stripComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      let quotes = 0;
      for (let i = 0; i < line.length - 1; i += 1) {
        if (line[i] === "'") quotes += 1;
        else if (line[i] === '-' && line[i + 1] === '-' && quotes % 2 === 0) return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/** The parenthesised expression that follows `keyword`, or null. */
function exprAfter(text: string, keyword: RegExp): string | null {
  const at = keyword.exec(text);
  if (!at) return null;
  let i = text.indexOf('(', at.index + at[0].length - 1);
  if (i < 0) return null;
  let depth = 0;
  const start = i;
  for (; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(start + 1, i).trim();
    }
  }
  return null;
}

type Command = 'select' | 'insert' | 'update' | 'delete' | 'all';

type Policy = {
  name: string;
  file: string;
  permissive: boolean;
  command: Command;
  roles: string[]; // empty = PUBLIC, i.e. every role
  using: string | null;
  withCheck: string | null;
};

type State = {
  policies: Map<string, Policy>;
  /** privilege -> set of roles holding it at table level */
  grants: Map<string, Set<string>>;
  /** role -> columns it may SELECT, when SELECT is granted per column */
  columnSelect: Map<string, Set<string>>;
  creates: number;
  drops: number;
};

function replayMigrations(): State {
  const state: State = {
    policies: new Map(), grants: new Map(), columnSelect: new Map(), creates: 0, drops: 0,
  };
  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  expect(files.length, 'no migrations found').toBeGreaterThan(300);

  for (const file of files) {
    const raw = readFileSync(`${DIR}/${file}`, 'utf8');
    if (!raw.includes('assistant_links')) continue;
    const sql = stripComments(raw);

    // A policy statement on this table can only be written one of two ways: as a
    // literal `create policy … on public.assistant_links`, or built with
    // format() the way 0310 does. If a migration ever names the table inside a
    // format() template, this evaluator no longer sees the whole picture and must
    // say so rather than quietly under-report.
    expect(
      /format\([^)]*assistant_links/is.test(sql),
      `${file} builds a statement for assistant_links with format(); this evaluator only replays literal policy statements`,
    ).toBe(false);

    for (const m of sql.matchAll(/\bdrop\s+policy\s+(?:if\s+exists\s+)?([a-z0-9_]+)\s+on\s+public\.assistant_links\b/gis)) {
      state.drops += 1;
      state.policies.delete(m[1]);
    }

    for (const m of sql.matchAll(
      /\bcreate\s+policy\s+([a-z0-9_]+)\s+on\s+public\.assistant_links\b([\s\S]*?);/gis,
    )) {
      state.creates += 1;
      const [, name, tailRaw] = m;
      const tail = tailRaw.replace(/\s+/g, ' ');
      const permissive = !/\bas\s+restrictive\b/i.test(tail);
      const cmdMatch = /\bfor\s+(all|select|insert|update|delete)\b/i.exec(tail);
      const command = (cmdMatch ? cmdMatch[1].toLowerCase() : 'all') as Command;
      const rolesMatch = /\bto\s+((?:[a-z_][a-z0-9_]*\s*,\s*)*[a-z_][a-z0-9_]*)\s*(?=\busing\b|\bwith\s+check\b|$)/i.exec(tail);
      const roles = rolesMatch ? rolesMatch[1].split(',').map((r) => r.trim()) : [];
      const using = exprAfter(tail, /\busing\s*\(/i);
      const withCheck = exprAfter(tail, /\bwith\s+check\s*\(/i);
      expect(
        using !== null || withCheck !== null,
        `policy ${name} in ${file}: neither USING nor WITH CHECK could be parsed`,
      ).toBe(true);
      state.policies.set(name, { name, file, permissive, command, roles, using, withCheck });
    }

    for (const m of sql.matchAll(
      /\b(grant|revoke)\s+([a-z ,]*?(?:\([^)]*\))?[a-z ,]*?)\s+on\s+public\.assistant_links\s+(?:to|from)\s+((?:[a-z_][a-z0-9_]*\s*,\s*)*[a-z_][a-z0-9_]*)/gis,
    )) {
      const [, verb, privRaw, roleRaw] = m;
      const roles = roleRaw.split(',').map((r) => r.trim().toLowerCase());
      // `grant select (col, col) …` is a COLUMN privilege, not a table one. It is
      // how 0283 withholds token_hash while leaving the rest readable, so it has
      // to be replayed separately or "can a member see their speakers" reads as
      // no.
      if (privRaw.includes('(')) {
        const columns = new Set(
          (/\(([^)]*)\)/.exec(privRaw)?.[1] ?? '').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean),
        );
        const priv = privRaw.slice(0, privRaw.indexOf('(')).trim().toLowerCase();
        expect(priv, `column-level ${priv} on ${TABLE} is not modelled here`).toBe('select');
        for (const role of roles) {
          if (verb.toLowerCase() !== 'grant') { state.columnSelect.delete(role); continue; }
          const held = state.columnSelect.get(role) ?? new Set<string>();
          for (const c of columns) held.add(c);
          state.columnSelect.set(role, held);
        }
        continue;
      }
      const privs = privRaw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
      for (const priv of privs) {
        if (priv === 'select' && verb.toLowerCase() === 'revoke') {
          for (const role of roles) state.columnSelect.delete(role);
        }
        const held = state.grants.get(priv) ?? new Set<string>();
        for (const role of roles) {
          if (verb.toLowerCase() === 'grant') held.add(role);
          else held.delete(role);
        }
        state.grants.set(priv, held);
      }
    }
  }
  return state;
}

/** The roles a SECURITY DEFINER helper admits, read from the migration in force. */
function rolesInSqlFunction(fn: string): string[] {
  const defining = readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => readFileSync(`${DIR}/${f}`, 'utf8').includes(`function public.${fn}(`));
  expect(defining.length, `no migration defines ${fn}`).toBeGreaterThan(0);
  const src = readFileSync(`${DIR}/${defining.at(-1)}`, 'utf8');
  const body = src.slice(src.indexOf(`function public.${fn}(`));
  const match = /role\s*(?:=\s*'([a-z_]+)'|in\s*\(([^)]*)\))/i.exec(body);
  expect(match, `could not read the role test out of ${fn}`).toBeTruthy();
  if (match![1]) return [match![1]];
  return match![2].split(',').map((r) => r.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

const MANAGERS = rolesInSqlFunction('can_manage_family');
const ADMINS = rolesInSqlFunction('is_family_admin');

/** A signed-in, active member of the family whose row is being written. */
type Actor = { role: MemberRole; clientRole: 'authenticated' | 'anon' };

function evalPredicate(expr: string, actor: Actor): boolean {
  const e = expr.replace(/\s+/g, '').toLowerCase();
  // anon carries no auth.uid(), so every membership helper is false for it.
  const signedIn = actor.clientRole === 'authenticated';
  if (e === 'public.is_family_member(family_id)' || e === 'is_family_member(family_id)') return signedIn;
  if (e === 'public.can_manage_family(family_id)' || e === 'can_manage_family(family_id)') {
    return signedIn && MANAGERS.includes(actor.role);
  }
  if (e === 'public.is_family_admin(family_id)' || e === 'is_family_admin(family_id)') {
    return signedIn && ADMINS.includes(actor.role);
  }
  throw new Error(
    `this test cannot evaluate the policy predicate "${expr}" on ${TABLE}; ` +
      'teach it the predicate rather than deleting the case',
  );
}

const applies = (p: Policy, cmd: Command, actor: Actor) =>
  (p.command === cmd || p.command === 'all') && (p.roles.length === 0 || p.roles.includes(actor.clientRole));

/** What the policy for `cmd` has to satisfy, exactly as Postgres composes it. */
function policyPasses(p: Policy, cmd: Command, actor: Actor): boolean {
  if (cmd === 'insert') {
    const check = p.withCheck ?? p.using;
    return check === null ? false : evalPredicate(check, actor);
  }
  if (cmd === 'update') {
    // USING picks the row, WITH CHECK validates the new one; WITH CHECK defaults
    // to USING when omitted. Both must hold.
    const before = p.using;
    const after = p.withCheck ?? p.using;
    return (before === null || evalPredicate(before, actor)) && (after === null || evalPredicate(after, actor));
  }
  const using = p.using ?? p.withCheck;
  return using === null ? false : evalPredicate(using, actor);
}

/**
 * Does the database accept this member's `cmd` on their own family's
 * assistant_links row? Grant first, then the permissive union, then every
 * restrictive guard.
 */
function databaseAccepts(state: State, cmd: Command, actor: Actor): boolean {
  const holders = state.grants.get(cmd) ?? new Set<string>();
  const byColumn = cmd === 'select' && (state.columnSelect.get(actor.clientRole)?.size ?? 0) > 0;
  if (!holders.has(actor.clientRole) && !byColumn) return false;
  const relevant = [...state.policies.values()].filter((p) => applies(p, cmd, actor));
  const permissive = relevant.filter((p) => p.permissive);
  const restrictive = relevant.filter((p) => !p.permissive);
  if (permissive.length === 0) return false;
  if (!permissive.some((p) => policyPasses(p, cmd, actor))) return false;
  return restrictive.every((p) => policyPasses(p, cmd, actor));
}

const state = replayMigrations();
const asMember = (role: MemberRole): Actor => ({ role, clientRole: 'authenticated' });
const WRITES: Command[] = ['insert', 'update', 'delete'];

describe('only a parent mints or revokes an assistant key', () => {
  it('an adult of the household cannot mint a key that speaks and writes for the family', () => {
    // The whole finding in one line: an adult, signed in, calling PostgREST
    // directly with their own token, inserting a row whose token_hash is a
    // secret they chose. That row is a working bearer credential for
    // /api/assistant.
    expect(databaseAccepts(state, 'insert', asMember('adult'))).toBe(false);
  });

  it('an adult cannot widen a parent’s read-only speaker, nor revoke or resurrect a key', () => {
    // One UPDATE flipped scopes ['ask'] -> ['ask','capture'], so the shared-room
    // speaker the parent deliberately made read-only started creating events and
    // shopping items; another set or cleared revoked_at.
    expect(databaseAccepts(state, 'update', asMember('adult'))).toBe(false);
  });

  it('an adult cannot delete a key and take the "every use is recorded" trail with it', () => {
    // assistant_link_events is ON DELETE CASCADE from assistant_links, so a row
    // delete is an audit delete.
    expect(databaseAccepts(state, 'delete', asMember('adult'))).toBe(false);
  });

  it('a parent still hands out, revokes and removes keys', () => {
    for (const cmd of WRITES) {
      expect(databaseAccepts(state, cmd, asMember('parent')), `parent ${cmd}`).toBe(true);
    }
  });

  it('every member can still SEE which speakers are connected', () => {
    // The Assistants page lists the family's links for everyone (page.tsx:69-94)
    // and the fix must not turn that into an empty list.
    for (const role of ROLE_ORDER) {
      expect(databaseAccepts(state, 'select', asMember(role)), `${role} select`).toBe(true);
    }
  });

  it('the screen’s rule and the database’s rule are now the same set of roles', () => {
    // actions.ts refuses everyone but a parent. Before 0343 the database admitted
    // parent AND adult, and that disagreement WAS the defect. Comparing the two
    // sets is the assertion that cannot drift: widen either side and this fails.
    const fromScreen = ROLE_ORDER.filter((role) => isAdmin(role));
    for (const cmd of WRITES) {
      const fromDatabase = ROLE_ORDER.filter((role) => databaseAccepts(state, cmd, asMember(role)));
      expect(fromDatabase, `roles the database lets ${cmd} an assistant key`).toEqual(fromScreen);
    }
  });

  it('an unauthenticated caller is refused (a grant regression guard, not a test of 0343)', () => {
    // What this does and does not show. The corpus never grants a write on this
    // table to anon — 0283:96 names `authenticated` only — so in this model anon
    // is refused at the GRANT, before any policy is read, and this case passes
    // with or without 0343. It is kept as a regression guard on the grant: a
    // later `grant … to anon` would turn it red. On a real Supabase project the
    // default privileges DO leave anon holding INSERT/UPDATE/DELETE on new
    // tables; there the refusal comes from can_manage_family (auth.uid() is null
    // for anon) and 0343's guards, which name anon as belt and braces.
    for (const cmd of WRITES) {
      expect(databaseAccepts(state, cmd, { role: 'parent', clientRole: 'anon' }), `anon ${cmd}`).toBe(false);
    }
  });

  it('the evaluator is not vacuous — it really replayed the policies and grants', () => {
    // Every claim above is false-if-unparsed, so prove the parse happened.
    expect(state.creates, 'create policy statements seen').toBeGreaterThanOrEqual(7);
    expect(state.policies.size, 'policies left in force').toBeGreaterThanOrEqual(7);
    for (const cmd of WRITES) {
      expect([...(state.grants.get(cmd) ?? [])], `${cmd} grant holders`).toContain('authenticated');
    }
    // SELECT is granted per column, which is how the secret stays unreadable.
    const readable = state.columnSelect.get('authenticated') ?? new Set<string>();
    expect([...readable], 'the columns the page lists').toEqual(expect.arrayContaining(['label', 'scopes', 'revoked_at']));
    expect([...readable], 'nobody reads a key’s secret').not.toContain('token_hash');
    // A restrictive guard for each write command, and at least one permissive
    // policy left standing (a table with no permissive policy refuses everyone,
    // which would make the adult cases pass for the wrong reason).
    for (const cmd of WRITES) {
      const relevant = [...state.policies.values()].filter((p) => applies(p, cmd, asMember('adult')));
      expect(relevant.some((p) => p.permissive), `a permissive ${cmd} policy still exists`).toBe(true);
      expect(relevant.some((p) => !p.permissive), `a restrictive ${cmd} guard exists`).toBe(true);
    }
    // And the role gap this is about is real: can_manage_family admits an adult,
    // is_family_admin does not. If that stopped being true the cases above would
    // pass without proving anything.
    expect(MANAGERS).toContain('adult');
    expect(ADMINS).not.toContain('adult');
    expect(ADMINS).toEqual(['parent']);
  });

  it('the guard survives a replay of its own migration', () => {
    // Migrations get re-applied against databases that already have them.
    const file = readdirSync(DIR).find((f) => f.includes('assistant_key'));
    expect(file, 'the parent-only assistant_links migration is missing').toBeTruthy();
    const sql = readFileSync(`${DIR}/${file}`, 'utf8');
    for (const guard of ['insert', 'update', 'delete']) {
      expect(sql).toContain(`drop policy if exists assistant_links_admin_${guard}_guard`);
    }
  });
});
