import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KEYED_TABLES } from '@/lib/services/idempotency';

// 0256 is what makes "this write must not happen twice" true rather than
// likely: a probe is a read before a write, and two retries can both read
// "no". These guards pin the shape of that promise — partial indexes only, so
// the rows people create by hand are never constrained, and nothing in the
// file rewrites existing data.
const raw = readFileSync('supabase/migrations/0256_idempotency_keys.sql', 'utf8');
/** Statements only: the file's comments carry example SQL that must not count as the real thing. */
const sql = raw.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');

describe('0256 idempotency keys', () => {
  it('gives every table the AI writes to a key and a family-scoped partial unique index', () => {
    for (const table of KEYED_TABLES) {
      expect(sql, table).toContain(`alter table public.${table}`);
      expect(sql, table).toMatch(new RegExp(`create unique index if not exists uq_${table}_idempotency\\s+on public\\.${table} \\(family_id, idempotency_key\\) where idempotency_key is not null`));
    }
    expect(sql.match(/add column if not exists idempotency_key text/g)).toHaveLength(KEYED_TABLES.length);
  });

  it('keys transactions by the charge, not by the call', () => {
    // A receipt scanned twice is the same charge even though it is a second
    // request — so the fingerprint, not the run step, is what must be unique.
    expect(sql).toContain('add column if not exists fingerprint text');
    expect(sql).toContain("add column if not exists source text not null default 'manual'");
    expect(sql).toContain('add column if not exists receipt_document_id uuid');
    expect(sql).toMatch(/create unique index if not exists uq_transactions_fingerprint\s+on public\.transactions \(family_id, fingerprint\) where fingerprint is not null/);
    expect(sql).toContain("check (source in ('manual', 'receipt', 'import', 'ai'))");
  });

  it('is additive and idempotent: no rewrites, no policy or grant changes', () => {
    expect(sql).not.toMatch(/\b(update public\.|delete from|truncate|drop table|drop column)\b/i);
    expect(sql).not.toMatch(/\b(create policy|drop policy|grant|revoke)\b/i);
    // Every index is partial, so existing hand-made rows stay unconstrained.
    const indexes = sql.match(/create unique index if not exists/g) ?? [];
    expect(indexes).toHaveLength(KEYED_TABLES.length + 1);
    expect(sql.match(/where \w+ is not null/g) ?? []).toHaveLength(indexes.length);
    expect(sql.match(/if not exists/g)?.length).toBeGreaterThanOrEqual(indexes.length);
  });
});
