// The run page (§17) is the only reader behind the run detail UI, and what it
// hands the browser is a view model: step descriptions, event messages, the
// plan's user-facing reasoning_summary. This pins the boundary as a source
// contract — the raw columns that carry model reasoning, step inputs/results
// and event payloads must never reach a component — and unit-tests the pure
// timeline derivation the client renders from.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { glyphFor, timelineRows, type RunEventView, type RunStepView } from '@/components/concierge/run-timeline';
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
    expect(page).toContain("import { loadRunDetail, type RunDetailView } from '@/lib/ai/runs/detail';");
    expect(page).toContain('loadRunDetail(supabase, familyId, id, { viewerRole: ctx.active.role })');
    expect(page).toContain('if (!detail.data) notFound();');
    expect(page).toContain('if (!detail.ok) return <RunUnavailable message={detail.error} />;');
    // Never the service client: a cross-family id must be "not found", not data.
    expect(page).not.toContain('createServiceClient');
  });

  it('renders the plan reasoning_summary only, never the model reasoning chain', () => {
    expect(page).toContain('reasoningSummary: plan?.reasoning_summary?.trim() || null');
    // Any other `reasoning` reference would be the model's chain (approval_requests.reasoning, ai_request_context…).
    const reasoningRefs = page.match(/\breasoning\b(?!_summary)/g) ?? [];
    expect(reasoningRefs.filter((m) => !m.includes('_summary'))).toHaveLength(0);
    expect(page).not.toMatch(/chain[_-]of[_-]thought/i);
    expect(page).not.toContain('ai_request_context');
    expect(page).not.toContain('snapshot');
    expect(page).not.toContain('evidence');
  });

  it('never forwards step results or event payloads to the browser', () => {
    expect(page).not.toContain('result_json');
    // The only payload read is the metrics-only helper for model_call events.
    expect(countOutsideFunction(page, 'modelCallMetrics', 'payload')).toBe(1); // the single call site: modelCallMetrics(e.payload)
    expect(page).toContain("metrics: e.event_type === 'model_call' ? modelCallMetrics(e.payload) : null");
    expect(page).toContain('latency_ms');
    expect(page).toContain('total_tokens');
    // Step inputs reach the browser only as the scalar editable fields, and only for managers.
    expect(page).toContain('if (manager && EDITABLE_STEP_STATES.includes(');
    expect(page).toContain('editableFieldsFor(input)');
    for (const source of [timeline, controls, clarification]) {
      expect(source).not.toContain('input_json');
      expect(source).not.toContain('result_json');
      expect(source).not.toContain('payload');
      expect(source).not.toContain('reasoning_summary');
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
