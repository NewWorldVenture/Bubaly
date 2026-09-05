// POST /api/ai/runs/[id]/rerun  { stepId } — run one step again (§29).
// Managers only (controls.ts): a re-run causes new writes with the run's authority.
import { NextRequest, NextResponse } from 'next/server';
import { applyRunControl, statusForServiceCode } from '@/lib/ai/runs/intake';
import { authenticateAI } from '@/lib/server/ai-access';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { scopeFromUserContext } from '@/lib/services/scope';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  try {
    const authed = await authenticateAI(req);
    if (authed instanceof NextResponse) return authed;
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Run not found.', code: 'not_found' }, { status: 404 });

    const body = await readBoundedRequestJson(req, MAX_SMALL_JSON_BYTES);
    if (!body.ok) {
      if (body.reason === 'too_large') return NextResponse.json({ error: 'Request body is too large.', code: 'too_large' }, { status: 413 });
      return NextResponse.json({ error: 'Invalid request body', code: 'invalid_body' }, { status: 400 });
    }
    const record = body.value && typeof body.value === 'object' ? (body.value as Record<string, unknown>) : {};
    const stepId = typeof record.stepId === 'string' ? record.stepId.trim() : '';
    if (!stepId) return NextResponse.json({ error: 'stepId is required', code: 'step_required' }, { status: 400 });

    const scope = scopeFromUserContext(authed.ctx, authed.supabase);
    const result = await applyRunControl(scope, id, 'rerun', { stepId }, { startedAtMs: startedAt });
    if (!result.ok) return NextResponse.json({ error: result.error, code: result.code ?? 'control_failed' }, { status: statusForServiceCode(result.code, result.retryable) });
    return NextResponse.json(result.data);
  } catch (error) {
    console.error('[api/ai/runs/rerun] control failed', error);
    return NextResponse.json({ error: 'Bubaly could not re-run that step.', code: 'unknown' }, { status: 500 });
  }
}
