import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// F19. The plans sell Free "10 AI requests/month" and Basic/Plus "Unlimited",
// and AI_MONTHLY_ALLOWANCE encodes exactly that — but only the routes that
// called assertAIAccess ever refused past it. Every other AI route recorded
// its request (withAiRequest writes an ai_requests row) and then ran the model
// anyway, so a Free family could call the chef, the meal planner, the journal
// and twenty more without end, each a paid model request.
//
// Every route under app/api/ai that calls a model now checks the allowance
// BEFORE the model runs. The routes below call none, and say why.
const NO_MODEL: Record<string, string> = {
  'app/api/ai/schedule/route.ts': 'finds free calendar slots with an algorithm; no model',
  'app/api/ai/runs/[id]/route.ts': 'reads a run',
  'app/api/ai/runs/[id]/cancel/route.ts': 'cancels a run',
  'app/api/ai/runs/[id]/pause/route.ts': 'pauses a run',
};

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? routes(path) : name === 'route.ts' ? [path] : [];
  });
}

const all = routes('app/api/ai');

describe('every AI route that calls a model counts against the monthly allowance (F19)', () => {
  it('finds the AI routes (guards the guard)', () => {
    expect(all.length).toBeGreaterThanOrEqual(39);
    for (const path of Object.keys(NO_MODEL)) expect(all).toContain(path);
  });

  it.each(all.filter((path) => !NO_MODEL[path]))('%s meters before it spends', (path) => {
    const src = readFileSync(path, 'utf8');
    const meter = Math.min(...['refuseOverAIAllowance(', 'withinAIAllowance(', 'assertFamilyAIAllowance(', 'assertAIAccess(']
      .map((call) => src.indexOf(call)).filter((i) => i >= 0));
    expect(Number.isFinite(meter), 'no allowance check').toBe(true);
    // A model call, not the choice of provider: resolveProvider() spends nothing.
    const body = src.slice(src.indexOf('export async function'));
    const offset = src.indexOf('export async function');
    const spends = [/withAiRequest\(/, /provider\.(complete|run\w*|stream\w*|chat|generate\w*|embed\w*|transcribe|speak)\(/, /\bopenai\.\w+/, /\banthropic\.\w+/]
      .map((re) => body.search(re)).filter((i) => i >= 0).map((i) => i + offset);
    const firstSpend = Math.min(...spends);
    if (Number.isFinite(firstSpend)) expect(meter, 'the allowance is checked after the model is called').toBeLessThan(firstSpend);
  });
});

describe('the allowance itself', () => {
  it('is what the plans sell', async () => {
    const { AI_MONTHLY_ALLOWANCE } = await import('@/lib/server/ai-access');
    expect(AI_MONTHLY_ALLOWANCE).toEqual({ 0: 10, 1: null, 2: null });
  });
});
