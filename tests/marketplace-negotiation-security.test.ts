import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const migration = readFileSync('supabase/migrations/0187_harden_marketplace_negotiations.sql', 'utf8');
const standaloneSeed = readFileSync('supabase/seed_marketplace_negotiations.sql', 'utf8');
const masterSeed = readFileSync('supabase/SEED_ALL.sql', 'utf8');

describe('marketplace negotiation integrity', () => {
  it('enforces family separation, bounded values, and below-ask rounds in SQL', () => {
    expect(migration).toContain('marketplace_negotiations_distinct_families');
    expect(migration).toContain('check (family_id <> buyer_family_id)');
    expect(migration).toContain('marketplace_negotiations_amount_bound');
    expect(migration).toContain('marketplace_negotiation_rounds_message_bound');
    expect(migration).toContain('length(message) <= 500');
    expect(migration).toContain('validate_marketplace_negotiation_round');
    expect(migration).toContain('new.amount_cents >= v_ask');
  });

  it('fails closed when the anchored seed account is absent', () => {
    const start = masterSeed.indexOf('seed_marketplace_negotiations.sql');
    const end = masterSeed.indexOf('seed_marketplace_handoffs.sql', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const negotiationSection = masterSeed.slice(start, end);
    for (const seed of [standaloneSeed, negotiationSection]) {
      expect(seed).toContain('Marketplace negotiation seed requires the anchored account');
      expect(seed).not.toContain('select id into v_family from public.families order by created_at');
    }
  });
});
