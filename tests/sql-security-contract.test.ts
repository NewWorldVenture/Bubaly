import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/0188_harden_trigger_function_security.sql', 'utf8');

const REPAIRED = ['sync_album_photo_count', 'update_conversation_last_message'];

// One function's own header: from its `create or replace function` to the `as $$`
// that opens its body — so a clause is never borrowed from the next definition.
function headerOf(sql: string, name: string): string | null {
  const start = sql.toLowerCase().indexOf(`create or replace function public.${name}()`);
  if (start === -1) return null;
  const end = sql.indexOf('as $$', start);
  return end === -1 ? null : sql.slice(start, end);
}

describe('SECURITY DEFINER trigger hardening', () => {
  it('pins the search path for every repaired trigger function', () => {
    expect(migration).toMatch(/function public\.sync_album_photo_count\(\)[\s\S]*?security definer[\s\S]*?set search_path = public/i);
    expect(migration).toMatch(/function public\.update_conversation_last_message\(\)[\s\S]*?security definer[\s\S]*?set search_path = public/i);
    for (const name of REPAIRED) {
      const header = headerOf(migration, name);
      expect(header, `${name} is defined in 0188`).not.toBeNull();
      expect(header, `${name} header`).toMatch(/\nsecurity definer\nset search_path = public\n$/i);
    }
  });

  it('keeps the pin in the live definition — the last migration to re-create each function', () => {
    const dir = 'supabase/migrations';
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const name of REPAIRED) {
      const defining = files.filter((f) => headerOf(readFileSync(`${dir}/${f}`, 'utf8'), name) !== null);
      // 0014 created it unpinned, 0188 repaired it; whatever defines it last is what the database runs.
      expect(defining.slice(0, 2), name).toEqual(['0014_core_platform.sql', '0188_harden_trigger_function_security.sql']);
      const live = defining[defining.length - 1];
      const header = headerOf(readFileSync(`${dir}/${live}`, 'utf8'), name);
      expect(header, `${name} in ${live}`).toMatch(/\bsecurity definer\b/i);
      expect(header, `${name} in ${live}`).toMatch(/\bset search_path = public\b/i);
    }
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
