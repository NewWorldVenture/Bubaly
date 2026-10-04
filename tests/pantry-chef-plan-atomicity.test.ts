import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const route = readFileSync('app/api/ai/pantry-chef/route.ts', 'utf8');
const migration = readFileSync('supabase/migrations/0476_meal_plan_delegated_actor_rpcs.sql', 'utf8');
const runtimeFixture = readFileSync('tests/fixtures/0476-meal-plan-delegated-actors.sql', 'utf8');

describe('Pantry Chef planned meal persistence', () => {
  it('uses the shared actor RPC for one meal-and-slot transaction and checks its receipt', () => {
    expect(route).toContain("service.rpc('meal_plan_replace_slots_for_actor'");
    expect(route).toContain("p_request_id: `pantry-chef:${randomUUID()}`");
    expect(route).toMatch(/meal_name: title,[\s\S]*?notes: typeof plan\.steps === 'string'/);
    expect(route).toContain("(planned[0] as { plan_date?: unknown }).plan_date !== planDate");
    expect(route).not.toMatch(/from\('meals'\)\.insert/);
    expect(route).not.toMatch(/from\('meal_plans'\)\.insert/);
  });

  it('persists recipe notes inside the shared lookup/create transaction and rolls back on plan failure', () => {
    expect(migration).toMatch(/meal_ensure_custom_for_actor\([\s\S]*?p_notes text[\s\S]*?p_has_notes boolean/i);
    expect(migration).toMatch(/and \(not p_has_notes or coalesce\(m\.notes, ''\) = coalesce\(v_notes, ''\)\)/i);
    expect(migration).toMatch(/insert into public\.meals\([^)]*notes, created_by\)[\s\S]*?v_notes, p_actor_id/i);
    expect(runtimeFixture).toContain('Pantry Chef synthetic dish');
    expect(runtimeFixture).toContain('Simmer, stir, serve.');
    expect(runtimeFixture).toContain('zz_test_pantry_plan_failure');
    expect(runtimeFixture).toContain('Pantry Chef rolled back dish');
    expect(runtimeFixture).toContain('failed Pantry Chef plan left an orphan meal');
  });
});
