import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const seedPath = resolve(process.cwd(), 'supabase/seed_marketplace_circles.sql');
const masterSeedPath = resolve(process.cwd(), 'supabase/SEED_ALL.sql');
const seed = readFileSync(seedPath, 'utf8');
const masterSeed = readFileSync(masterSeedPath, 'utf8');

function integerAssignment(name: string): number {
  const match = seed.match(new RegExp(`\\b${name}\\s+int\\s*:=\\s*(\\d+)\\s*;`, 'i'));
  if (!match) throw new Error(`Missing integer seed declaration: ${name}`);
  return Number(match[1]);
}

describe('Community Circles 500-record seed contract', () => {
  it('declares exactly 500 relational records', () => {
    const circles = 6;
    const memberships = circles + 24;
    const listings = integerAssignment('n_listings');
    const shares = integerAssignment('n_shares');

    expect(circles + memberships + listings + shares).toBe(500);
  });

  it('is isolated, guarded, and rerunnable', () => {
    expect(seed).toMatch(/to_regclass\('public\.marketplace_circles'\)/i);
    expect(seed).toMatch(/where lower\(u\.email\) = lower\(v_email\)/i);
    expect(seed).toMatch(/description like '%\[seed:circles\]%'/i);
    expect(seed).toMatch(/on conflict \(circle_id, family_id\) do nothing/i);
    expect(seed).not.toMatch(/truncate\s+table|drop\s+table/i);
  });

  it('is bundled in the one-paste master seed', () => {
    expect(masterSeed).toContain('seed_marketplace_circles.sql');
    expect(masterSeed).toContain('[seed:circles]');
  });
});
