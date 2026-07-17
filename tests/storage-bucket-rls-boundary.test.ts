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
