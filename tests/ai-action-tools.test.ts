import { describe, expect, it, vi } from 'vitest';

const runAction = vi.fn();
vi.mock('@/lib/ai/actions', () => ({
  AI_TOOLS: [
    { name: 'create_calendar_event', description: 'Add an event', input_schema: { type: 'object' } },
    { name: 'create_meal_plan_entry', description: 'Plan a meal', input_schema: { type: 'object' } },
  ],
  runAction: (...args: unknown[]) => runAction(...args),
}));

import { buildActionTools, mergeToolSets } from '@/lib/ai/action-tools';

const ctx = { supabase: {} as never, familyId: 'fam-1', userId: 'user-1' };

describe('buildActionTools', () => {
  it('exposes every lib/ai/actions.ts tool and executes it through runAction', async () => {
    runAction.mockResolvedValueOnce({ ok: true, summary: 'Planned "Tacos" for 2026-09-06.' });
    const tools = buildActionTools(ctx);
    expect(tools.map((t) => t.name)).toEqual(['create_calendar_event', 'create_meal_plan_entry']);
    const meal = tools.find((t) => t.name === 'create_meal_plan_entry')!;
    const result = await meal.execute({ meal_name: 'Tacos', plan_date: '2026-09-06' });
    expect(runAction).toHaveBeenCalledWith(ctx, { name: 'create_meal_plan_entry', args: { meal_name: 'Tacos', plan_date: '2026-09-06' } });
    expect(result).toEqual({ ok: true, summary: 'Planned "Tacos" for 2026-09-06.' });
  });

  it('skips excluded names', () => {
    const tools = buildActionTools(ctx, { exclude: ['create_calendar_event'] });
    expect(tools.map((t) => t.name)).toEqual(['create_meal_plan_entry']);
  });
});

describe('mergeToolSets', () => {
  it('dedupes by name with earlier sets winning', () => {
    const a = { name: 'create_calendar_event', description: 'rich', input_schema: { type: 'object' }, execute: async () => 'a' };
    const b = { name: 'create_calendar_event', description: 'simple', input_schema: { type: 'object' }, execute: async () => 'b' };
    const c = { name: 'create_meal_plan_entry', description: 'meal', input_schema: { type: 'object' }, execute: async () => 'c' };
    const merged = mergeToolSets([a], [b, c]);
    expect(merged.map((t) => t.name)).toEqual(['create_calendar_event', 'create_meal_plan_entry']);
    expect(merged[0].description).toBe('rich');
  });
});
