import { readFileSync } from 'node:fs';
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

describe('A-11 documents DB table is RLS family-scoped', () => {
  const sql = migration('0109_documents_favorite.sql');
  it('enables RLS and scopes every op to is_family_member(family_id)', () => {
    expect(sql).toContain('alter table public.documents enable row level security');
    expect(sql).toContain('create policy documents_select on public.documents');
    expect(sql).toContain('for select using (public.is_family_member(family_id))');
    expect(sql).toContain('for insert with check (public.is_family_member(family_id))');
    expect(sql).toContain('for delete using (public.is_family_member(family_id))');
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
});
