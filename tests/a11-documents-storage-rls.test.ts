import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-11 (files / documents / storage) tenant-isolation guard. Documents live in two
// layers that must BOTH be family-scoped: the `documents` DB table (metadata) and
// the private `documents` Storage bucket (the bytes). The client uploads to
// `{family_id}/{folder}/{file}` (see lib/storage/documents.ts buildFamilyPath), and
// the storage policy checks the first path segment via foldername()[1]. This guard
// pins both layers so a future edit can't silently drop cross-family isolation.

function migration(file: string): string {
  return readFileSync(`supabase/migrations/${file}`, 'utf8');
}

// Later migrations drop and re-create most of these policies, so each case also
// reads the migration that defines the policy today, and pins which migrations
// create one at all: a new one has to be pinned here before this passes again.
function statement(sql: string, opening: string): string {
  const from = sql.indexOf(opening);
  return from < 0 ? '' : sql.slice(from, sql.indexOf(';', from));
}

function migrationsMatching(pattern: RegExp): string[] {
  return readdirSync('supabase/migrations')
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .filter((file) => migration(file).split('\n').some((line) => !line.trimStart().startsWith('--') && pattern.test(line)));
}

describe('A-11 documents DB table is RLS family-scoped', () => {
  const sql = migration('01090_documents_favorite.sql');
  it('enables RLS and scopes every op to is_family_member(family_id)', () => {
    expect(sql).toContain('alter table public.documents enable row level security');
    expect(sql).toContain('create policy documents_select on public.documents');
    expect(sql).toContain('for select using (public.is_family_member(family_id))');
    expect(sql).toContain('for insert with check (public.is_family_member(family_id))');
    expect(sql).toContain('for delete using (public.is_family_member(family_id))');
  });

  it('keeps every op family-scoped in 0266, which re-creates the four policies', () => {
    expect(migrationsMatching(/policy\s+"?documents_\w+"?\s+on\s+public\.documents\b/i)).toEqual([
      '01090_documents_favorite.sql',
      '0266_document_vault_boundary.sql',
    ]);
    const live = migration('0266_document_vault_boundary.sql');
    expect(live).toContain('alter table public.documents enable row level security');
    const clause = 'public.is_family_member(family_id)\n'
      + '    and (not public.is_sensitive_document(is_secure, category) or public.can_manage_family(family_id))';
    for (const [op, clauses] of [['select', 1], ['insert', 1], ['update', 2], ['delete', 1]] as const) {
      const policy = statement(live, `create policy documents_${op} on public.documents\n  for ${op}`);
      expect(policy.split(clause).length - 1, op).toBe(clauses);
      expect(policy.split('public.is_family_member(').length - 1, op).toBe(clauses);
      expect(policy, op).not.toMatch(/\btrue\b/);
    }
  });
});

describe('A-11 documents Storage bucket enforces family-folder isolation', () => {
  const sql = migration('0007_home_asset_warranties.sql');
  it('scopes read/upload/update/delete to the family that owns the path folder', () => {
    for (const op of [
      'Family members can read their documents',
      'Family members can upload their documents',
      'Family members can update their documents',
      'Family members can delete their documents',
    ]) {
      expect(sql).toContain(`CREATE POLICY "${op}" ON storage.objects`);
    }
    // The isolation predicate: the object's bucket is `documents` AND the caller
    // is a member of the family named by the first path segment.
    expect(sql).toContain("bucket_id = 'documents'");
    expect(sql).toContain('is_family_member(((storage.foldername(name))[1])::uuid)');
  });

  it('keeps the family-folder predicate in the policies in force: 0303 for read/update/delete, 0007 for upload', () => {
    expect(migrationsMatching(/policy\s+"Family members can \w+ their documents"\s+on\s+storage\.objects/i)).toEqual([
      '0007_home_asset_warranties.sql',
      '0266_document_vault_boundary.sql',
      '0303_document_bytes_boundary.sql',
    ]);
    const live = migration('0303_document_bytes_boundary.sql');
    const predicate = "bucket_id = 'documents'\n"
      + '    and public.is_family_member(((storage.foldername(name))[1])::uuid)\n'
      + '    and not public.document_object_is_restricted(name)';
    for (const [op, command, clauses] of [['read', 'select', 1], ['update', 'update', 2], ['delete', 'delete', 1]] as const) {
      const policy = statement(live, `create policy "Family members can ${op} their documents" on storage.objects\n  for ${command} to authenticated`);
      expect(policy.split(predicate).length - 1, op).toBe(clauses);
      expect(policy.split('bucket_id').length - 1, op).toBe(clauses);
    }
    // No later migration re-creates the upload policy, so 0007's is the one in force.
    expect(live).not.toContain('Family members can upload their documents');
    expect(migration('0266_document_vault_boundary.sql')).not.toContain('Family members can upload their documents');
    const upload = statement(sql, 'CREATE POLICY "Family members can upload their documents" ON storage.objects');
    expect(upload).toContain('FOR INSERT TO authenticated');
    expect(upload).toContain("bucket_id = 'documents'\n    AND is_family_member(((storage.foldername(name))[1])::uuid)");
  });
});
