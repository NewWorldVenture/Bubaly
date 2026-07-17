import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-11 (LB-009 / PLA-0461): the `family-media` Storage bucket — used by Photos,
// Create-Memory, Message attachments and Reminder attachments — must be defined
// in a migration (not the dashboard) with family-folder write RLS, so fresh
// environments and the PG16 harness work and cross-family writes are blocked.
// Guard the migration so the bucket + its isolation can't silently regress.
const sql = readFileSync('supabase/migrations/0216_family_media_bucket.sql', 'utf8');

describe('A-11 family-media storage bucket is defined + write-isolated', () => {
  it('creates the bucket idempotently with the 25 MB limit', () => {
    expect(sql).toContain("insert into storage.buckets (id, name, public, file_size_limit)");
    expect(sql).toContain("values ('family-media', 'family-media', true, 26214400)");
    expect(sql).toContain('on conflict (id) do nothing');
  });

  it('scopes read/upload/update/delete to the family that owns the path folder', () => {
    for (const op of [
      'Family members can read their media',
      'Family members can upload their media',
      'Family members can update their media',
      'Family members can delete their media',
    ]) {
      expect(sql).toContain(`create policy "${op}" on storage.objects`);
    }
    // The isolation predicate mirrors the private `documents` bucket (0007).
    expect(sql).toContain("bucket_id = 'family-media'");
    expect(sql).toContain('public.is_family_member(((storage.foldername(name))[1])::uuid)');
  });
});
