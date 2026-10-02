import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// F19, the owner's decision of 2026-10-02 (#771 reviews 5391362628 and
// 5391604223): the Free plan's monthly allowance applies consistently across
// USER-REQUESTED AI. `tests/every-ai-route-counts-against-the-allowance.test.ts`
// walks app/api/ai/; these are the user-requested entry points outside it.
// Each must check the allowance BEFORE every model call it makes.
//
// Deliberately absent: chore-plan generation (`generatePlanAction`) already
// runs `assertAIAccess` with the stronger 'family-missions' entitlement, and
// chore-proof validation (`submitProofAction`) is a side effect of a child's
// submission, kept separately classified per the owner rather than charged.

const CHECK = /refuseOverAIAllowance\(|assertAIAllowance\(/g;
const MODEL_CALL = /withAiRequest\(|await generate\(/g;

const ENTRY_POINTS = [
  'app/api/recipes/suggest/route.ts',
  'app/api/recipes/transform/route.ts',
  'app/api/vacations/ai/route.ts',
  'app/api/behavior/insight/route.ts',
  'app/api/social/ai/route.ts',
  'app/(app)/marketplace/assistant-actions.ts',
  'app/(app)/dashboard/paperwork/actions.ts',
  'app/(app)/dashboard/contacts/[id]/actions.ts',
];

const positions = (src: string, re: RegExp) => [...src.matchAll(re)].map((m) => m.index ?? 0);

describe('user-requested AI outside app/api/ai checks the monthly allowance first', () => {
  it.each(ENTRY_POINTS)('%s', (file) => {
    const src = readFileSync(file, 'utf8');
    const checks = positions(src, CHECK);
    const calls = positions(src, MODEL_CALL);
    expect(calls.length, 'the file still reaches a model').toBeGreaterThan(0);
    expect(checks.length, 'the allowance is checked').toBeGreaterThan(0);
    // Every model call has a check somewhere before it in the same file.
    for (const call of calls) expect(checks.some((c) => c < call), `a model call at ${call} with no check before it`).toBe(true);
  });

  it('the vacation builder and concierge are each checked once, and recommendations not at all', () => {
    const src = readFileSync('app/api/vacations/ai/route.ts', 'utf8');
    const reco = src.slice(src.indexOf("if (action === 'recommendations')"), src.indexOf("if (action === 'build')"));
    const build = src.slice(src.indexOf("if (action === 'build')"), src.indexOf("if (action === 'concierge')"));
    const concierge = src.slice(src.indexOf("if (action === 'concierge')"));
    expect(positions(reco, CHECK)).toHaveLength(0);
    expect(positions(build, CHECK)).toHaveLength(1);
    expect(positions(concierge, CHECK)).toHaveLength(1);
    // The concierge checks before it saves the member's message, so a refusal
    // leaves no orphan message behind.
    expect(concierge.search(CHECK)).toBeLessThan(concierge.indexOf("from('vacation_ai_conversations')"));
  });

  it('chore-plan generation keeps its stronger existing gate', () => {
    const src = readFileSync('app/(app)/missions/actions.ts', 'utf8');
    const plan = src.slice(src.indexOf('export async function generatePlanAction'));
    expect(plan).toMatch(/assertAIAccess\(ctx, \{ db: supabase, featureKey: 'family-missions' \}\)/);
    expect(plan.indexOf('assertAIAccess(')).toBeLessThan(plan.indexOf('generateChorePlan('));
  });
});
