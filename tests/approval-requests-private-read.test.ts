import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifyApprovalPrivateRead } from '../scripts/verify-approval-private-read.mjs';

const migration = readFileSync('supabase/migrations/0477_approval_requests_private_read.sql', 'utf8');
const statements = migration.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');

describe('approval draft read boundary', () => {
  it('adds only its own restrictive SELECT guard without changing grants or decisions', () => {
    expect(statements).toMatch(/as restrictive for select to authenticated/);
    expect(statements).not.toMatch(/\b(grant|revoke|insert|update|delete|truncate|alter table|security definer)\b/i);
    expect([...statements.matchAll(/drop policy if exists (\w+)/g)].map((match) => match[1]))
      .toEqual(['approval_requests_private_read_guard']);
    expect(statements).toContain('m.user_id = auth.uid()');
    expect(statements).toContain('m.family_id = approval_requests.family_id');
    expect(statements).toContain('m.is_active');
    expect(statements).not.toMatch(/requested_by_member_id\s*=\s*auth.uid\(\)/);
  });
});

// Hosted CI runs the standalone runner explicitly against its verified PG17
// service. Local Vitest has no default database and cannot discover credentials.
const postgresBin = process.env.APPROVAL_PRIVACY_PG_BIN;
const port = process.env.APPROVAL_PRIVACY_PG_PORT;
const expectedDataDir = process.env.APPROVAL_PRIVACY_PG_DATA_DIR;
describe.skipIf(!postgresBin || !port || !expectedDataDir)('approval draft PostgreSQL contract', () => {
  it('checks actual SQL actors, replayed migration and a failing old-policy control', () => {
    const result = verifyApprovalPrivateRead({ postgresBin, port, expectedDataDir });
    expect(result.corrected).toBe('PASS, migration replayed twice, ROLLBACK');
    expect(result.oldPolicy).toBe('expected private-draft assertion failure');
  }, 30_000);
});
