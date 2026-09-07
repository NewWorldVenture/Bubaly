// The move plan is a promise that the checklist is THIS family's: one address
// change per tracked subscription and recurring bill, a records request only
// for a child who has a school on file, a vet visit only for a pet on file —
// every one keyed so a second "plan our move" adds nothing twice — and
// reminders dated from the move day the family actually chose.
import { describe, expect, it } from 'vitest';
import { conformNulls } from '@/lib/ai/schema-to-json';
import { findDependencyCycle } from '@/lib/ai/runs/states';
import { parseNotifyInput } from '@/lib/ai/runs/executor';
import { parseVerificationSpec } from '@/lib/ai/runs/verify';
import { getTool } from '@/lib/ai/tools/registry';
import { MAX_STEPS, parseStepInput } from '@/lib/ai/planner/schema';
import { instantiateTemplate, templateContextFrom, templateFor, templateSteps, type MoveContext, type TemplateContext } from '@/lib/ai/planner/templates/index';
import { SLICE_ACCESS } from '@/lib/ai/context/policy';

const template = templateFor('plan_move')!;

function sources(over: Partial<MoveContext> = {}): MoveContext {
  return {
    move: { id: 'move-1', title: 'Move to Maple St', moveDate: '2026-10-03', hasKids: true, hasPets: true, templateKeys: [] },
    subscriptions: [{ id: 'sub-1', name: 'Netflix' }, { id: 'sub-2', name: 'Spotify' }],
    bills: [{ id: 'bill-1', name: 'Electric Co', category: 'utilities' }, { id: 'bill-2', name: 'Car insurance', category: 'insurance' }],
    schoolClasses: [{ memberId: 'mem-kid', memberName: 'Maya', schoolName: 'Oak Elementary' }],
    pets: [{ id: 'pet-1', name: 'Biscuit', vetName: 'Dr Paws' }],
    ...over,
  };
}

function ctxWith(move: MoveContext | null, extra: Partial<Parameters<typeof templateContextFrom>[0]> = {}): TemplateContext {
  return templateContextFrom({
    tz: 'America/New_York', nowIso: '2026-09-05T16:00:00Z', todayKey: '2026-09-05', requestText: 'Plan our move',
    viewerMemberId: 'mem-parent', managerIds: ['mem-parent', 'mem-parent-2'], move, ...extra,
  });
}

function inputOf(ctx: TemplateContext, key: string): Record<string, unknown> {
  const step = instantiateTemplate(template, ctx).steps.find((s) => s.key === key);
  expect(step, key).toBeDefined();
  const parsed = parseStepInput(step!.input);
  expect(parsed.ok, key).toBe(true);
  return parsed.ok ? parsed.value : {};
}

describe('plan_move', () => {
  it('is the Household Manager\'s workflow and lives in the registry of templates', () => {
    expect(template).toMatchObject({ intent: 'plan_move', agent: 'household_manager', deterministic: false });
    expect(SLICE_ACCESS.moving.managerOnly).toBe(true);
  });

  it('emits one address task per tracked subscription, keyed to the subscription', () => {
    const ctx = ctxWith(sources());
    expect(inputOf(ctx, 'address_1')).toEqual({ move_id: null, title: 'Change the address with Netflix', category: 'address', offset_days: -14, assignee_id: 'mem-parent', template_key: 'address-sub-sub-1' });
    expect(inputOf(ctx, 'address_2')).toMatchObject({ title: 'Change the address with Spotify', template_key: 'address-sub-sub-2' });
    const keys = instantiateTemplate(template, ctx).steps.map((s) => s.key);
    expect(keys.filter((k) => k.startsWith('address_'))).toEqual(['address_1', 'address_2']);
    expect(keys.filter((k) => k.startsWith('address_'))).toHaveLength(sources().subscriptions.length);
  });

  it('tells a utility bill from a billing address and dates the utility earlier', () => {
    const ctx = ctxWith(sources());
    expect(inputOf(ctx, 'bill_1')).toMatchObject({ title: 'Move Electric Co to the new address', category: 'utilities', offset_days: -21, template_key: 'address-bill-bill-1' });
    expect(inputOf(ctx, 'bill_2')).toMatchObject({ title: 'Update the billing address with Car insurance', category: 'address', offset_days: -14, template_key: 'address-bill-bill-2' });
  });

  it('adds a school records task only when the family has school classes, and a vet task only per pet on file', () => {
    const withBoth = instantiateTemplate(template, ctxWith(sources())).steps.map((s) => s.key);
    expect(withBoth).toContain('school_1');
    expect(withBoth).toContain('vet_1');
    expect(inputOf(ctxWith(sources()), 'school_1')).toMatchObject({ title: 'Request Maya’s school records from Oak Elementary', category: 'school', offset_days: -49, assignee_id: 'mem-parent', template_key: 'school-records-mem-kid' });
    expect(inputOf(ctxWith(sources()), 'vet_1')).toMatchObject({ title: 'Get Biscuit’s records and vaccine certificate from Dr Paws', category: 'pets', offset_days: -35, template_key: 'vet-records-pet-1' });

    const withoutSchool = instantiateTemplate(template, ctxWith(sources({ schoolClasses: [] }))).steps.map((s) => s.key);
    expect(withoutSchool.some((k) => k.startsWith('school_'))).toBe(false);
    expect(withoutSchool).toContain('vet_1');
    const withoutPets = instantiateTemplate(template, ctxWith(sources({ pets: [] }))).steps.map((s) => s.key);
    expect(withoutPets.some((k) => k.startsWith('vet_'))).toBe(false);
    expect(inputOf(ctxWith(sources({ schoolClasses: [{ memberId: 'mem-kid', memberName: null, schoolName: null }] })), 'school_1').title).toBe('Request the child’s school records');
    expect(inputOf(ctxWith(sources({ pets: [{ id: 'pet-1', name: 'Biscuit', vetName: null }] })), 'vet_1').title).toBe('Get Biscuit’s records and vaccine certificate from the vet');
  });

  it('assigns admin to the person asking when they manage the family, else the first manager', () => {
    expect(inputOf(ctxWith(sources()), 'address_1').assignee_id).toBe('mem-parent');
    expect(inputOf(ctxWith(sources(), { viewerMemberId: 'mem-teen' }), 'address_1').assignee_id).toBe('mem-parent');
    expect(inputOf(ctxWith(sources(), { viewerMemberId: null, managerIds: [] }), 'address_1').assignee_id).toBeNull();
  });

  it('dates the reminders from the move day on file, or 45 days out when none is', () => {
    const ctx = ctxWith(sources());
    expect(inputOf(ctx, 'mail_reminder')).toMatchObject({ remind_at: '2026-09-19T09:00:00', priority: 'high', kind: 'time' });
    expect(inputOf(ctx, 'eve_reminder')).toMatchObject({ remind_at: '2026-10-02T18:00:00' });
    expect(instantiateTemplate(template, ctx).followups).toEqual([{ after: '2026-10-01T09:00:00', prompt: expect.stringContaining('Two days before Move to Maple St') }]);

    const noMove = ctxWith(sources({ move: null }));
    expect(inputOf(noMove, 'mail_reminder')).toMatchObject({ remind_at: '2026-10-06T09:00:00' });
    expect(instantiateTemplate(template, noMove).followups).toEqual([]);
    expect(instantiateTemplate(template, noMove).objective).toMatch(/^Put the move on file/);
    // The sources still multiply out — they address "the current move", which the first step puts on file.
    expect(instantiateTemplate(template, noMove).steps.map((s) => s.key)).toContain('address_1');
  });

  it('multiplies nothing when the moving slice was not loaded, and keeps every step inside the plan limit at the caps', () => {
    const other = instantiateTemplate(template, ctxWith(null));
    expect(other.steps.map((s) => s.key)).toEqual(template.steps.map((s) => s.key));

    const many = sources({
      subscriptions: Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, name: `Service ${i}` })),
      bills: Array.from({ length: 20 }, (_, i) => ({ id: `b${i}`, name: `Bill ${i}`, category: null })),
      schoolClasses: Array.from({ length: 6 }, (_, i) => ({ memberId: `k${i}`, memberName: `Kid ${i}`, schoolName: null })),
      pets: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `Pet ${i}`, vetName: null })),
    });
    const capped = instantiateTemplate(template, ctxWith(many));
    expect(capped.steps.length).toBeLessThanOrEqual(MAX_STEPS);
    expect(new Set(capped.steps.map((s) => s.key)).size).toBe(capped.steps.length);
  });

  it('is a runnable skeleton: real tools, valid inputs, no dangling dependency, reads in parallel, a notification that waits', () => {
    const ctx = ctxWith(sources());
    const plan = instantiateTemplate(template, ctx);
    const keys = plan.steps.map((s) => s.key);
    for (const step of plan.steps) {
      const label = `plan_move/${step.key}`;
      const input = parseStepInput(step.input);
      expect(input.ok, label).toBe(true);
      if (!input.ok) continue;
      if (step.step_type === 'act' || step.step_type === 'retrieve') {
        const tool = getTool(step.tool_name ?? '');
        expect(tool, `${label} names ${step.tool_name}`).not.toBeNull();
        expect(tool!.readOnly, label).toBe(step.step_type === 'retrieve');
        const parsed = tool!.input.safeParse(conformNulls(tool!.input, input.value));
        expect(parsed.success, `${label}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
      } else if (step.step_type === 'notify') {
        expect(parseNotifyInput(input.value).ok, label).toBe(true);
        expect(step.depends_on.length, label).toBeGreaterThan(0);
      } else if (step.step_type === 'verify') {
        expect(parseVerificationSpec(input.value).ok, label).toBe(true);
      }
      if (step.step_type === 'retrieve') expect(step.depends_on, label).toEqual([]);
      for (const dep of step.depends_on) expect(keys, `${label} → ${dep}`).toContain(dep);
    }
    expect(findDependencyCycle(plan.steps.map((s) => ({ id: s.key, status: 'queued' as const, dependency_ids: s.depends_on })))).toBeNull();
    // Every dynamic step waits for the template timeline, so a re-plan never races it.
    for (const step of templateSteps(template, ctx).slice(template.steps.length)) expect(step.dependsOn).toEqual(['timeline']);
    expect(plan.steps.find((s) => s.key === 'put_move_on_file')).toMatchObject({ tool_name: 'moving.createMove' });
    expect(template.steps.find((s) => s.key === 'put_move_on_file')?.optional).toBe(true);
  });
});
