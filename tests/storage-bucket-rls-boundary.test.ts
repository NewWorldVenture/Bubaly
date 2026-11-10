import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-11 storage boundary. Supabase Storage RLS lives on storage.objects, keyed by
// bucket_id + the object path's first folder segment. Two invariants must never
// regress, because a slip is a silent cross-tenant / PII leak:
//   1. Buckets holding sensitive data (documents = passports/IDs/insurance,
//      chore-proof = photos of children) MUST be created private (public=false).
//   2. Family-scoped buckets MUST gate every write to is_family_member of the
//      folder segment, so a member of family A can't upload into family B's folder.
// This guard reads the migration SQL so a future migration that flips a private
// bucket public, or drops the folder-scope check, fails CI.

const migDir = 'supabase/migrations';
const allSql = readdirSync(migDir)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(`${migDir}/${f}`, 'utf8'))
  .join('\n');

// Collapse whitespace so assertions are robust to SQL formatting/newlines.
const flat = allSql.replace(/\s+/g, ' ');

const PRIVATE_BUCKETS = ['documents', 'chore-proof'];
const FAMILY_SCOPED_BUCKETS = ['documents', 'chore-proof', 'family-media'];

// The LIVE policy set. The concatenation above still contains every policy a
// later migration dropped or replaced, so a positive match over it cannot see a
// regression. Replay the migrations in the order they apply (file name order),
// honouring `drop policy` and `create policy`, and keep what is left standing.
const liveSql = readdirSync(migDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(`${migDir}/${f}`, 'utf8').replace(/--.*$/gm, ''))
  .join('\n')
  .replace(/\s+/g, ' ')
  .toLowerCase();

function liveStoragePolicies(): Map<string, string> {
  const live = new Map<string, string>();
  const statement = /(drop policy if exists|create policy) "([^"]+)" on storage\.objects([^;]*);/g;
  for (const m of liveSql.matchAll(statement)) {
    if (m[1] === 'create policy') live.set(m[2], m[3]);
    else live.delete(m[2]);
  }
  return live;
}

// The body of the latest definition of a SQL helper a policy delegates to.
function liveFunctionBody(name: string): string {
  const escaped = name.replace(/[.]/g, '\\.');
  const defs = [...liveSql.matchAll(new RegExp(`create or replace function ${escaped}\\(.*?\\$\\$(.*?)\\$\\$`, 'g'))];
  return defs.length > 0 ? defs[defs.length - 1][1] : '';
}

const DIRECT_FOLDER_GATE = /^ and (?:public\.)?is_family_member\(\(\(storage\.foldername\(name\)\)\[1\]\)::uuid\)/;
const HELPER_GATE = /^ and ([a-z_]+\.[a-z_]+)\(name[,)]/;

// True when the live helper reads the family from the FIRST path segment and
// refuses a caller who is not a member of that family.
function helperGatesOnFolderMembership(name: string): boolean {
  const body = liveFunctionBody(name);
  const family = body.match(/([a-z_]+) := (?:\(\(storage\.foldername\(p_name\)\)\[1\]\)|parts\[1\])::uuid/);
  if (!family) return false;
  return body.includes(`public.is_family_member(${family[1]})`);
}

describe('A-11 storage bucket RLS boundary', () => {
  it('creates the sensitive buckets as PRIVATE (public=false)', () => {
    for (const b of PRIVATE_BUCKETS) {
      // e.g. VALUES ('documents', 'documents', false, ...)
      const created = new RegExp(`'${b}'\\s*,\\s*'${b}'\\s*,\\s*false`, 'i');
      expect(flat, `${b} must be created private`).toMatch(created);
    }
  });

  it('never (re)creates a sensitive bucket as public=true', () => {
    for (const b of PRIVATE_BUCKETS) {
      const madePublic = new RegExp(`'${b}'\\s*,\\s*'${b}'\\s*,\\s*true`, 'i');
      expect(flat, `${b} must never be made public`).not.toMatch(madePublic);
      // also guard an UPDATE ... set public = true on the sensitive bucket
      const flippedPublic = new RegExp(`update\\s+storage\\.buckets\\s+set\\s+public\\s*=\\s*true[^;]*'${b}'`, 'i');
      expect(flat, `${b} must not be flipped public via UPDATE`).not.toMatch(flippedPublic);
    }
  });

  it('gates every family-scoped bucket write to is_family_member of the folder', () => {
    for (const b of FAMILY_SCOPED_BUCKETS) {
      // The bucket must appear tied to a family-membership folder check somewhere.
      const scoped = new RegExp(
        `bucket_id\\s*=\\s*'${b}'[^;]*is_family_member\\(\\(\\(storage\\.foldername\\(name\\)\\)\\[1\\]\\)::uuid\\)`,
        'i',
      );
      expect(flat, `${b} writes must be folder-scoped to is_family_member`).toMatch(scoped);
    }

    // …and every write policy still standing after the last migration must
    // carry that check itself, or hand the object name to a helper that does.
    const live = [...liveStoragePolicies()];
    for (const b of FAMILY_SCOPED_BUCKETS) {
      const bucket = `bucket_id = '${b}'`;
      const writes = live.filter(([, body]) => body.includes(bucket) && !/\bfor select\b/.test(body));
      const names = writes.map(([name]) => name);
      expect(
        writes.some(([, body]) => /\bfor (?:insert|all)\b/.test(body)),
        `${b} must keep a live upload policy (found: ${names.join(', ')})`,
      ).toBe(true);
      for (const [name, body] of writes) {
        const predicates = body.split(bucket).slice(1);
        expect(predicates.length, `"${name}" must name the ${b} bucket`).toBeGreaterThan(0);
        for (const predicate of predicates) {
          const helper = predicate.match(HELPER_GATE);
          const gated = DIRECT_FOLDER_GATE.test(predicate) || (helper !== null && helperGatesOnFolderMembership(helper[1]));
          expect(gated, `live policy "${name}" must gate ${b} writes to is_family_member of the folder`).toBe(true);
        }
      }
    }
  });

  it('scopes the sensitive buckets read policy to the family (not public SELECT)', () => {
    for (const b of PRIVATE_BUCKETS) {
      // there must be a family-scoped SELECT for the bucket…
      const familySelect = new RegExp(
        `for\\s+select[^;]*bucket_id\\s*=\\s*'${b}'[^;]*is_family_member`,
        'i',
      );
      expect(flat, `${b} read must be family-scoped`).toMatch(familySelect);
      // …and NOT an unconditional public SELECT (bucket_id = 'x' with no membership check)
      const publicSelect = new RegExp(
        `for\\s+select\\s+using\\s*\\(\\s*bucket_id\\s*=\\s*'${b}'\\s*\\)`,
        'i',
      );
      expect(flat, `${b} must not have an unconditional public SELECT`).not.toMatch(publicSelect);
    }
  });
});
