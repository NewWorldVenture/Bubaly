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

// Making family-media private is 0459's decision, and the owner has deferred it
// in production (SEC-001, kept public on 2026-09-30). A later migration that
// also flips the flag would apply that decision behind 0459's back, so only
// 0459 may write `public` for this bucket.
describe('only 0459 changes whether family-media is public', () => {
  it('no other migration updates the bucket\'s public flag', async () => {
    const { readdirSync } = await import('node:fs');
    const writers = readdirSync('supabase/migrations')
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => {
        const text = readFileSync(`supabase/migrations/${f}`, 'utf8');
        return [...text.matchAll(/update\s+storage\.buckets\s+set\s+([^;]*?)where\s+id\s*=\s*'family-media'/gis)]
          .some((m) => /\bpublic\s*=/.test(m[1]));
      });
    expect(writers).toEqual(['0459_family_media_is_read_by_the_family.sql']);
  });

  it('0475 still adds the voice-note types, only to an existing allow-list', () => {
    const m0475 = readFileSync('supabase/migrations/0475_messaging_conversation_privacy_and_delivery.sql', 'utf8');
    expect(m0475).toContain("'audio/webm'");
    expect(m0475).toContain("where id = 'family-media' and allowed_mime_types is not null");
  });
});
