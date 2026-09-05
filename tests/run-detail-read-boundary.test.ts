// The run detail leaves the server through three readers — the page, GET
// /api/ai/runs/[id], and the page's refresh action — and every one of them
// hands out the same view model built by `toRunView` in lib/ai/runs/detail.ts:
// step descriptions, event messages, the plan's user-facing reasoning_summary.
// This pins the boundary as a source contract — the raw columns that carry
// model reasoning, step inputs/results, event payloads, the run's lease and
// result, and the request's clarification log must never reach a component
// or a JSON client — exercises `toRunView` against rows carrying all of them,
// and unit-tests the pure timeline derivation the client renders from.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { glyphFor, timelineRows, type RunEventView, type RunStepView } from '@/components/concierge/run-timeline';
import { toRunView, type RunDetailView } from '@/lib/ai/runs/detail';
import { RUN_STATES } from '@/lib/ai/runs/states';
import { statusLabel, statusTone } from '@/components/concierge/status-badge';

/** Source with comments removed, so the contract is about code, not about the prose that explains it. */
function code(path: string): string {
  return fs.readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const page = code('app/(app)/dashboard/concierge/runs/[id]/page.tsx');
const detail = code('lib/ai/runs/detail.ts');
const route = code('app/api/ai/runs/[id]/route.ts');
const actions = code('app/(app)/dashboard/concierge/run-actions.ts');
const timeline = code('components/concierge/run-timeline.tsx');
const controls = code('components/concierge/run-controls.tsx');
const clarification = code('components/concierge/clarification-card.tsx');

/** Occurrences of `needle` in `source` outside the body of the named function. */
function countOutsideFunction(source: string, fnName: string, needle: string): number {
  const start = source.indexOf(`function ${fnName}(`);
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  expect(end).toBeGreaterThan(start);
  const outside = source.slice(0, start) + source.slice(end + 1);
  return outside.split(needle).length - 1;
}

describe('run detail read boundary', () => {
  it('loads through the family-scoped loader with the caller client and 404s on a miss', () => {
    expect(page).toContain("import { loadRunDetail, toRunView } from '@/lib/ai/runs/detail';");
    expect(page).toContain('loadRunDetail(supabase, familyId, id, { viewerRole: ctx.active.role })');
    expect(page).toContain('if (!detail.data) notFound();');
    expect(page).toContain('if (!detail.ok) return <RunUnavailable message={detail.error} />;');
    expect(page).toContain('const view = toRunView(detail.data, familyId, manager);');
    // Never the service client: a cross-family id must be "not found", not data.
    expect(page).not.toContain('createServiceClient');
  });

  it('renders the plan reasoning_summary only, never the model reasoning chain', () => {
    expect(detail).toContain('reasoningSummary: plan?.reasoning_summary?.trim() || null');
    for (const source of [page, detail, route, actions]) {
      // Any other `reasoning` reference would be the model's chain (approval_requests.reasoning, ai_request_context…).
      expect(source.match(/\breasoning\b(?!_summary)/g) ?? []).toHaveLength(0);
      expect(source).not.toMatch(/chain[_-]of[_-]thought/i);
      expect(source).not.toContain('ai_request_context');
      expect(source).not.toContain('snapshot');
      expect(source).not.toContain('evidence');
    }
  });

  it('never forwards step results or event payloads to a reader', () => {
    for (const source of [page, detail, route, actions]) expect(source).not.toContain('result_json');
    // The only payload read is the metrics-only helper for model_call events, in the one boundary module.
    expect(countOutsideFunction(detail, 'modelCallMetrics', 'payload')).toBe(1); // the single call site: modelCallMetrics(e.payload)
    expect(detail).toContain("metrics: e.event_type === 'model_call' ? modelCallMetrics(e.payload) : null");
    expect(detail).toContain('latency_ms');
    expect(detail).toContain('total_tokens');
    // Step inputs reach a reader only as the scalar editable fields, and only for managers.
    expect(detail).toContain('if (manager && EDITABLE_STEP_STATES.includes(');
    expect(detail).toContain('editableFieldsFor(input)');
    for (const source of [page, route, actions]) {
      expect(source).not.toContain('payload');
      expect(source).not.toContain('lease_owner');
      expect(source).not.toContain('prompt_tokens');
      expect(source).not.toContain('clarifications');
    }
    for (const source of [timeline, controls, clarification]) {
      expect(source).not.toContain('input_json');
      expect(source).not.toContain('result_json');
      expect(source).not.toContain('payload');
      expect(source).not.toContain('reasoning_summary');
    }
  });

  it('the JSON route and the refresh action answer the same view as the page, never the rows', () => {
    expect(route).toContain("import { loadRunDetail, toRunView } from '@/lib/ai/runs/detail';");
    expect(route).toContain('NextResponse.json(toRunView(detail.data, ctx.active.familyId, isManager(ctx.active.role)))');
    expect(route).not.toContain('NextResponse.json(detail.data)');
    expect(actions).toContain("import { loadRunDetail, toRunView, type RunView } from '@/lib/ai/runs/detail';");
    expect(actions).toContain('Promise<RunActionResult<RunView | null>>');
    expect(actions).toContain('toRunView(detail.data, ctx.active.familyId, isManager(ctx.active.role))');
    expect(actions).not.toContain('RunDetailView');
    // The view types have one home; the client component only re-exports them.
    expect(timeline).toContain("export type { RunEventView, RunProgressView, RunStepView, RunView } from '@/lib/ai/runs/detail';");
  });

  it('toRunView strips every raw column a row carries, and offers step inputs only as a manager\'s editable fields', () => {
    const rows = {
      run: {
        id: 'run-1', family_id: 'fam-1', plan_id: 'plan-1', request_id: 'req-1', requested_by_member_id: 'member-1', state: 'executing', status: 'approved',
        summary: 'Sort the weekend', error: null, created_at: '2026-09-05T10:00:00Z', completed_at: null, lease_owner: 'worker-7', lease_expires_at: '2026-09-05T10:02:00Z',
        progress: { internal: 'counter' }, result: { raw: 'output' }, metadata: { trace: 'id' }, cancel_requested_at: null, paused_at: null,
      },
      request: { id: 'req-1', request_text: 'Organize our weekend', clarifications: [{ question: 'Which weekend?', answer: 'This one' }, { question: 'Morning?', answer: null }], model: 'gpt-x', prompt_tokens: 1234, completion_tokens: 56 },
      plan: { id: 'plan-1', objective: 'Weekend', reasoning_summary: 'Two free slots.', risk_level: 'medium' },
      steps: [
        { id: 'step-1', sequence: 0, step_type: 'act', description: 'Book the pool', status: 'queued', error: null, dependency_ids: [], input_json: { title: 'Pool', notes: 'secret-note' }, result_json: { raw: 'output' } },
        { id: 'step-2', sequence: 1, step_type: 'retrieve', description: null, status: 'completed', error: null, dependency_ids: ['step-1'], input_json: { prompt: 'model prompt text' }, result_json: { rows: [1, 2] } },
      ],
      events: [
        { id: 'ev-1', event_type: 'model_call', message: 'Thinking about the weekend', created_at: '2026-09-05T10:00:01Z', step_id: null, actor_kind: 'ai', payload: { latency_ms: 1234, total_tokens: 850, prompt: 'the whole prompt' } },
        { id: 'ev-2', event_type: 'step_completed', message: 'Booked.', created_at: '2026-09-05T10:00:02Z', step_id: 'step-1', actor_kind: 'ai', payload: { output: 'raw tool output' } },
      ],
      approvals: [],
    } as unknown as RunDetailView;

    const managerView = toRunView(rows, 'fam-1', true);
    expect(managerView).toMatchObject({
      id: 'run-1', familyId: 'fam-1', planId: 'plan-1', requestId: 'req-1', state: 'executing', objective: 'Weekend', requestText: 'Organize our weekend',
      reasoningSummary: 'Two free slots.', riskLevel: 'medium', error: null, question: null, answered: [{ question: 'Which weekend?', answer: 'This one' }],
      progress: { done: 1, total: 2, failed: 0, blocked: 0, awaitingApproval: 0 },
    });
    expect(managerView.steps.map((s) => s.description)).toEqual(['Book the pool', 'A step Bubaly planned']);
    expect(managerView.events.map((e) => e.metrics)).toEqual(['1.2s · 850 tokens', null]);
    // A manager may edit the queued act step's scalar inputs — that is the whole of what the inputs become.
    expect(managerView.steps[0].editableFields?.map((f) => f.key)).toEqual(['title', 'notes']);
    expect(managerView.steps[1].editableFields).toBeUndefined();
    const memberView = toRunView(rows, 'fam-1', false);
    expect(memberView.steps.every((s) => s.editableFields === undefined)).toBe(true);

    for (const view of [managerView, memberView]) {
      expect(Object.keys(view).sort()).toEqual([
        'answered', 'approvals', 'completedAt', 'createdAt', 'error', 'events', 'familyId', 'id', 'objective', 'planId', 'progress',
        'question', 'reasoningSummary', 'requestId', 'requestText', 'requestedBy', 'riskLevel', 'state', 'steps',
      ]);
      expect(Object.keys(view.events[0]).sort()).toEqual(['actor', 'at', 'id', 'message', 'metrics', 'stepId', 'type']);
      expect(Object.keys(view.steps[1]).sort()).toEqual(['description', 'error', 'id', 'sequence', 'status']);
    }
    const memberJson = JSON.stringify(memberView);
    for (const leak of ['worker-7', 'lease', 'counter', 'raw', 'trace', 'gpt-x', 1234, 'prompt', 'secret-note', 'Morning?', 'input_json', 'result_json', 'payload', 'clarifications']) {
      expect(memberJson, String(leak)).not.toContain(String(leak));
    }
  });

  it('subscribes the timeline to ai_run_events and ai_plan_steps through the shared realtime hook', () => {
    expect(timeline).toContain("import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';");
    expect(timeline).toContain("table: 'ai_run_events'");
    expect(timeline).toContain("table: 'ai_plan_steps'");
    // The browser only ever selects ids and statuses; the read model stays on the server.
    expect(timeline).toContain("select('id, created_at')");
    expect(timeline).toContain("select('id, status, updated_at')");
    expect(timeline).toContain('router.refresh()');
  });

  it('gates re-run and edit to managers and the rest to the requester or a manager', () => {
    expect(page).toContain('const canControl = manager || detail.data.run.requested_by_member_id === ctx.active.member.id;');
    expect(controls).toContain("const showRerun = canManage && state !== 'cancelled' && failedSteps.length > 0;");
    expect(controls).toContain("const showEdit = canManage && state !== 'cancelled' && state !== 'completed' && editableSteps.length > 0;");
    expect(page).toContain("'use server';");
    expect(page).toContain('editStepInput(scopeFromUserContext(actor, db), runId, stepId, merged)');
    expect(page).toContain('if (actor.active.familyId !== familyId)');
  });
});

describe('StatusBadge', () => {
  it('has copy and a tone for every §10 state', () => {
    for (const state of RUN_STATES) {
      expect(statusLabel(state)).not.toBe(state);
      expect(statusLabel(state).length).toBeGreaterThan(0);
      expect(['brand', 'neutral', 'success', 'warning', 'danger', 'accent']).toContain(statusTone(state));
    }
  });
});

describe('timelineRows', () => {
  const step = (id: string, status: RunStepView['status'], sequence: number, error: string | null = null): RunStepView =>
    ({ id, sequence, description: `Step ${id}`, status, error });
  const event = (id: string, stepId: string | null, type: string, message: string): RunEventView =>
    ({ id, stepId, type, message, at: '2026-09-05T10:00:00Z', actor: 'ai', metrics: null });

  it('maps ✓ done, ○ pending and ⚠ failed/blocked, in plan order', () => {
    const rows = timelineRows(
      [step('c', 'queued', 3), step('a', 'completed', 1), step('b', 'failed', 2, 'The calendar refused the write.'), step('d', 'blocked', 4)],
      [],
    );
    expect(rows.map((r) => r.step.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(rows.map((r) => r.glyph)).toEqual(['done', 'problem', 'pending', 'problem']);
    expect(rows[1].note).toBe('The calendar refused the write.');
  });

  it('uses the latest step event message as the note, ignoring model_call and step_started noise', () => {
    const rows = timelineRows(
      [step('a', 'completed', 1)],
      [
        event('e1', 'a', 'step_started', 'Started "Step a".'),
        event('e2', 'a', 'step_completed', 'Created seven preparation tasks.'),
        event('e3', 'a', 'model_call', 'plan · gpt-4.1'),
        event('e4', null, 'run_completed', 'All done.'),
      ],
    );
    expect(rows[0].note).toBe('Created seven preparation tasks.');
  });

  it('marks waiting and active states distinctly', () => {
    expect(glyphFor('awaiting_approval')).toBe('waiting');
    expect(glyphFor('executing')).toBe('active');
    expect(glyphFor('skipped')).toBe('skipped');
  });
});
