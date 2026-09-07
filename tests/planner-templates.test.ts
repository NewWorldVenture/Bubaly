// Every workflow template is a promise that its skeleton can actually run:
// each tool it names exists in the registry, each input it writes passes that
// tool's schema, the graph has no cycle and no dangling dependency, and the
// roster agent it names is real. The date arithmetic is checked separately
// because "the week" and "the weekend" are where off-by-one bugs live.
import { describe, expect, it } from 'vitest';
import { AGENTS_BY_ID } from '@/lib/agents/roster';
import { findDependencyCycle } from '@/lib/ai/runs/states';
import { parseNotifyInput } from '@/lib/ai/runs/executor';
import { parseVerificationSpec } from '@/lib/ai/runs/verify';
import { conformNulls } from '@/lib/ai/schema-to-json';
import { getTool } from '@/lib/ai/tools/registry';
import { parseStepInput } from '@/lib/ai/planner/schema';
import {
  allTemplates, instantiateTemplate, localTime, mondayOf, monthBounds, shiftDay, templateContextFrom, templateFor, weekdayOf,
  type TemplateContext,
} from '@/lib/ai/planner/templates/index';
import { INTENT_KEYS } from '@/lib/ai/context/intents';

function ctxOn(todayKey: string, extra: Partial<Parameters<typeof templateContextFrom>[0]> = {}): TemplateContext {
  return templateContextFrom({
    tz: 'America/New_York', nowIso: `${todayKey}T16:00:00Z`, todayKey, requestText: 'Our kitchen sink is leaking, find a plumber',
    viewerMemberId: 'mem-parent', managerIds: ['mem-parent'],
    trips: [{ id: 'trip-1', title: 'Disney', startDate: '2026-10-10', daysUntil: 35 }],
    ...extra,
  });
}

describe('workflow templates are runnable skeletons', () => {
  const ctx = ctxOn('2026-09-05');

  it('covers the signature workflows, the proactive asks, the move, the chief-of-staff sweep and the outcome workflows', () => {
    // One list, sorted, holding every template that now exists: the move and the
    // chief-of-staff sweep this branch registered, and M25/M34's outcome days.
    // Both sides asserted an exhaustive list, so keeping either alone would have
    // failed the moment the other's templates registered.
    expect(allTemplates().map((t) => t.intent).sort()).toEqual([
      'back_to_school', 'chief_of_staff', 'daily_brief', 'emergency_prep', 'find_vendor', 'holiday',
      'life_event', 'organize_weekend', 'plan_meals', 'plan_move', 'plan_week', 'prepare_vacation',
      'remind_everyone', 'school_morning', 'spending_review', 'tournament_day', 'what_am_i_forgetting',
    ]);
    // The move is reachable from its own intent and carries the dynamic half
    // the other templates do not have — see planner-plan-move.test.ts.
    expect(templateFor('plan_move')).toMatchObject({ intent: 'plan_move', agent: 'household_manager' });
    expect(typeof templateFor('plan_move')?.dynamicSteps).toBe('function');
    for (const intent of INTENT_KEYS) {
      const template = templateFor(intent);
      if (template) expect(template.intent).toBe(intent);
    }
    expect(templateFor('answer_question')).toBeNull();
    // `other` plans from scratch on purpose: it is for text nothing recognised.
    expect(templateFor('other')).toBeNull();
  });

  it('names a real roster agent for every workflow', () => {
    for (const template of allTemplates()) {
      expect(AGENTS_BY_ID[template.agent], template.intent).toBeDefined();
    }
  });

  it('names only registry tools and writes inputs those tools accept', () => {
    for (const template of allTemplates()) {
      const plan = instantiateTemplate(template, ctx);
      for (const step of plan.steps) {
        const label = `${template.intent}/${step.key}`;
        const input = parseStepInput(step.input);
        expect(input.ok, label).toBe(true);
        if (!input.ok) continue;
        if (step.step_type === 'act' || step.step_type === 'retrieve') {
          const tool = getTool(step.tool_name ?? '');
          expect(tool, `${label} names ${step.tool_name}`).not.toBeNull();
          if (!tool) continue;
          expect(tool.readOnly, `${label} type matches the tool`).toBe(step.step_type === 'retrieve');
          const parsed = tool.input.safeParse(conformNulls(tool.input, input.value));
          expect(parsed.success, `${label}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
        } else if (step.step_type === 'notify') {
          expect(parseNotifyInput(input.value).ok, label).toBe(true);
        } else if (step.step_type === 'verify') {
          expect(parseVerificationSpec(input.value).ok, label).toBe(true);
        }
        if (step.verify) {
          const spec = parseStepInput(step.verify);
          expect(spec.ok && parseVerificationSpec(spec.value).ok, `${label} verify slot`).toBe(true);
        }
      }
    }
  });

  it('has unique keys, no dangling dependency and no cycle', () => {
    for (const template of allTemplates()) {
      const plan = instantiateTemplate(template, ctx);
      const keys = plan.steps.map((s) => s.key);
      expect(new Set(keys).size, template.intent).toBe(keys.length);
      for (const step of plan.steps) {
        for (const dep of step.depends_on) expect(keys, `${template.intent}/${step.key} → ${dep}`).toContain(dep);
      }
      expect(findDependencyCycle(plan.steps.map((s) => ({ id: s.key, status: 'queued' as const, dependency_ids: s.depends_on }))), template.intent).toBeNull();
    }
  });

  it('runs its reads in parallel: no retrieve step depends on another step', () => {
    for (const template of allTemplates()) {
      const plan = instantiateTemplate(template, ctx);
      const reads = plan.steps.filter((s) => s.step_type === 'retrieve' && s.key !== 'check_readiness');
      for (const read of reads) expect(read.depends_on, `${template.intent}/${read.key}`).toEqual([]);
    }
  });

  it('ends every workflow with a notification that waits for the work before it', () => {
    for (const template of allTemplates()) {
      const plan = instantiateTemplate(template, ctx);
      const tells = plan.steps.filter((s) => s.step_type === 'notify' || (s.step_type === 'act' && s.tool_name === 'notifications.notify'));
      expect(tells.length, template.intent).toBeGreaterThan(0);
      for (const tell of tells) expect(tell.depends_on.length, `${template.intent}/${tell.key}`).toBeGreaterThan(0);
    }
  });

  it('marks deterministic only the templates the model has nothing to fill in', () => {
    for (const template of allTemplates()) {
      const needsModel = template.steps.some((s) => s.modelFills);
      if (template.deterministic) {
        expect(template.steps.filter((s) => s.modelFills && !s.optional), `${template.intent} has a required model-filled step`).toEqual([]);
      } else {
        expect(needsModel, template.intent).toBe(true);
      }
    }
    expect(templateFor('spending_review')?.deterministic).toBe(true);
    expect(templateFor('find_vendor')?.deterministic).toBe(true);
    expect(templateFor('plan_meals')?.deterministic).toBe(false);
  });

  it('writes the trip id from the context into every vacation step', () => {
    const plan = instantiateTemplate(templateFor('prepare_vacation')!, ctx);
    const tripSteps = plan.steps.filter((s) => s.tool_name?.startsWith('trips.') && s.key !== 'put_trip_on_file');
    expect(tripSteps.length).toBeGreaterThan(3);
    for (const step of tripSteps) {
      const input = parseStepInput(step.input);
      expect(input.ok && input.value.vacation_id, step.key).toBe('trip-1');
    }
    expect(plan.followups[0]?.after).toBe('2026-10-08T09:00:00');
    expect(instantiateTemplate(templateFor('prepare_vacation')!, ctxOn('2026-09-05', { trips: [] })).followups).toEqual([]);
  });

  it('addresses "what am I forgetting" to the person who asked, or the parents', () => {
    const asker = instantiateTemplate(templateFor('what_am_i_forgetting')!, ctx).steps.find((s) => s.key === 'tell_asker')!;
    expect(parseStepInput(asker.input)).toMatchObject({ ok: true, value: { recipients: ['mem-parent'] } });
    const system = instantiateTemplate(templateFor('what_am_i_forgetting')!, ctxOn('2026-09-05', { viewerMemberId: null })).steps.find((s) => s.key === 'tell_asker')!;
    expect(parseStepInput(system.input)).toMatchObject({ ok: true, value: { recipients: 'managers' } });
  });

  // M25/M34: the five outcome workflows and the life-event workflow.
  it('plans the tournament on the day the request named, or the coming Saturday', () => {
    const named = instantiateTemplate(templateFor('tournament_day')!, ctxOn('2026-09-08', { entities: { day: '2026-09-19' } }));
    const block = parseStepInput(named.steps.find((s) => s.key === 'block_day')!.input);
    expect(block.ok && String(block.value.starts_at)).toContain('2026-09-19');
    const unnamed = instantiateTemplate(templateFor('tournament_day')!, ctxOn('2026-09-08'));
    const fallback = parseStepInput(unnamed.steps.find((s) => s.key === 'block_day')!.input);
    // 2026-09-08 is a Tuesday; the coming Saturday is the 12th.
    expect(fallback.ok && String(fallback.value.starts_at)).toContain('2026-09-12');
  });

  it('plans the school morning for a weekday and packs the night before', () => {
    // Friday the 11th → the next school day is Monday the 14th, not Saturday.
    const plan = instantiateTemplate(templateFor('school_morning')!, ctxOn('2026-09-11'));
    const reminder = parseStepInput(plan.steps.find((s) => s.key === 'morning_reminder')!.input);
    expect(reminder.ok && String(reminder.value.remind_at)).toContain('2026-09-14');
    const pack = parseStepInput(plan.steps.find((s) => s.key === 'pack_bag')!.input);
    expect(pack.ok && pack.value.due_date).toBe('2026-09-13');
  });

  it('works back from the first day of school and follows up a week before it', () => {
    const plan = instantiateTemplate(templateFor('back_to_school')!, ctxOn('2026-09-05', { entities: { date: '2026-10-05' } }));
    const forms = parseStepInput(plan.steps.find((s) => s.key === 'forms_task')!.input);
    expect(forms.ok && forms.value.due_date).toBe('2026-09-14');
    expect(plan.followups[0]?.after).toBe('2026-09-28T09:00:00');
  });

  it('gives the holiday and the life event a verify that names what the run wrote', () => {
    for (const intent of ['holiday', 'emergency_prep', 'life_event'] as const) {
      const plan = instantiateTemplate(templateFor(intent)!, ctx);
      const verify = plan.steps.find((s) => s.step_type === 'verify')!;
      const spec = parseStepInput(verify.input);
      expect(spec.ok, intent).toBe(true);
      if (!spec.ok) continue;
      const checks = spec.value.checks as { kind: string; ids?: unknown[] }[];
      expect(checks.length, intent).toBeGreaterThan(0);
      for (const check of checks) {
        expect(check.kind, intent).toBe('records_exist');
        expect(JSON.stringify(check.ids), intent).toContain('$fromStep');
      }
    }
  });

  it('never asks the life-event template to invent the transition', () => {
    const plan = instantiateTemplate(templateFor('life_event')!, ctxOn('2026-09-05', { entities: { topic: 'our new puppy', day: '2026-09-26' } }));
    expect(plan.objective).toContain('our new puppy');
    const block = parseStepInput(plan.steps.find((s) => s.key === 'block_day')!.input);
    expect(block.ok && block.value.title).toBe('');
    expect(templateFor('life_event')!.guidance.join(' ')).toMatch(/never state the transition as a fact/i);
  });

  it('puts the vendor issue, not a fabricated provider, into the repair steps', () => {
    const plan = instantiateTemplate(templateFor('find_vendor')!, ctx);
    const record = parseStepInput(plan.steps.find((s) => s.key === 'maintenance_record')!.input);
    expect(record.ok && String(record.value.title)).toContain('sink is leaking');
    expect(plan.steps.some((s) => s.tool_name === 'home.saveContractor')).toBe(false);
  });
});

describe('template dates resolve in the family\'s calendar', () => {
  it('knows weekdays and Mondays', () => {
    expect(weekdayOf('2026-09-05')).toBe(6);   // Saturday
    expect(weekdayOf('2026-09-06')).toBe(0);   // Sunday
    expect(mondayOf('2026-09-05')).toBe('2026-08-31');
    expect(mondayOf('2026-09-07')).toBe('2026-09-07');
    expect(shiftDay('2026-08-31', 1)).toBe('2026-09-01');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(localTime('2026-09-14', 9, 5)).toBe('2026-09-14T09:05:00');
    expect(monthBounds('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });

  it('plans the coming week from Friday onward and the current week before that', () => {
    expect(ctxOn('2026-09-04')).toMatchObject({ weekStartKey: '2026-09-07', weekEndKey: '2026-09-13' });  // Friday
    expect(ctxOn('2026-09-05')).toMatchObject({ weekStartKey: '2026-09-07', weekEndKey: '2026-09-13' });  // Saturday
    expect(ctxOn('2026-09-06')).toMatchObject({ weekStartKey: '2026-09-07', weekEndKey: '2026-09-13' });  // Sunday
    expect(ctxOn('2026-09-08')).toMatchObject({ weekStartKey: '2026-09-07', weekEndKey: '2026-09-13' });  // Tuesday
  });

  it('always means the next Saturday–Sunday by "the weekend", including today when it is Saturday', () => {
    expect(ctxOn('2026-09-02')).toMatchObject({ weekendStartKey: '2026-09-05', weekendEndKey: '2026-09-06' });  // Wednesday
    expect(ctxOn('2026-09-05')).toMatchObject({ weekendStartKey: '2026-09-05', weekendEndKey: '2026-09-06' });  // Saturday
    expect(ctxOn('2026-09-06')).toMatchObject({ weekendStartKey: '2026-09-12', weekendEndKey: '2026-09-13' });  // Sunday → next weekend
  });

  it('resolves the month under review and the one before it', () => {
    expect(ctxOn('2026-09-05')).toMatchObject({
      monthKey: '2026-09', previousMonthKey: '2026-08', monthStartKey: '2026-09-01', monthEndKey: '2026-09-30',
      previousMonthStartKey: '2026-08-01', previousMonthEndKey: '2026-08-31', tomorrowKey: '2026-09-06', dayAfterTomorrowKey: '2026-09-07',
    });
    expect(ctxOn('2026-01-03')).toMatchObject({ previousMonthKey: '2025-12', previousMonthEndKey: '2025-12-31' });
  });
});
