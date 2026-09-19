// Nine table names in the AI insights route named tables that do not exist.
//
//   care_logs · contacts · family_goals · sports_teams · announcements
//   medical_records · photos · photo_albums · recipes
//
// Each query returned a PostgREST "relation does not exist" error, and every
// one of them was swallowed by the same shape:
//
//   const logs = await eq(sb, 'care_logs', familyId)…;
//   return { care_logs: logs.data ?? [] };        // error discarded, [] returned
//
// `.data ?? []` does not throw, so the route's own try/catch never saw it. The
// empty array then reached a prompt builder whose fallback is a sentence:
//
//   … .join('\n') || 'No care entries logged.'
//
// So the model was told, as fact, that the family had logged no care at all —
// and wrote a confident "AI Care Log Summary" on that basis. Not an error, not
// an empty state: a wrong answer delivered with the same confidence as a right
// one. Eight insight kinds had never worked, and nothing anywhere said so.
//
// It was worse than a name each time. `care_log` stores `log_type` and `note`
// while the prompt read `care_type` and `notes`; `teams` keeps no win/loss
// columns while the prompt printed "W:0 L:0" for every team; `goals` has
// `is_complete`, not `status`, so the route's own `.neq('status','completed')`
// filter would have errored even against the right table; and BOTH halves of
// the medical kind were wrong, because `appointments` stores
// `title/provider/starts_at`, not `appointment_type/provider_name/
// appointment_date`.
//
// This guard holds the seam that allowed it: the table names in the route, and
// the bundle keys the prompts read back. Audit C1-S8-12.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const ROUTE = 'app/api/ai/insights/route.ts';
const PROMPTS = 'lib/ai/insights.ts';

/**
 * Every table the migrations create. Derived from the repository rather than a
 * live database, so this runs in the unit suite — and verified against the
 * replayed schema when it was written: both give 491.
 */
function schemaTables(): Set<string> {
  const dir = path.join(ROOT, 'supabase/migrations');
  const tables = new Set<string>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
    const sql = readFileSync(path.join(dir, f), 'utf8');
    for (const m of sql.matchAll(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi,
    )) tables.add(m[1]);
    for (const m of sql.matchAll(
      /alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+rename\s+to\s+"?([a-z_][a-z0-9_]*)/gi,
    )) tables.add(m[2]);
  }
  return tables;
}

function walk(...dirs: string[]): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) visit(child);
      else out.push(child);
    }
  };
  for (const d of dirs) visit(d);
  return out;
}

/** Table names the insights route queries. */
function queriedTables(): string[] {
  const src = readFileSync(path.join(ROOT, ROUTE), 'utf8');
  const names = new Set<string>();
  for (const m of src.matchAll(/eq\(sb,\s*'([a-z_]+)'/g)) names.add(m[1]);
  for (const m of src.matchAll(/\.from\('([a-z_]+)'\)/g)) names.add(m[1]);
  return [...names].sort();
}

function sourceFiles(): string[] {
  return walk('app', 'lib', 'components').filter((rel) => /\.tsx?$/.test(rel));
}

/**
 * Every `.from('table')` in the tree, with its file and line.
 *
 * `.storage.from('bucket')` names a storage bucket, not a table, and is
 * excluded — including it would report all seven buckets as missing tables.
 */
function everyFromCall(): { table: string; where: string }[] {
  const out: { table: string; where: string }[] = [];
  for (const rel of sourceFiles()) {
    readFileSync(path.join(ROOT, rel), 'utf8').split('\n').forEach((line, i) => {
      if (/storage\s*\.?\s*from\(/.test(line)) return;
      for (const m of line.matchAll(/(?<!storage)\.from\('([a-z_][a-z0-9_]*)'\)/g)) {
        out.push({ table: m[1], where: `${rel}:${i + 1}` });
      }
    });
  }
  return out;
}

/**
 * Helpers that take a TABLE NAME as their second argument. Curated, not
 * inferred: a sweep that assumed every `helper(db, 'x', …)` passed a table
 * reported eleven phantom misses, because `writeSyncState(db, provider, …)`
 * takes a provider, `claimGuardianCallback(client, callbackType, …)` takes a
 * callback type, and `childrenBlockedOn(db, 'push'|'email')` takes a channel.
 * That was the fourth census in this audit to cry wolf the same way.
 */
const TABLE_ARG_HELPERS: { fn: string; file: string }[] = [
  { fn: 'eq', file: ROUTE },
  { fn: 'saveRow', file: 'app/(app)/dashboard/auto/actions.ts' },
  { fn: 'softDelete', file: 'app/(app)/dashboard/auto/actions.ts' },
];

function helperTables(): { table: string; where: string }[] {
  const out: { table: string; where: string }[] = [];
  for (const { fn, file } of TABLE_ARG_HELPERS) {
    const pattern = new RegExp(`\\b${fn}\\((?:sb|supabase|db|client)\\s*,\\s*'([a-z_][a-z0-9_]*)'`, 'g');
    readFileSync(path.join(ROOT, file), 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(pattern)) out.push({ table: m[1], where: `${file}:${i + 1} via ${fn}()` });
    });
  }
  return out;
}

/** Bundle keys the prompt builders read back out of `InsightData.rows`. */
function promptKeys(): string[] {
  const src = readFileSync(path.join(ROOT, PROMPTS), 'utf8');
  return [...new Set([...src.matchAll(/\br\(d,\s*'([a-z_]+)'\)/g)].map((m) => m[1]))].sort();
}

describe('an insight queries a table that exists', () => {
  const tables = schemaTables();

  it('reads a real schema and a real route', () => {
    // Either parse returning nothing would make every assertion below vacuous.
    expect(tables.size).toBeGreaterThan(400);
    expect(tables.has('care_log')).toBe(true);
    expect(tables.has('care_logs')).toBe(false);
    expect(queriedTables().length).toBeGreaterThan(60);
    expect(promptKeys().length).toBeGreaterThan(40);
  });

  it('every table the route queries exists in the schema', () => {
    const missing = queriedTables().filter((t) => !tables.has(t));
    expect(missing, 'the insight will return [] and the model will be told there is no data').toEqual([]);
  });

  it('no .from() call anywhere names a table that does not exist', () => {
    // The insights bug reached production because it used a HELPER; the
    // `.from('x')` form was already clean everywhere. This ratchets that clean
    // state rather than assuming it holds.
    const calls = everyFromCall();
    expect(calls.length, 'the .from() scan found nothing — it is not scanning').toBeGreaterThan(500);
    const missing = calls.filter((c) => !tables.has(c.table))
      .map((c) => `${c.where}: ${c.table}`);
    expect(missing, 'a .from() names a table the migrations never create').toEqual([]);
  });

  it('no table-name helper names a table that does not exist', () => {
    const calls = helperTables();
    expect(calls.length, 'the helper scan found nothing — it is not scanning').toBeGreaterThan(50);
    const missing = calls.filter((c) => !tables.has(c.table))
      .map((c) => `${c.where}: ${c.table}`);
    expect(missing, 'a helper is passed a table the migrations never create').toEqual([]);
  });

  it('every key a prompt reads is a key the route actually returns', () => {
    // The other half of the same seam: a correct query under a key nothing
    // reads is just as silent as a query against a table that is not there.
    const src = readFileSync(path.join(ROOT, ROUTE), 'utf8');
    const returned = new Set([...src.matchAll(/return\s*\{([^}]*)\}/gs)]
      .flatMap((m) => [...m[1].matchAll(/([a-z_]+)\s*:/g)].map((k) => k[1])));
    const orphans = promptKeys().filter((k) => !returned.has(k));
    expect(orphans, 'a prompt reads a bundle key the route never returns').toEqual([]);
  });
});
