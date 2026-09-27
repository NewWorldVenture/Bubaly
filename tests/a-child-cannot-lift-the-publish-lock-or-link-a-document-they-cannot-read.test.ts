import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROLE_ORDER, isManager, type MemberRole } from '../lib/constants/roles';
import { ROLE_PERMISSIONS, SOCIAL_ROLES, defaultSocialRoleForMember, type SocialRole } from '../lib/social/roles';

/**
 * AUTHZ-011. Two write rules that lived only in TypeScript.
 *
 * 1. public.social_settings. updateSettingsAction writes it only after
 *    requireSocialPermission(fid, 'manage_settings'), and the settings page
 *    disables Save for everyone else. 0034's generic loop left INSERT, UPDATE
 *    and DELETE on bare is_family_member(family_id), so a child, a teen, an
 *    adult pinned to read_only or a social_manager teen could turn off
 *    `require_approval` — the family's stop on publishing, read by
 *    needsPublishApproval on every publish — or delete the row (read as "no
 *    approval") straight over /rest/v1.
 *
 * 2. public.vacation_documents.document_id. Its only writer, linkToVacation,
 *    refuses another family's document and a sensitive one for a non-manager.
 *    The foreign-key check runs as the table owner and ignores documents RLS, so
 *    the database accepted both links.
 *
 * 3. The same pair from the documents side. documents_update lets a member of
 *    two households move an ordinary document between them, which left a trip
 *    row pointing across households; a SECURITY DEFINER trigger now refuses
 *    the move while a trip links the document.
 *
 * ── how this test decides, and what it is not ──────────────────────────────
 *
 * The outcome is a decision Postgres makes, so this replays the migration
 * corpus in order — the literal policy and trigger statements AND the ones
 * 0034/0070 build with format() inside `foreach t in array …` loops — and then
 * evaluates each request the way Postgres composes it: a permissive policy must
 * pass and EVERY restrictive one must pass; a BEFORE trigger that fires on the
 * write must let it through. Helper predicates are evaluated from their own
 * definitions in the migration that last defines them (social_has_permission's
 * matrix, social_role_for's defaults, documents_select's expression), so
 * widening one of them moves this test. Anything the evaluator does not
 * recognise is a failure ("teach it"), never a silent pass.
 *
 * It is a model. The proof against a real database is
 * docs/audit/a-child-cannot-lift-the-publish-lock-or-link-a-document-they-cannot-read-check.sql,
 * run by docs/audit/run-probes.sh in CI; this keeps CI honest where no
 * database runs, and goes red if the migration is removed or a guard dropped.
 */

const DIR = 'supabase/migrations';
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

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

/**
 * Each migration, comments stripped, read from disk ONCE. Every helper below
 * scans the whole corpus; re-reading ~365 files per question made single cases
 * cost seconds and brushed vitest's 5 s timeout under a parallel run.
 */
const STRIPPED = new Map<string, string>();
function stripped(file: string): string {
  let text = STRIPPED.get(file);
  if (text === undefined) {
    text = stripComments(readFileSync(`${DIR}/${file}`, 'utf8'));
    STRIPPED.set(file, text);
  }
  return text;
}

/** The balanced parenthesised expression that opens at or after `from`. */
function balanced(text: string, from: number): { inner: string; end: number } | null {
  const start = text.indexOf('(', from);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(start + 1, i).trim(), end: i };
    }
  }
  return null;
}

function exprAfter(text: string, keyword: RegExp): string | null {
  const at = keyword.exec(text);
  return at ? balanced(text, at.index + at[0].length - 1)?.inner ?? null : null;
}

/**
 * A migration's text with every `foreach t in array <var> loop … end loop`
 * whose array names `table` replaced, in place, by the statements its
 * `execute format('…', t)` templates build for that table. Order is kept, so a
 * literal statement later in the same file still wins.
 */
function expandLoopsFor(sql: string, table: string): string {
  const arrays = new Map<string, string[]>();
  for (const m of sql.matchAll(/\b([a-z_][a-z0-9_]*)\s+text\[\]\s*:=\s*array\s*\[([\s\S]*?)\]/gi)) {
    arrays.set(m[1].toLowerCase(), [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  }
  return sql.replace(
    /\bforeach\s+([a-z_][a-z0-9_]*)\s+in\s+array\s+([a-z_][a-z0-9_]*)\s+loop([\s\S]*?)\bend\s+loop\s*;/gi,
    (whole, _var, arrayName: string, body: string) => {
      const members = arrays.get(arrayName.toLowerCase());
      if (!members) throw new Error(`a foreach loop over ${arrayName} whose array this evaluator could not find`);
      if (!members.includes(table)) return whole;
      const built = [...body.matchAll(/\bformat\s*\(\s*'((?:[^']|'')*)'/gi)].map((m) =>
        m[1].replace(/''/g, "'").replace(/%1\$[sI]|%[sI]/g, table),
      );
      return `\n${built.join(';\n')};\n`;
    },
  );
}

type Command = 'select' | 'insert' | 'update' | 'delete' | 'all';
type Policy = { name: string; file: string; permissive: boolean; command: Command; roles: string[]; using: string | null; withCheck: string | null };

const NAME = String.raw`("[^"]+"|[a-z0-9_]+)`;

/** Every policy on `table` still in force after the whole corpus, in order. */
function replayPolicies(table: string): Map<string, Policy> {
  const policies = new Map<string, Policy>();
  const escaped = table.replace('.', '\\.');
  for (const file of FILES) {
    const bare = table.split('.')[1];
    if (!stripped(file).includes(bare)) continue;
    const sql = expandLoopsFor(stripped(file), bare);
    // A policy on this table built by format() OUTSIDE an array loop (say, a
    // `for t in select … from pg_tables` loop) is invisible to this evaluator,
    // and it must say so rather than under-report.
    expect(
      /format\s*\(\s*'[^']*policy[^']*'/i.test(sql) && new RegExp(`format\\s*\\([^;]*\\b${bare}\\b`, 'i').test(sql),
      `${file} builds a policy statement for ${bare} with format() in a shape this evaluator does not expand`,
    ).toBe(false);
    const statement = new RegExp(
      String.raw`\b(drop|create)\s+policy\s+(?:if\s+exists\s+)?${NAME}\s+on\s+${escaped}\b([\s\S]*?);`,
      'gi',
    );
    for (const m of sql.matchAll(statement)) {
      const [, verb, rawName, tailRaw] = m;
      const name = rawName.replace(/"/g, '');
      if (verb.toLowerCase() === 'drop') { policies.delete(name); continue; }
      const tail = tailRaw.replace(/\s+/g, ' ');
      const cmd = /\bfor\s+(all|select|insert|update|delete)\b/i.exec(tail);
      const roles = /\bto\s+((?:[a-z_][a-z0-9_]*\s*,\s*)*[a-z_][a-z0-9_]*)\s*(?=\busing\b|\bwith\s+check\b|$)/i.exec(tail);
      const using = exprAfter(tail, /\busing\s*\(/i);
      const withCheck = exprAfter(tail, /\bwith\s+check\s*\(/i);
      expect(using !== null || withCheck !== null, `policy ${name} in ${file}: no USING or WITH CHECK parsed`).toBe(true);
      policies.set(name, {
        name, file,
        permissive: !/\bas\s+restrictive\b/i.test(tail),
        command: (cmd ? cmd[1].toLowerCase() : 'all') as Command,
        roles: roles ? roles[1].split(',').map((r) => r.trim().toLowerCase()) : [],
        using, withCheck,
      });
    }
  }
  return policies;
}

/** The body of the migration that LAST defines public.<fn>. */
function lastDefinition(fn: string): { file: string; text: string } {
  const create = () => new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?function\s+public\.${fn}\s*\(`, 'gi');
  const defining = FILES.filter((f) => create().test(stripped(f)));
  expect(defining.length, `no migration defines ${fn}`).toBeGreaterThan(0);
  const file = defining.at(-1)!;
  const src = stripped(file);
  const starts = [...src.matchAll(create())];
  const rest = src.slice(starts.at(-1)!.index);
  const tag = /\bas\s+(\$[a-z_]*\$)/i.exec(rest);
  expect(tag, `could not find the body of ${fn} in ${file}`).toBeTruthy();
  const bodyStart = tag!.index + tag![0].length;
  const bodyEnd = rest.indexOf(tag![1], bodyStart);
  return { file, text: rest.slice(0, bodyEnd + tag![1].length) };
}

/** The roles a SECURITY DEFINER household helper admits, read from its definition. */
function rolesInHelper(fn: string): string[] {
  const { text } = lastDefinition(fn);
  const match = /role\s*(?:=\s*'([a-z_]+)'|in\s*\(([^)]*)\))/i.exec(text);
  expect(match, `could not read the role test out of ${fn}`).toBeTruthy();
  if (match![1]) return [match![1]];
  return match![2].split(',').map((r) => r.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

// ── What the database thinks a social role may do ─────────────────────────
const SOCIAL_MATRIX = (() => {
  const { text } = lastDefinition('social_has_permission');
  const matrix = new Map<string, 'all' | string[]>();
  for (const m of text.matchAll(/when\s+'([a-z_]+)'\s+then\s+(true|false|p_permission\s+in\s*\(([^)]*)\))/gi)) {
    matrix.set(m[1], m[2].toLowerCase() === 'true' ? 'all' : m[2].toLowerCase() === 'false' ? [] :
      m[3].split(',').map((p) => p.trim().replace(/^'|'$/g, '')).filter(Boolean));
  }
  return matrix;
})();

const SOCIAL_DEFAULTS = (() => {
  const { text } = lastDefinition('social_role_for');
  const byMember = new Map<string, string>();
  for (const m of text.matchAll(/when\s+'([a-z_]+)'\s+then\s+'([a-z_]+)'::public\.social_role/gi)) byMember.set(m[1], m[2]);
  const fallback = /else\s+'([a-z_]+)'::public\.social_role/i.exec(text)?.[1];
  expect(fallback, 'social_role_for has no fallback role').toBeTruthy();
  return { byMember, fallback: fallback! };
})();

const MANAGERS = rolesInHelper('can_manage_family');

/** A signed-in member of the family whose row is written. */
type Member = { role: MemberRole; override?: SocialRole; clientRole?: 'authenticated' | 'anon' };

function socialRoleInDb(m: Member): string {
  return m.override ?? SOCIAL_DEFAULTS.byMember.get(m.role) ?? SOCIAL_DEFAULTS.fallback;
}

function dbSocialPermission(m: Member, permission: string): boolean {
  const granted = SOCIAL_MATRIX.get(socialRoleInDb(m));
  if (granted === undefined) return false;
  return granted === 'all' || granted.includes(permission);
}

function evalSocialPredicate(expr: string, m: Member): boolean {
  const e = expr.replace(/\s+/g, '').toLowerCase();
  const signedIn = (m.clientRole ?? 'authenticated') === 'authenticated';
  if (e === 'public.is_family_member(family_id)') return signedIn;
  const perm = /^public\.social_has_permission\(family_id,'([a-z_]+)'\)$/.exec(e);
  if (perm) return signedIn && dbSocialPermission(m, perm[1]);
  throw new Error(`cannot evaluate "${expr}" on social_settings; teach this test the predicate rather than deleting the case`);
}

const applies = (p: Policy, cmd: Command, clientRole: string) =>
  (p.command === cmd || p.command === 'all') && (p.roles.length === 0 || p.roles.includes('public') || p.roles.includes(clientRole));

function passes(p: Policy, cmd: Command, ev: (e: string) => boolean): boolean {
  if (cmd === 'insert') { const c = p.withCheck ?? p.using; return c !== null && ev(c); }
  if (cmd === 'update') {
    const after = p.withCheck ?? p.using;
    return (p.using === null || ev(p.using)) && (after === null || ev(after));
  }
  const u = p.using ?? p.withCheck;
  return u !== null && ev(u);
}

function accepts(policies: Map<string, Policy>, cmd: Command, clientRole: string, ev: (e: string) => boolean): boolean {
  const relevant = [...policies.values()].filter((p) => applies(p, cmd, clientRole));
  const permissive = relevant.filter((p) => p.permissive);
  if (!permissive.some((p) => passes(p, cmd, ev))) return false;
  return relevant.filter((p) => !p.permissive).every((p) => passes(p, cmd, ev));
}

const SOCIAL = replayPolicies('public.social_settings');
const settingsWrite = (cmd: Command, m: Member) =>
  accepts(SOCIAL, cmd, m.clientRole ?? 'authenticated', (e) => evalSocialPredicate(e, m));
/** updateSettingsAction's upsert: INSERT … ON CONFLICT (family_id) DO UPDATE needs both. */
const settingsSave = (m: Member) => settingsWrite('insert', m) && settingsWrite('update', m);

const WRITES: Command[] = ['insert', 'update', 'delete'];

describe('the publish lock (social_settings) is only a settings manager’s to change', () => {
  const cannot: [string, Member][] = [
    ['the child (read_only by default)', { role: 'child' }],
    ['a teen on their default (content_creator)', { role: 'teen' }],
    ['an adult a parent pinned to read_only', { role: 'adult', override: 'read_only' }],
    ['a teen given publish rights (social_manager) but not settings', { role: 'teen', override: 'social_manager' }],
  ];

  it.each(cannot)('%s cannot turn off require_approval, plant the row, or delete it', (_label, member) => {
    for (const cmd of WRITES) expect(settingsWrite(cmd, member), cmd).toBe(false);
  });

  it('a teen a parent explicitly made marketing_manager still saves (the guard is not a household-role proxy)', () => {
    // The CENSUS-002 trap: can_manage_family would refuse this teen, whom
    // requireSocialPermission admits, and Save would 500.
    expect(MANAGERS).not.toContain('teen');
    expect(settingsSave({ role: 'teen', override: 'marketing_manager' })).toBe(true);
    expect(settingsWrite('delete', { role: 'teen', override: 'marketing_manager' })).toBe(true);
  });

  it('the parent and an adult on their default still save the family’s settings', () => {
    expect(settingsSave({ role: 'parent' })).toBe(true);
    expect(settingsSave({ role: 'adult' })).toBe(true);
  });

  it('every member can still READ the lock — needsPublishApproval reads it on the publisher’s own client', () => {
    for (const role of ROLE_ORDER) expect(settingsWrite('select', { role }), role).toBe(true);
    expect(settingsWrite('select', { role: 'teen', override: 'social_manager' })).toBe(true);
  });

  it('the screen’s rule and the database’s rule are the same, for every household role and every override', () => {
    // The app: requireSocialPermission(fid,'manage_settings') over ROLE_PERMISSIONS,
    // with defaultSocialRoleForMember when no override exists. The database:
    // whatever the replayed policies decide. Disagreement WAS the defect.
    const disagreements: string[] = [];
    for (const role of ROLE_ORDER) {
      for (const override of [undefined, ...SOCIAL_ROLES]) {
        const effective = override ?? defaultSocialRoleForMember(role);
        const app = ROLE_PERMISSIONS[effective].includes('manage_settings');
        for (const cmd of WRITES) {
          const db = settingsWrite(cmd, { role, override });
          if (db !== app) disagreements.push(`${role}${override ? ` as ${override}` : ''} ${cmd}: app ${app}, database ${db}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('an unauthenticated caller writes nothing', () => {
    for (const cmd of WRITES) expect(settingsWrite(cmd, { role: 'parent', clientRole: 'anon' }), cmd).toBe(false);
  });

  it('the evaluator really replayed the corpus (not vacuous)', () => {
    // 0034's four generic policies came out of the format() loop…
    for (const n of ['select', 'insert', 'update', 'delete']) {
      expect(SOCIAL.get(`social_settings_${n}`)?.permissive, `social_settings_${n}`).toBe(true);
    }
    // …and each write command is held by a restrictive guard.
    for (const cmd of WRITES) {
      expect([...SOCIAL.values()].some((p) => !p.permissive && applies(p, cmd, 'authenticated')), `${cmd} guard`).toBe(true);
    }
    expect(SOCIAL_MATRIX.get('social_manager')).toContain('publish_posts');
    expect(SOCIAL_MATRIX.get('social_manager')).not.toContain('manage_settings');
    expect(SOCIAL_DEFAULTS.byMember.get('teen')).toBe('content_creator');
  });
});

// ── vacation_documents.document_id ────────────────────────────────────────

type Trigger = { name: string; file: string; timing: 'before' | 'after'; insert: boolean; update: boolean; updateColumns: string[] | null; when: string | null; fn: string };

function replayTriggers(bare: string): Map<string, Trigger> {
  const triggers = new Map<string, Trigger>();
  for (const file of FILES) {
    if (!stripped(file).includes(bare)) continue;
    const sql = expandLoopsFor(stripped(file), bare);
    const re = new RegExp(
      String.raw`\b(?:drop\s+trigger\s+(?:if\s+exists\s+)?${NAME}\s+on\s+public\.${bare}\b|create\s+(?:or\s+replace\s+)?trigger\s+${NAME}\s+(before|after)\s+([^;]*?)\s+on\s+public\.${bare}\s+for\s+each\s+row\s+(?:when\s*\(([^;]*?)\)\s*)?execute\s+(?:function|procedure)\s+(?:public\.)?([a-z0-9_]+)\s*\()`,
      'gi',
    );
    for (const m of sql.matchAll(re)) {
      if (m[1]) { triggers.delete(m[1].replace(/"/g, '')); continue; }
      const [, , name, timing, events, when, fn] = m;
      const ev = events.toLowerCase().replace(/\s+/g, ' ');
      const upd = / update(?: of ([a-z0-9_, ]+?))?(?: or |$)/.exec(` ${ev}`);
      triggers.set(name.replace(/"/g, ''), {
        name: name.replace(/"/g, ''), file, timing: timing.toLowerCase() as 'before' | 'after',
        insert: /\binsert\b/.test(ev),
        update: Boolean(upd),
        updateColumns: upd?.[1] ? upd[1].split(',').map((c) => c.trim()) : null,
        when: when ? when.replace(/\s+/g, ' ').trim().toLowerCase() : null,
        fn,
      });
    }
  }
  return triggers;
}

/**
 * The one guard shape this evaluator understands: a trigger function that
 * lets a NULL pointer through, lets an UPDATE that changes neither pointer nor
 * household through, and otherwise requires a POSITIVE lookup of the document
 * in the row's household, raising 42501. Whether that lookup sees every row
 * (SECURITY DEFINER) or only what the caller may read (INVOKER) is read from
 * the definition, because it is the whole difference.
 */
type LinkGuard = { definer: boolean; skipsUnchanged: boolean };

function readLinkGuard(fn: string): LinkGuard {
  const { file, text } = lastDefinition(fn);
  const t = text.replace(/\s+/g, ' ').toLowerCase();
  const header = t.slice(0, t.search(/\bas \$[a-z_]*\$/));
  const lookup = /if exists \( select 1 from public\.documents (\w+) where (.*?)\) then return new; end if;/.exec(t);
  if (!lookup) throw new Error(`${fn} (${file}) is not a positive documents lookup this evaluator understands; teach it`);
  const alias = lookup[1];
  const where = lookup[2];
  if (!where.includes(`${alias}.id = new.document_id`) || !where.includes(`${alias}.family_id = new.family_id`)) {
    throw new Error(`${fn} (${file}) does not look the document up by id AND the row's family`);
  }
  if (!/if new\.document_id is null then return new; end if;/.test(t)) throw new Error(`${fn} does not pass a NULL pointer`);
  if (!/raise exception [^;]*errcode = '42501'/.test(t.slice(lookup.index))) throw new Error(`${fn} does not refuse after the lookup`);
  return {
    definer: /\bsecurity definer\b/.test(header),
    skipsUnchanged: /if tg_op = 'update' and new\.document_id is not distinct from old\.document_id and new\.family_id is not distinct from old\.family_id then return new; end if;/.test(t),
  };
}

/** readLinkGuard, once per function: linkAccepted asks it on every call. */
const LINK_GUARDS = new Map<string, LinkGuard>();
function linkGuard(fn: string): LinkGuard {
  let guard = LINK_GUARDS.get(fn);
  if (guard === undefined) {
    guard = readLinkGuard(fn);
    LINK_GUARDS.set(fn, guard);
  }
  return guard;
}

const DOC_POLICIES = replayPolicies('public.documents');

/** Can this member READ this document, per documents' own replayed SELECT policies? */
function canReadDocument(m: { role: MemberRole; inDocFamily: boolean }, doc: { sensitive: boolean }): boolean {
  const atoms: Record<string, boolean> = {
    'public.is_family_member(family_id)': m.inDocFamily,
    'public.can_manage_family(family_id)': m.inDocFamily && MANAGERS.includes(m.role),
    'public.is_sensitive_document(is_secure,category)': doc.sensitive,
  };
  const evalBool = (expr: string): boolean => {
    // A tiny and/or/not evaluator over the three atoms above.
    const tokens = expr.toLowerCase().replace(/\s+/g, ' ').match(/public\.[a-z_]+\([^)]*\)|\(|\)|\band\b|\bor\b|\bnot\b/g) ?? [];
    let i = 0;
    const primary = (): boolean => {
      const tok = tokens[i++];
      if (tok === 'not') return !primary();
      if (tok === '(') { const v = or(); i += 1; return v; }
      const key = tok?.replace(/\s+/g, '');
      if (key === undefined || !(key in atoms)) throw new Error(`cannot evaluate "${tok}" in documents' SELECT policy; teach this test`);
      return atoms[key];
    };
    const and = (): boolean => { let v = primary(); while (tokens[i] === 'and') { i += 1; const r = primary(); v = v && r; } return v; };
    const or = (): boolean => { let v = and(); while (tokens[i] === 'or') { i += 1; const r = and(); v = v || r; } return v; };
    return or();
  };
  return accepts(DOC_POLICIES, 'select', 'authenticated', evalBool);
}

const VD_TRIGGERS = replayTriggers('vacation_documents');

type LinkWrite =
  | { op: 'insert' }
  | { op: 'update'; columns: string[]; changesPointerOrFamily: boolean };

/** Does the database let `role` point a trip row at this document? */
function linkAccepted(role: MemberRole, doc: { sensitive: boolean; sameFamily: boolean; visibleFamily: boolean }, write: LinkWrite): boolean {
  const firing = [...VD_TRIGGERS.values()].filter((t) => t.timing === 'before' && (
    write.op === 'insert' ? t.insert : t.update && (t.updateColumns === null || t.updateColumns.some((c) => write.columns.includes(c)))
  ));
  for (const trigger of firing) {
    if (trigger.fn === 'set_updated_at') continue;
    if (trigger.when !== null) throw new Error(`${trigger.name} has a WHEN clause (${trigger.when}) this evaluator does not model; teach it`);
    const guard = linkGuard(trigger.fn);
    if (write.op === 'update' && !write.changesPointerOrFamily && guard.skipsUnchanged) continue;
    const visible = guard.definer || canReadDocument({ role, inDocFamily: doc.visibleFamily }, doc);
    if (!(doc.sameFamily && visible)) return false;
  }
  return true;
}

const INSERT: LinkWrite = { op: 'insert' };
const REPOINT: LinkWrite = { op: 'update', columns: ['document_id'], changesPointerOrFamily: true };
const OWN_SENSITIVE = { sensitive: true, sameFamily: true, visibleFamily: true };
const OWN_ORDINARY = { sensitive: false, sameFamily: true, visibleFamily: true };
/** Another household the child ALSO belongs to: the document is visible, just not theirs to link here. */
const OTHER_VISIBLE = { sensitive: false, sameFamily: false, visibleFamily: true };

describe('a trip links only a document the member could open, from its own household', () => {
  it('a child cannot link or repoint a trip to a sensitive document of their family', () => {
    expect(linkAccepted('child', OWN_SENSITIVE, INSERT)).toBe(false);
    expect(linkAccepted('child', OWN_SENSITIVE, REPOINT)).toBe(false);
    expect(linkAccepted('teen', OWN_SENSITIVE, INSERT)).toBe(false);
  });

  it('nobody links another household’s document, even one they can see', () => {
    for (const role of ROLE_ORDER) {
      expect(linkAccepted(role, OTHER_VISIBLE, INSERT), role).toBe(false);
      expect(linkAccepted(role, { ...OTHER_VISIBLE, sensitive: true }, REPOINT), role).toBe(false);
    }
    // Moving a linked row into another household is the same act.
    expect(linkAccepted('child', { ...OWN_ORDINARY, sameFamily: false }, { op: 'update', columns: ['family_id'], changesPointerOrFamily: true })).toBe(false);
  });

  it('the Trip → Documents tab keeps working for a child: notes edits and an unchanged pointer re-sent', () => {
    // TripCrudSection updates the eight form columns and never document_id.
    const formEdit: LinkWrite = { op: 'update', columns: ['title', 'kind', 'member_id', 'number', 'file_url', 'issued_on', 'expires_on', 'notes'], changesPointerOrFamily: false };
    expect(linkAccepted('child', OWN_SENSITIVE, formEdit)).toBe(true);
    // A client that re-sends the whole row, pointer unchanged.
    expect(linkAccepted('child', OWN_SENSITIVE, { op: 'update', columns: ['notes', 'document_id'], changesPointerOrFamily: false })).toBe(true);
    // And an ordinary family document links for anyone.
    for (const role of ROLE_ORDER) expect(linkAccepted(role, OWN_ORDINARY, INSERT), role).toBe(true);
  });

  it('linkToVacation’s rule and the database’s rule are the same set of roles', () => {
    // canReadSensitive(scope) = isManager(scope.role): a sensitive document
    // links for parent/adult only; an ordinary one for everyone.
    for (const role of ROLE_ORDER) {
      expect(linkAccepted(role, OWN_SENSITIVE, INSERT), `${role} sensitive`).toBe(isManager(role));
      expect(linkAccepted(role, OWN_SENSITIVE, REPOINT), `${role} sensitive repoint`).toBe(isManager(role));
    }
  });

  it('the evaluator really replayed the corpus (not vacuous)', () => {
    // 0070's format() loop is what created the updated_at trigger — proof the
    // loop expansion ran for this table.
    expect(VD_TRIGGERS.get('trg_vacation_documents_updated_at')?.fn).toBe('set_updated_at');
    const guards = [...VD_TRIGGERS.values()].filter((t) => t.fn !== 'set_updated_at');
    expect(guards.length, 'a document_id guard trigger on vacation_documents').toBeGreaterThan(0);
    for (const g of guards) {
      expect(g.timing).toBe('before');
      expect(g.insert).toBe(true);
      expect(g.updateColumns ?? ['document_id'], 'fires when document_id is set').toContain('document_id');
    }
    // documents' own SELECT rule hides a sensitive document from a child and
    // shows it to a parent — the read rule the write rule now rests on.
    expect(canReadDocument({ role: 'child', inDocFamily: true }, { sensitive: true })).toBe(false);
    expect(canReadDocument({ role: 'parent', inDocFamily: true }, { sensitive: true })).toBe(true);
    expect(canReadDocument({ role: 'child', inDocFamily: true }, { sensitive: false })).toBe(true);
  });
});

// ── documents.family_id: a linked document does not leave the household ───

/**
 * The documents-side guard: a trigger function that refuses (42501) when a
 * POSITIVE lookup finds a vacation_documents row linking new.id from a
 * household other than new.family_id. Whether that lookup counts every link
 * (SECURITY DEFINER) or only the caller's view of them is read from the
 * definition.
 */
function readMoveGuard(fn: string): { definer: boolean; file: string } {
  const { file, text } = lastDefinition(fn);
  const t = text.replace(/\s+/g, ' ').toLowerCase();
  const header = t.slice(0, t.search(/\bas \$[a-z_]*\$/));
  const lookup = /if exists \( select 1 from public\.vacation_documents (\w+) where (.*?)\) then raise exception '(?:[^']|'')*' using errcode = '42501'; end if; return new;/.exec(t);
  if (!lookup) throw new Error(`${fn} (${file}) is not a vacation_documents lookup that refuses with 42501; teach this test`);
  const [, alias, where] = lookup;
  if (!where.includes(`${alias}.document_id = new.id`) || !where.includes(`${alias}.family_id is distinct from new.family_id`)) {
    throw new Error(`${fn} (${file}) does not look for a link to this document from ANOTHER household`);
  }
  return { definer: /\bsecurity definer\b/.test(header), file };
}

const DOC_TRIGGERS = replayTriggers('documents');
const FAMILY_CHANGED = 'new.family_id is distinct from old.family_id';

/** documents' BEFORE UPDATE triggers other than updated_at: the guards. */
const moveGuards = () => [...DOC_TRIGGERS.values()].filter((t) => t.timing === 'before' && t.update && t.fn !== 'set_updated_at');

type DocUpdate = { columns: string[]; changesFamily: boolean };

/**
 * Do documents' triggers let an UPDATE through that documents_update already
 * admits (the probe's control proves a two-household child IS admitted to
 * move an ordinary document), given whether a trip of the document's CURRENT
 * household links it?
 */
function documentUpdateAccepted(write: DocUpdate, linked: boolean): boolean {
  for (const trigger of moveGuards()) {
    if (trigger.updateColumns !== null && !trigger.updateColumns.some((c) => write.columns.includes(c))) continue;
    if (trigger.when !== null && trigger.when !== FAMILY_CHANGED) {
      throw new Error(`${trigger.name}: WHEN (${trigger.when}) is not modelled; teach this test`);
    }
    if (trigger.when === FAMILY_CHANGED && !write.changesFamily) continue;
    readMoveGuard(trigger.fn);
    // The link sits in the document's current household, so it becomes a link
    // from ANOTHER household exactly when this update changes the household.
    if (linked && write.changesFamily) return false;
  }
  return true;
}

describe('a document a trip links does not leave that trip’s household', () => {
  const MOVE: DocUpdate = { columns: ['family_id'], changesFamily: true };

  it('a linked document cannot be moved into another household', () => {
    // documents_update (0266) admits a member of both households moving an
    // ordinary document; before 0365 that left the trip pointing across.
    expect(documentUpdateAccepted(MOVE, true)).toBe(false);
    // A client that re-sends the whole row with the new household.
    expect(documentUpdateAccepted({ columns: ['title', 'family_id', 'is_favorite'], changesFamily: true }, true)).toBe(false);
  });

  it('an unlinked document still moves, and a linked one is still edited in place', () => {
    expect(documentUpdateAccepted(MOVE, false)).toBe(true);
    // The two UPDATEs the app makes (files-hub, documents module).
    expect(documentUpdateAccepted({ columns: ['is_favorite'], changesFamily: false }, true)).toBe(true);
    expect(documentUpdateAccepted({ columns: ['is_secure'], changesFamily: false }, true)).toBe(true);
    // The whole row re-sent with its household unchanged.
    expect(documentUpdateAccepted({ columns: ['title', 'family_id'], changesFamily: false }, true)).toBe(true);
  });

  it('the guard counts every link, not the caller’s view of them, and nobody can call it', () => {
    const guards = moveGuards();
    expect(guards.length, 'a BEFORE UPDATE guard trigger on documents').toBeGreaterThan(0);
    for (const trigger of guards) {
      const { definer, file } = readMoveGuard(trigger.fn);
      // As the caller, "does ANY trip link this" would become "does any trip I
      // can see link this", and an invisible link would pass as permission.
      expect(definer, `${trigger.fn} is SECURITY DEFINER`).toBe(true);
      const revoke = new RegExp(
        String.raw`\brevoke\s+(?:all|execute)\s+on\s+function\s+public\.${trigger.fn}\s*\(\s*\)\s+from\s+([^;]+);`,
        'i',
      ).exec(stripped(file));
      expect(revoke, `${file} revokes EXECUTE on ${trigger.fn}`).toBeTruthy();
      const from = revoke![1].split(',').map((r) => r.trim().toLowerCase());
      for (const role of ['public', 'anon', 'authenticated']) expect(from, `revoked from ${role}`).toContain(role);
      const regrant = new RegExp(String.raw`\bgrant\s+(?:all|execute)\s+on\s+function\s+public\.${trigger.fn}\b`, 'i');
      expect(FILES.filter((f) => regrant.test(stripped(f))), `a later GRANT on ${trigger.fn}`).toEqual([]);
    }
  });

  it('the evaluator really read the guard’s event list and WHEN clause (not vacuous)', () => {
    // documents' updated_at trigger comes from 0003's `for t in select …`
    // loop, which this evaluator does not expand; it is skipped by name in
    // moveGuards either way. What must be parsed is the guard itself: fired on
    // family_id only, and only when the household really changes, or the
    // "edited in place" cases above would be answered by a different trigger.
    const guard = DOC_TRIGGERS.get('trg_documents_linked_trip_stays_home');
    expect(guard?.timing).toBe('before');
    expect(guard?.insert).toBe(false);
    expect(guard?.updateColumns).toEqual(['family_id']);
    expect(guard?.when).toBe(FAMILY_CHANGED);
  });
});
