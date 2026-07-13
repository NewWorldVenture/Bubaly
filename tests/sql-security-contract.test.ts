import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/0188_harden_trigger_function_security.sql', 'utf8');

describe('SECURITY DEFINER trigger hardening', () => {
  it('pins the search path for every repaired trigger function', () => {
    expect(migration).toMatch(/function public\.sync_album_photo_count\(\)[\s\S]*?security definer[\s\S]*?set search_path = public/i);
    expect(migration).toMatch(/function public\.update_conversation_last_message\(\)[\s\S]*?security definer[\s\S]*?set search_path = public/i);
  });

  it('removes direct execution privileges from client roles', () => {
    expect(migration).toMatch(/revoke execute on function public\.sync_album_photo_count\(\) from public, anon, authenticated/i);
    expect(migration).toMatch(/revoke execute on function public\.update_conversation_last_message\(\) from public, anon, authenticated/i);
  });

  it('is additive and does not replace or drop the trigger tables', () => {
    expect(migration).not.toMatch(/drop\s+(?:table|trigger)/i);
    expect(migration).toContain('begin;');
    expect(migration).toContain('commit;');
  });
});
