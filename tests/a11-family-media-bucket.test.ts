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

  it('keeps the four policies family-scoped in 0475, which re-creates them on media_access', async () => {
    // 0475 drops the four policies above and re-creates them under the same
    // names, so its statements are the ones a database has today. A migration
    // that creates one again has to be pinned here before this passes.
    const { readdirSync } = await import('node:fs');
    const read = (file: string) => readFileSync(`supabase/migrations/${file}`, 'utf8');
    const live = '0475_messaging_conversation_privacy_and_delivery.sql';
    const writing = (pattern: RegExp) => readdirSync('supabase/migrations')
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .filter((file) => read(file).split('\n').some((line) => !line.trimStart().startsWith('--') && pattern.test(line)));
    expect(writing(/create\s+policy\s+"Family members can \w+ their media"/i)).toEqual(['0216_family_media_bucket.sql', live]);
    expect(writing(/function\s+messaging_private\.media_access\s*\(/i)).toEqual([live]);

    const m0475 = read(live);
    for (const policy of [
      'create policy "Family members can read their media" on storage.objects for select to authenticated\n'
        + "  using (bucket_id = 'family-media' and messaging_private.media_access(name, false));",
      'create policy "Family members can upload their media" on storage.objects for insert to authenticated\n'
        + "  with check (bucket_id = 'family-media' and messaging_private.media_access(name, true));",
      'create policy "Family members can update their media" on storage.objects for update to authenticated\n'
        + "  using (bucket_id = 'family-media' and messaging_private.media_access(name, true))\n"
        + "  with check (bucket_id = 'family-media' and messaging_private.media_access(name, true));",
      'create policy "Family members can delete their media" on storage.objects for delete to authenticated\n'
        + "  using (bucket_id = 'family-media' and messaging_private.media_access(name, true));",
    ]) {
      expect(m0475).toContain(policy);
    }
    // The helper refuses anyone outside the family named by the first path
    // segment before it looks at anything else.
    const opening = 'create or replace function messaging_private.media_access(p_name text, p_write boolean default false)';
    expect(m0475).toContain(opening);
    const helper = m0475.slice(m0475.indexOf(opening));
    const body = helper.slice(0, helper.indexOf('$$;'));
    expect(body).toContain("declare parts text[] := string_to_array(p_name, '/'); fam uuid; conv uuid;\nbegin\n  if auth.uid() is null or parts[1] !~*");
    expect(body).toContain("then return false; end if;\n  fam := parts[1]::uuid;\n  if not public.is_family_member(fam) then return false; end if;\n  if parts[2] is distinct from 'messages' then return true; end if;");
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

  it('0475 still adds the voice-note types, only to an allow-list that has entries', () => {
    // A textual pin. The cases are EXECUTED against the real 0475 by
    // scripts/verify-messaging-database.mjs: NULL and empty lists and either
    // visibility are left as found, a real list gains the six types once, and
    // a missing bucket is not created.
    const m0475 = readFileSync('supabase/migrations/0475_messaging_conversation_privacy_and_delivery.sql', 'utf8');
    expect(m0475).toContain("'audio/webm'");
    expect(m0475).toContain("where id = 'family-media' and cardinality(allowed_mime_types) > 0");
    const verifier = readFileSync('scripts/verify-messaging-database.mjs', 'utf8');
    expect(verifier).toContain('PASS: 0475 leaves family-media visibility as found');
  });
});
