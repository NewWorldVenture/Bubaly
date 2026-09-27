import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// DATA-014. A PostgREST `.upsert()` without `onConflict` gets `on conflict
// (<primary key>)`. When the primary key is a generated uuid the payload never
// supplies, that target can never fire: the insert is attempted in full and
// collides with whatever OTHER unique constraint the table carries. The call
// does not quietly do the wrong thing — it fails, 23505 — which means a write
// that works the first time for a family fails every time after.
//
// `billing_customers` was written in three places with the same three columns
// and only the Stripe webhook named `family_id`. Measured against the local
// PostgREST before the fix:
//
//   1st bare upsert  -> ok
//   2nd bare upsert  -> 23505 duplicate key value violates unique constraint
//                       "billing_customers_family_id_key"
//   same + onConflict: 'family_id' -> ok, and it updates
//
// Both call sites sat after `stripe.customers.create` had already returned, so
// each 503 left a real Stripe customer the database never recorded, and a
// retry minted another one.
//
// The rule below is a scan, not a list: every `.upsert(` in the tree must
// either name a conflict target or supply its table's primary key. The primary
// keys are read out of the migrations, and the parser is checked against facts
// it would have to get right, so a parser that stopped resolving tables shows
// up as a failure here rather than as an empty search space.

// ── primary keys, read from the migrations ──────────────────────────────────
function primaryKeys(): Map<string, string[]> {
  const pk = new Map<string, string[]>();
  for (const file of readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join('supabase/migrations', file), 'utf8');
    const create = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
    let m: RegExpExecArray | null;
    while ((m = create.exec(sql))) {
      const [, table, body] = m;
      const lines = body.split('\n').map((l) => l.replace(/--.*$/, '').trim()).filter(Boolean);
      const composite = lines.find((l) => /^primary\s+key\s*\(/i.test(l));
      const inline = lines.find((l) => /\bprimary\s+key\b/i.test(l) && !/^primary\s+key/i.test(l));
      if (composite) pk.set(table, /\(([^)]*)\)/.exec(composite)![1].split(',').map((s) => s.trim()));
      else if (inline) pk.set(table, [inline.split(/\s+/)[0]]);
    }
    const alter = /alter\s+table\s+(?:only\s+)?(?:public\.)?([a-z0-9_]+)[\s\S]*?add\s+(?:constraint\s+\S+\s+)?primary\s+key\s*\(([^)]*)\)/gi;
    while ((m = alter.exec(sql))) pk.set(m[1], m[2].split(',').map((s) => s.trim()));
  }
  return pk;
}

// ── the call sites ──────────────────────────────────────────────────────────
type UpsertSite = {
  file: string;
  line: number;
  table: string | null;
  target: string[] | null;
  call: string;
};

/** The first argument when it is a bare identifier (`.upsert(row, …)`), else null. */
function firstArgumentName(call: string): string | null {
  const m = /^\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,|\))/.exec(call.trim());
  return m ? m[1] : null;
}

/** The text `name` is bound to in `source`, brace-balanced, or '' when unfindable. */
function declarationOf(name: string | null, source: string): string {
  if (!name) return '';
  const decl = new RegExp(`(?:const|let|var)\\s+${name}\\b`);
  const lines = source.split('\n');
  const at = lines.findIndex((l) => decl.test(l));
  if (at < 0) return '';
  let depth = 0;
  let text = '';
  let started = false;
  for (let j = at; j < Math.min(lines.length, at + 60); j++) {
    for (const c of lines[j]) {
      if (c === '{') { depth++; started = true; } else if (c === '}') depth--;
      text += c;
      if (started && depth === 0) return text;
    }
    text += '\n';
    if (started && depth === 0) return text;
  }
  return text;
}

/** Reads `.upsert(` calls out of one source file, with the balanced call text. */
export function upsertSites(file: string, source: string): UpsertSite[] {
  const lines = source.split('\n');
  const sites: UpsertSite[] = [];
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].indexOf('.upsert(');
    if (at < 0) continue;
    let depth = 0;
    let call = '';
    let started = false;
    let done = false;
    for (let j = i; j < Math.min(lines.length, i + 80) && !done; j++) {
      for (let k = j === i ? at + '.upsert'.length : 0; k < lines[j].length; k++) {
        const c = lines[j][k];
        if (c === '(') { depth++; started = true; } else if (c === ')') depth--;
        call += c;
        if (started && depth === 0) { done = true; break; }
      }
      if (!done) call += '\n';
    }
    let table: string | null = null;
    for (let j = i; j >= Math.max(0, i - 15); j--) {
      const from = /\.from\(\s*['"`]([A-Za-z0-9_.]+)['"`]/.exec(lines[j]);
      if (from) { table = from[1].replace(/^public\./, ''); break; }
    }
    const conflict = /onConflict\s*:\s*['"`]([^'"`]+)['"`]/.exec(call);
    sites.push({
      file, line: i + 1, table,
      target: conflict ? conflict[1].split(',').map((s) => s.trim()) : null,
      // The payload is often a variable, not an inline literal. Judging the call
      // text alone reported lib/server/profiles.ts — which passes `id` in a
      // `const row` object three lines up — as broken. The text the rule reads
      // has to include whatever that name is bound to.
      call: call + '\n' + declarationOf(firstArgumentName(call), source),
    });
  }
  return sites;
}

/**
 * Why a site is wrong, or null when it is fine. Two ways to be fine: name the
 * target, or supply the primary key the default target uses. A site whose table
 * cannot be read statically must name the target — "the scanner could not tell"
 * is not a reason to let one through.
 */
export function upsertProblem(site: UpsertSite, pk: Map<string, string[]>): string | null {
  if (!site.table) {
    // "The scanner could not tell" is not a reason to let one through.
    return site.target ? null : 'the table is not statically resolvable and no onConflict is given';
  }
  const key = pk.get(site.table);
  if (!key) return `no primary key found for ${site.table} in the migrations`;
  const supplies = (cols: string[]) =>
    cols.every((c) => new RegExp(`(^|[^A-Za-z0-9_.])${c}\\s*[:,}]`).test(site.call)) || /\.\.\./.test(site.call);

  // An explicitly named target is not automatically a usable one. Naming the
  // primary key on a payload that never supplies it is the same defect as
  // naming nothing — the clause cannot fire either way. This branch exists
  // because a mutation that changed the fix to `onConflict: 'id'` walked
  // straight past the first version of this rule.
  if (site.target) {
    const sameAsPk = site.target.length === key.length && [...site.target].sort().join() === [...key].sort().join();
    if (sameAsPk && !supplies(key)) {
      return `onConflict names the primary key (${key.join(',')}) on ${site.table}, which this payload never supplies`;
    }
    return null;
  }

  // Accept `{ key: v }`, the shorthand `{ key }`, and a spread that may carry it.
  if (supplies(key)) return null;
  return `bare upsert on ${site.table}, whose default target is the primary key (${key.join(',')}) that this payload never supplies`;
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  for (const root of ['app', 'lib', 'components', 'scripts']) walk(root);
  return out;
}

const pk = primaryKeys();
const sites = sourceFiles().flatMap((f) => upsertSites(f, readFileSync(f, 'utf8')));

describe('an upsert names a conflict target that can fire (DATA-014)', () => {
  it('reads the primary keys the rule depends on', () => {
    // If this shrinks, the scan below has stopped looking rather than stopped finding.
    expect(pk.size).toBeGreaterThanOrEqual(491);
    // The three shapes the parser has to handle, and the table this finding was about.
    expect(pk.get('billing_customers')).toEqual(['id']);          // generated uuid
    expect(pk.get('marketing_settings')).toEqual(['key']);        // natural key inline
    expect(pk.get('marketing_provider_syncs')).toEqual(['provider']);
  });

  it('found the upsert call sites to judge', () => {
    // Guards against a walk that quietly matches nothing.
    expect(sites.length).toBeGreaterThanOrEqual(130);
  });

  it('every upsert either names its target or supplies the primary key', () => {
    const problems = sites
      .map((s) => ({ s, why: upsertProblem(s, pk) }))
      .filter((r) => r.why)
      .map((r) => `${r.s.file}:${r.s.line} — ${r.why}`);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('rejects the code this finding was about', () => {
    // The exact call that was in app/api/billing/checkout/route.ts. A rule whose
    // only evidence is that it finds nothing is satisfied by looking nowhere.
    const wasThere = `
      const { error } = await createServiceClient().from('billing_customers').upsert({
        family_id: familyId,
        provider: 'stripe',
        customer_ref: customerId,
      });
    `;
    const [site] = upsertSites('synthetic.ts', wasThere);
    expect(site.table).toBe('billing_customers');
    expect(site.target).toBeNull();
    expect(upsertProblem(site, pk)).toMatch(/default target is the primary key \(id\)/);
  });

  it('resolves a payload that is passed by name', () => {
    // lib/server/profiles.ts is the real shape: `const row = { id: userId, … }`
    // then `.upsert(row, { onConflict: 'id' })`. Reading the call alone called
    // that broken.
    const byName = [
      "const row = { id: userId, full_name: name, phone };",
      "const { error } = await svc.from('profiles').upsert(row, { onConflict: 'id' });",
    ].join('\n');
    const [site] = upsertSites('synthetic.ts', byName);
    expect(site.table).toBe('profiles');
    expect(site.target).toEqual(['id']);
    expect(upsertProblem(site, pk)).toBeNull();
  });

  it('still rejects a payload passed by name that omits the key', () => {
    const byName = [
      "const row = { family_id: familyId, provider: 'stripe', customer_ref: ref };",
      "const { error } = await svc.from('billing_customers').upsert(row, { onConflict: 'id' });",
    ].join('\n');
    const [site] = upsertSites('synthetic.ts', byName);
    expect(upsertProblem(site, pk)).toMatch(/names the primary key \(id\).*never supplies/);
  });

  it('rejects a named target that cannot fire either', () => {
    // `onConflict: 'id'` looks deliberate and is just as dead as no target at
    // all when the payload has no id. Found by mutating the fix, not by reading.
    const named = `await db.from('billing_customers').upsert({ family_id: familyId, provider: 'stripe', customer_ref: ref }, { onConflict: 'id' });`;
    const [site] = upsertSites('synthetic.ts', named);
    expect(site.target).toEqual(['id']);
    expect(upsertProblem(site, pk)).toMatch(/names the primary key \(id\).*never supplies/);
  });

  it('accepts a named target that is not the primary key', () => {
    const named = `await db.from('billing_customers').upsert({ family_id: familyId, provider: 'stripe', customer_ref: ref }, { onConflict: 'family_id' });`;
    const [site] = upsertSites('synthetic.ts', named);
    expect(upsertProblem(site, pk)).toBeNull();
  });

  it('accepts a bare upsert when the natural key IS the primary key', () => {
    const fine = `await supabase.from('marketing_settings').upsert({ key, value: { text: value }, updated_by: actorId });`;
    const [site] = upsertSites('synthetic.ts', fine);
    expect(upsertProblem(site, pk)).toBeNull();
  });

  it('does not let an unresolvable table through', () => {
    const opaque = `const writer = supabase.from(target as any) as any;\nawait writer.upsert(payload);`;
    const [site] = upsertSites('synthetic.ts', opaque);
    expect(site.table).toBeNull();
    expect(upsertProblem(site, pk)).toMatch(/not statically resolvable/);
  });
});

/** Comments explain a rule; they do not enforce one. Matched against code only. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('billing_customers has one writer (DATA-014)', () => {
  const helper = withoutComments(readFileSync('lib/billing/customer-ref.ts', 'utf8'));

  it('the helper names the constraint that actually exists', () => {
    // Deliberately matched on the stripped source: the first version of this
    // assertion read the whole file, and the doc comment above the query
    // satisfied it on its own while the argument had been deleted.
    expect(helper).toContain("onConflict: 'family_id'");
    // `family_id` is what carries the unique constraint; `id` is the PK the
    // default target would have used.
    const table = readFileSync('supabase/migrations/0002_tables.sql', 'utf8');
    const block = /create table if not exists public\.billing_customers \(([\s\S]*?)\n\);/.exec(table)![1];
    expect(block).toMatch(/id\s+uuid primary key default gen_random_uuid\(\)/);
    expect(block).toMatch(/family_id\s+uuid not null unique/);
  });

  it('nothing else writes the row', () => {
    const writers = sourceFiles()
      .filter((f) => f !== 'lib/billing/customer-ref.ts')
      .flatMap((f) => {
        const src = readFileSync(f, 'utf8');
        return [...src.matchAll(/\.from\(\s*['"`]billing_customers['"`]\s*\)\s*\n?\s*\.?\s*(upsert|insert|update|delete)\b/g)]
          .map((m) => `${f} — .${m[1]}()`);
      });
    expect(writers, writers.join('\n')).toEqual([]);
  });

  it('all three former call sites go through the helper', () => {
    for (const file of [
      'app/api/billing/checkout/route.ts',
      'app/api/billing/change-plan/route.ts',
      'app/api/webhooks/stripe/route.ts',
    ]) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).toContain("from '@/lib/billing/customer-ref'");
      expect(src, file).toContain('rememberStripeCustomer(');
    }
  });

  it('the helper treats a missing customer_ref in the response as a failed write', () => {
    // `.select()` is evidence the statement landed; a row without the ref is not
    // a success just because no error came back.
    expect(helper).toMatch(/if \(!stored\) return \{ ok: false/);
  });
});
