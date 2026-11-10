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
const FAMILY_PREDICATE = 'family_id in (select family_id from public.family_members where user_id = auth.uid())';
// One `create policy` statement, from its own name to its own terminating `;`,
// so a predicate belonging to another table's policy cannot satisfy the check.
function statement(sql: string, start: number): string {
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf(';', start) + 1);
}
// The definition that is live today: the last `create policy <name>` in
// migration order (0014's blanket policies are dropped by 0367/0368 and 0475).
function livePolicy(name: string, table: string): string {
  const ordered = readdirSync('supabase/migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(`supabase/migrations/${f}`, 'utf8'))
    .join('\n');
  return statement(ordered, ordered.lastIndexOf(`create policy ${name} on public.${table} for `));
}
const COMMANDS = ['select', 'insert', 'update', 'delete'] as const;

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
  it('each 0014 policy carries the family predicate in its own statement, not a neighbouring table\'s', () => {
    for (const [name, table] of [
      ['family members can manage conversations', 'family_conversations'],
      ['family members can manage messages', 'family_messages'],
    ]) {
      const policy = statement(core, core.indexOf(`create policy "${name}"`));
      expect(policy).toContain(`on public.${table} for all`);
      expect(policy).toContain(FAMILY_PREDICATE);
    }
  });
});

describe('A-11 the live per-command policies are still family-scoped', () => {
  it('family_conversations: every command is tied to the caller, never open', () => {
    const scope: Record<(typeof COMMANDS)[number], string[]> = {
      select: ['m.family_id = family_conversations.family_id', 'm.user_id = auth.uid()', 'm.is_active'],
      insert: ['public.is_family_member(family_id)', 'created_by = auth.uid()'],
      update: ['messaging_private.can_access_conversation(id)'],
      delete: ['messaging_private.can_access_conversation(id)'],
    };
    for (const op of COMMANDS) {
      const policy = livePolicy(`family_conversations_${op}`, 'family_conversations');
      expect(policy).toContain(`for ${op} to authenticated`);
      for (const predicate of scope[op]) expect(policy).toContain(predicate);
      expect(policy).not.toMatch(/(using|with check)\s*\(\s*true\s*\)/);
    }
  });
  it('family_messages: every command requires family membership and a conversation of the same family', () => {
    for (const op of COMMANDS) {
      const policy = livePolicy(`family_messages_${op}`, 'family_messages');
      expect(policy).toContain(`for ${op} to authenticated`);
      expect(policy).toContain('public.is_family_member(family_id)');
      expect(policy).toContain('c.id = family_messages.conversation_id and c.family_id = family_messages.family_id');
      expect(policy).not.toMatch(/(using|with check)\s*\(\s*true\s*\)/);
    }
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
