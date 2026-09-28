// DB-RPC-M02 (0463): 0367 leaves read_by, reactions and is_pinned open to
// every family member, and the trigger never said whose entry a member may
// change. Measured: a child erased Dad's read receipt and his 👍 from Mom's
// message in one update. The behaviour is proved by
// docs/audit/a-read-receipt-is-the-readers-own-check.sql in CI's Database job;
// this pins the shape, and pins that the product's own writers only ever touch
// the caller's entry — the premise the trigger rests on.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/0463_a_read_receipt_is_the_readers_own.sql', 'utf8');
const messages = readFileSync('components/modules/messages-module.tsx', 'utf8');

describe("a read receipt and a reaction are the reader's own (DB-RPC-M02)", () => {
  it('guards INSERT and any UPDATE that names read_by or reactions', () => {
    expect(migration).toMatch(
      /create trigger trg_family_message_receipts_are_the_callers\s+before insert or update of read_by, reactions on public\.family_messages\s+for each row execute function public\.family_message_receipts_are_the_callers\(\);/,
    );
  });

  it('lets only the caller enter or leave read_by, refused as 42501', () => {
    expect(migration).toMatch(/except select r from unnest\(old_read\) r\)\s+union/);
    expect(migration).toMatch(/where changed\.id is distinct from me\) then\s+raise exception 'A read receipt is only its reader''s to add or remove'\s+using errcode = '42501'/);
  });

  it('lets only the caller enter or leave any emoji list, and keeps the shape', () => {
    expect(migration).toMatch(/where changed\.who is distinct from me::text\) then\s+raise exception 'A reaction is only its author''s to add or remove'\s+using errcode = '42501'/);
    expect(migration).toMatch(/jsonb_typeof\(e\.value\) <> 'array'/);
    expect(migration).toContain("using errcode = '22023'");
  });

  it('leaves the service role and is_pinned alone', () => {
    expect(migration).toMatch(/if me is null then\s+return new; -- service role/);
    expect(migration).not.toMatch(/is_pinned\s+is distinct/);
  });

  it("the product's writers only ever change the caller's own entry", () => {
    // Read receipts: the RPC first, then an append of userId in the fallback.
    expect(messages).toContain("supabase.rpc('mark_conversation_read', { p_conversation_id: convId })");
    expect(messages).toContain('.update({ read_by: [...(m.read_by ?? []), userId] })');
    // Reactions: add or remove userId under one emoji, nothing else.
    const react = messages.slice(messages.indexOf('async function reactTo('), messages.indexOf('// ── Delete message'));
    expect(react).toContain('existing.filter((u) => u !== userId)');
    expect(react).toContain('[...existing, userId]');
    expect(react).not.toMatch(/reactions:\s*\{\s*\}/);
  });
});
