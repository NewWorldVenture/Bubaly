import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-11 (messages) tenant-isolation guard. Family conversations + messages must be
// family-scoped, and the mark-read RPC must NOT be able to bypass that scoping.
// The live cross-family proof is the A-03 PG16 probe; this static guard pins the
// A-11 messages contracts so they can't silently regress.

function migration(file: string): string {
  return readFileSync(`supabase/migrations/${file}`, 'utf8');
}
function allMigrations(): string {
  return readdirSync('supabase/migrations')
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(`supabase/migrations/${f}`, 'utf8'))
    .join('\n');
}

describe('A-11 messages tables are RLS family-scoped', () => {
  const core = migration('0014_core_platform.sql');
  it('family_conversations: RLS enabled + scoped to caller family', () => {
    expect(core).toContain('alter table public.family_conversations enable row level security');
    expect(core).toMatch(/family_conversations[\s\S]*?family_id in \(select family_id from public\.family_members where user_id = auth\.uid\(\)\)/);
  });
  it('family_messages: RLS enabled + scoped to caller family', () => {
    expect(core).toContain('alter table public.family_messages enable row level security');
    expect(core).toMatch(/family_messages[\s\S]*?family_id in \(select family_id from public\.family_members where user_id = auth\.uid\(\)\)/);
  });
});

describe('A-11 mark_conversation_read RPC cannot bypass RLS', () => {
  const sql = allMigrations();
  it('is SECURITY INVOKER (runs under the caller family RLS), never DEFINER', () => {
    // Isolate the function body from its create to its terminating $$;
    const fn = sql.slice(sql.indexOf('create or replace function public.mark_conversation_read'));
    const body = fn.slice(0, fn.indexOf('$$;') + 3);
    expect(body).toContain('security invoker');
    expect(body).not.toContain('security definer');
    // Pinned search_path + only stamps the caller's own uid.
    expect(body).toContain('set search_path = public');
    expect(body).toContain('array_append(read_by, auth.uid())');
  });
});
