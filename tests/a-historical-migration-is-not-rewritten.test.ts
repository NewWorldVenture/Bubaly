import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';

/**
 * A migration that production has already recorded is history, not code.
 *
 * #834's build-out rewrote 0293 (notifications.related_id uuid -> text) so a
 * replay would skip its ALTER TYPE once 0476's chat-notice policies depended on
 * the column. Production cannot see that rewrite: `supabase db push` never
 * re-runs a recorded version, so the edit changed only what a fresh replay does
 * and left the file disagreeing with what was applied. The owner's decision:
 * 0293 stays byte-for-byte as on main, and 0476 does its own checking.
 *
 * Two halves, both needed:
 *   - 0293's bytes are pinned, so the rewrite cannot come back unnoticed;
 *   - 0476 checks related_id itself (uuid converted, text kept, anything else
 *     refused), and its notice policies do not name related_id, so main's 0293
 *     still replays over a schema that carries 0476. The database half of this
 *     is scripts/verify-notification-key-migration.mjs and the CI replay.
 */
const MIGRATIONS = 'supabase/migrations';
const read = (name: string) => readFileSync(`${MIGRATIONS}/${name}`, 'utf8');

// sha256 of main's 0293_notifications_related_id_is_a_key.sql.
const MAIN_0293_SHA256 = '4f75bbc1d1b7990a223299d40e31cfaf56ace11802410ba447e183446cce57d0';

describe('a historical migration is not rewritten', () => {
  it('0293 is byte-for-byte the file main shipped', () => {
    const bytes = readFileSync(`${MIGRATIONS}/0293_notifications_related_id_is_a_key.sql`);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(MAIN_0293_SHA256);
  });

  it('0476 checks notifications.related_id before it builds on it', () => {
    const sql = read('0476_messaging_notifications_preferences.sql');
    const check = at(sql, "where table_schema = 'public' and table_name = 'notifications' and column_name = 'related_id'");
    const convert = at(sql, 'alter column related_id type text using related_id::text');
    const refuse = at(sql, "raise exception '0476 FAILED: notifications.related_id has unexpected type %, expected uuid or text'");
    expect(sql).toMatch(/if related_id_type = 'uuid' then\s+alter table public\.notifications/);
    expect(sql).toMatch(/elsif related_id_type is distinct from 'text' then\s+raise exception '0476 FAILED/);
    // Every use of the column comes after the check: the key index and each
    // chat-notice policy.
    const firstUse = Math.min(
      at(sql, 'create unique index if not exists notification_message_recipient'),
      at(sql, 'create policy message_notice_current_access on public.notifications'),
    );
    expect(convert).toBeGreaterThan(check);
    expect(refuse).toBeGreaterThan(convert);
    expect(firstUse).toBeGreaterThan(refuse);
  });

  it("0476's notice policies do not name related_id, so 0293 can replay over them", () => {
    const sql = read('0476_messaging_notifications_preferences.sql');
    const policies = sql.match(/create policy [^;]+ on public\.notifications[^;]*;/g) ?? [];
    expect(policies.map((p) => p.split(' ')[2])).toEqual([
      'message_notice_current_access',
      'message_notice_current_update',
      'message_notice_server_authorship',
    ]);
    for (const policy of policies) expect(policy).not.toMatch(/related_id/);
  });
});
