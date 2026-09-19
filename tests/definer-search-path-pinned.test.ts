import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Security ratchet (mandate: close security gaps). Every SECURITY DEFINER function
// runs with the owner's privileges, so it MUST pin `set search_path` — otherwise a
// caller can shadow an unqualified object the body references and have the definer
// execute it with elevated rights (the Supabase `function_search_path_mutable`
// lint). An audit found 2 unpinned definer functions (0014's sync_album_photo_count
// + update_conversation_last_message); 0225 pins them. This guard fails CI if any
// future SECURITY DEFINER function omits `set search_path`.
//
// ── the other half ──────────────────────────────────────────────────────────
//
// Pinning is necessary and is not sufficient, and this file used to stop at
// necessary. `marketplace_create_circle` pinned `set search_path = public` and
// passed the rule above from the day it was written — and failed on every call
// it ever received:
//
//   NOTICE: marketplace_create_circle -> FAILS:
//           function gen_random_bytes(integer) does not exist (42883)
//
// pgcrypto is not in `public`. Supabase installs extensions into a schema called
// `extensions`, so a pin naming only `public` pins away the function the body
// calls. Creating a marketplace circle was broken from 0176 to 0318 — twelve
// migrations after a guard that was watching the exact line and asking the wrong
// question of it.
//
// So the rule below is the completed one: a pinned search_path must REACH what
// the body calls. It covers invoker functions too, because the failure is a
// property of the pin, not of who owns the privileges.
const MIGRATIONS = 'supabase/migrations';

// Built by querying the live database rather than from memory, because the
// interesting part is the exception:
//
//   select p.proname, string_agg(distinct n.nspname, '+')
//   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
//   where n.nspname in ('extensions','pg_catalog') group by 1;
//
//   gen_random_bytes  extensions              -- needs the schema on the path
//   uuid_generate_v4  extensions              -- needs the schema on the path
//   gen_random_uuid   extensions+pg_catalog   -- does NOT: core since PG13
//
// `gen_random_uuid` is the one that matters to get right. It lives in
// `extensions` like the rest, so a list built by reading that schema's contents
// would flag every `default gen_random_uuid()` in the tree — hundreds of false
// positives that would get the whole guard deleted as noise. pg_catalog is
// always implicitly on the search_path, so it resolves anywhere. Confirmed by
// execution: `set search_path = public; select gen_random_uuid()` returns a
// uuid, `select uuid_generate_v4()` raises 42883.
const NEEDS_EXTENSIONS_SCHEMA = [
  'gen_random_bytes', 'digest', 'hmac', 'crypt', 'gen_salt',
  'encrypt', 'decrypt', 'encrypt_iv', 'decrypt_iv',
  'pgp_sym_encrypt', 'pgp_sym_decrypt', 'pgp_pub_encrypt', 'pgp_pub_decrypt',
  'armor', 'dearmor', 'pgp_key_id',
  'uuid_generate_v1', 'uuid_generate_v1mc', 'uuid_generate_v3',
  'uuid_generate_v4', 'uuid_generate_v5',
];

/**
 * SQL comments, removed. The bodies here explain themselves at length — 0314's
 * comment names `translate`, `upper` and the ambiguous characters, and 0318's
 * names `gen_random_bytes` five times while describing the very bug this guard
 * exists to catch. A scan that reads its own explanation as evidence reports
 * the fix as the defect.
 */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

type Def = { file: string; header: string; body: string };

/**
 * Every function's EFFECTIVE definition: `create or replace` means the last
 * migration to define a name is the only one that describes the database, so a
 * guard that flags each historical text would pin 0176 as broken forever and go
 * red no matter what 0318 did.
 */
function effectiveDefinitions(): Map<string, Def> {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  const last = new Map<string, Def>();
  for (const file of files) {
    const sql = readFileSync(`${MIGRATIONS}/${file}`, 'utf8');
    const starts = [...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w".]+)/gi)];
    for (let i = 0; i < starts.length; i++) {
      const from = starts[i].index ?? 0;
      const to = i + 1 < starts.length ? (starts[i + 1].index ?? sql.length) : sql.length;
      const chunk = sql.slice(from, to);
      const bodyAt = chunk.search(/\bas\s*\$|\blanguage\s+(?:sql|plpgsql)/i);
      const name = starts[i][1].replace(/"/g, '').replace(/^public\./, '');
      last.set(name, {
        file,
        header: bodyAt > 0 ? chunk.slice(0, bodyAt + 200) : chunk,
        body: chunk,
      });
    }
  }
  return last;
}

function pinnedSchemas(header: string): string[] | null {
  const match = header.match(/set\s+search_path\s*(?:=|to)\s*([^\n;]+)/i);
  if (!match) return null;
  return match[1].split(',').map((s) => s.trim().replace(/['"]/g, '').toLowerCase());
}

/** Calls in the body that only `extensions` can answer, minus any already qualified. */
function unreachableCalls(body: string): string[] {
  const code = stripComments(body);
  const found = new Set<string>();
  for (const fn of NEEDS_EXTENSIONS_SCHEMA) {
    // A bare call. `extensions.digest(...)` and `public.digest(...)` carry their
    // own schema and do not depend on the path at all.
    const bare = new RegExp(`(^|[^\\w.])${fn}\\s*\\(`, 'i');
    if (bare.test(code)) found.add(fn);
  }
  return [...found];
}

describe('SECURITY DEFINER functions pin search_path', () => {
  const definitions = effectiveDefinitions();

  it('finds the expected large definer-function surface (sanity: parser works)', () => {
    // If the parser silently matched nothing, this would pass vacuously — guard it.
    const anyDefiner = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .some((f) => /security\s+definer/i.test(readFileSync(`${MIGRATIONS}/${f}`, 'utf8')));
    expect(anyDefiner).toBe(true);
    expect(definitions.size).toBeGreaterThan(50);
  });

  it('has zero SECURITY DEFINER functions without set search_path', () => {
    const missing = [...definitions.entries()]
      .filter(([, d]) => /security\s+definer/i.test(d.header) && !/set\s+search_path/i.test(d.header))
      .map(([name, d]) => `${d.file} :: ${name}`);
    expect(missing, `definer functions missing set search_path:\n${missing.join('\n')}`).toEqual([]);
  });
});

describe('a pinned search_path reaches what the body calls', () => {
  const definitions = effectiveDefinitions();

  it('knows which names the pin has to reach for (sanity: the matcher works)', () => {
    // The whole rule rests on telling the two uuid generators apart. If this
    // ever stops holding, the assertion below is either vacuous or a flood.
    expect(unreachableCalls('select gen_random_bytes(8);')).toEqual(['gen_random_bytes']);
    expect(unreachableCalls('select uuid_generate_v4();')).toEqual(['uuid_generate_v4']);
    expect(unreachableCalls('id uuid default gen_random_uuid()')).toEqual([]);
    expect(unreachableCalls('select extensions.digest(x, \'sha256\');')).toEqual([]);
    expect(unreachableCalls('-- we could use gen_random_bytes here\nselect 1;')).toEqual([]);
  });

  it('has no function whose pinned search_path excludes a schema it calls into', () => {
    const offenders: string[] = [];
    for (const [name, def] of definitions) {
      const schemas = pinnedSchemas(def.header);
      if (!schemas) continue; // unpinned is the other rule's business
      if (schemas.includes('extensions')) continue;
      const calls = unreachableCalls(def.body);
      if (calls.length > 0) {
        offenders.push(
          `${def.file} :: ${name} pins [${schemas.join(', ')}] but calls ${calls.join(', ')} — ` +
            "pgcrypto/uuid-ossp live in the 'extensions' schema, so this raises 42883 on every call",
        );
      }
    }
    expect(offenders, `functions whose search_path cannot reach their own calls:\n${offenders.join('\n')}`).toEqual([]);
  });
});
