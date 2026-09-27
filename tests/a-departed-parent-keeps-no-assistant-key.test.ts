// SRV-001 l12 — a parent who leaves the family takes no assistant key with them.
//
// An assistant key is a standing bearer grant: POST /api/assistant (and the
// Alexa route) resolve it with resolveAssistantLink and then read the family's
// day aloud and, with `capture`, file into it. Only a parent can mint one, and
// the key carries that parent's user_id. Removing a member is an UPDATE of
// family_members.is_active and demoting one an UPDATE of role; neither touched
// the key, and the resolver matched on token_hash + revoked_at alone. So a
// co-parent removed from the household kept a working key.
//
// This pins the application half, which holds in production whether or not
// 0419 (the database half, which retires the key) has been applied: the key
// resolves only while its owner is an ACTIVE PARENT of the key's family, and a
// read of that membership that fails is a refusal, not a pass. The database
// half is held by docs/audit/a-departed-parent-keeps-no-assistant-key-check.sql;
// the migration's shape is pinned at the bottom.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { hashAssistantToken } from '@/lib/assistant/link-token';
import { resolveAssistantLink } from '@/lib/assistant/service';

const FAMILY = '11111111-1111-4111-8111-111111111111';
const OTHER_FAMILY = '22222222-2222-4222-8222-222222222222';
const PARENT = 'user-parent';
const TOKEN = 'bub_asst_the-kitchen-speaker-secret';

let db: InMemorySupabase;

function seed(member: { role: string; is_active: boolean } | null, familyId = FAMILY) {
  db.seed('families', [{ id: FAMILY, name: 'Home', timezone: 'Europe/London' }]);
  db.seed('assistant_links', [{
    id: 'link-1', family_id: FAMILY, user_id: PARENT, provider: 'alexa', label: 'Kitchen',
    token_hash: hashAssistantToken(TOKEN), token_prefix: 'bub_asst_the', scopes: ['ask', 'capture'],
    revoked_at: null, created_by: PARENT,
  }]);
  if (member) {
    db.seed('family_members', [{ id: 'member-1', family_id: familyId, user_id: PARENT, display_name: 'Parent', ...member }]);
  }
}

// The route hands resolveAssistantLink the service client; the in-memory one
// stands in for it (no row-level security either way).
const resolve = () => resolveAssistantLink(db as never, TOKEN);

beforeEach(() => {
  db = createInMemorySupabase();
  vi.restoreAllMocks();
});

describe('an assistant key resolves only while its owner is an active parent of its family', () => {
  it('resolves for an active parent — the key still works for the family that has it', async () => {
    seed({ role: 'parent', is_active: true });
    const link = await resolve();
    expect(link).not.toBeNull();
    expect(link).toMatchObject({ family_id: FAMILY, user_id: PARENT, scopes: ['ask', 'capture'] });
  });

  it('does not resolve once that parent has been removed from the family', async () => {
    seed({ role: 'parent', is_active: false });
    expect(await resolve()).toBeNull();
  });

  it('does not resolve once that parent has been demoted — an adult cannot mint a key, so cannot hold one', async () => {
    seed({ role: 'adult', is_active: true });
    expect(await resolve()).toBeNull();
  });

  it('does not resolve when the owner has no membership in the key\'s family at all', async () => {
    seed(null);
    expect(await resolve()).toBeNull();
  });

  it('does not borrow the owner\'s standing in a DIFFERENT family', async () => {
    seed({ role: 'parent', is_active: true }, OTHER_FAMILY);
    expect(await resolve()).toBeNull();
  });

  it('refuses when the membership read fails — never "assume they are still a parent"', async () => {
    seed({ role: 'parent', is_active: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      if (table !== 'family_members') return from(table);
      const q = from(table);
      return Object.assign(q, {
        maybeSingle: async () => ({ data: null, error: { message: 'connection reset', code: '08006' } }),
      });
    }) as typeof db.from);
    expect(await resolve()).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith('[assistant] link owner lookup failed', expect.objectContaining({ code: '08006' }));
  });

  it('still refuses a revoked key, whoever owns it', async () => {
    seed({ role: 'parent', is_active: true });
    (db.table('assistant_links')[0] as { revoked_at: string | null }).revoked_at = '2026-09-01T00:00:00Z';
    expect(await resolve()).toBeNull();
  });
});

describe('0419 — the database retires the key as well', () => {
  // Read in each test rather than at load, so a missing file fails these three
  // and not the whole suite.
  const sql = () => readFileSync('supabase/migrations/0419_a_departed_parent_keeps_no_assistant_key.sql', 'utf8');

  it('fires on the member changes that end a parent\'s standing, and on delete', () => {
    expect(sql()).toMatch(/after update of is_active, role, user_id, family_id or delete on public\.family_members/);
  });

  it('retires only live keys of that (family, user) pair, and only when no active parent row is left', () => {
    expect(sql()).toMatch(/update public\.assistant_links\s+set revoked_at = now\(\)\s+where family_id = old\.family_id\s+and user_id = old\.user_id\s+and revoked_at is null/);
    expect(sql()).toMatch(/if not exists \(\s+select 1 from public\.family_members m\s+where m\.family_id = old\.family_id\s+and m\.user_id = old\.user_id\s+and m\.is_active\s+and m\.role = 'parent'/);
  });

  it('runs as its definer with a pinned search_path, and is not callable by the API roles', () => {
    expect(sql()).toMatch(/security definer\s+set search_path = public/);
    expect(sql()).toContain('revoke all on function public.retire_assistant_keys_of_a_departed_parent() from anon, authenticated;');
  });
});
