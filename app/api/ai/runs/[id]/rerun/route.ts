// POST /api/ai/runs/[id]/rerun  { stepId } — run one step again (§29).
// Managers only (controls.ts): a re-run causes new writes with the run's
// authority, so the family must still have the concierge (feature, plan,
// allowance) — the same gate as intake.
import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { applyRunControl, statusForServiceCode } from '@/lib/ai/runs/intake';
import { accessDeniedResponse, assertAIAccess, authenticateAI } from '@/lib/server/ai-access';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { scopeFromUserContext } from '@/lib/services/scope';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const t = await getTranslations();
  const startedAt = Date.now();
  try {
    const authed = await authenticateAI(req);
    if (authed instanceof NextResponse) return authed;
    const { id } = await params;
    if (!id) return NextResponse.json({ error: t('rerun.runNotFound'), code: 'not_found' }, { status: 404 });

    const body = await readBoundedRequestJson(req, MAX_SMALL_JSON_BYTES);
    if (!body.ok) {
      if (body.reason === 'too_large') return NextResponse.json({ error: t('rerun.requestBodyIsTooLarge'), code: 'too_large' }, { status: 413 });
      return NextResponse.json({ error: t('rerun.invalidRequestBody'), code: 'invalid_body' }, { status: 400 });
    }
    const record = body.value && typeof body.value === 'object' ? (body.value as Record<string, unknown>) : {};
    const stepId = typeof record.stepId === 'string' ? record.stepId.trim() : '';
    if (!stepId) return NextResponse.json({ error: t('rerun.stepidIsRequired'), code: 'step_required' }, { status: 400 });

    const access = await assertAIAccess(authed.ctx, { db: authed.supabase });
    if (!access.ok) return accessDeniedResponse(access);

    const scope = scopeFromUserContext(authed.ctx, authed.supabase);
    const result = await applyRunControl(scope, id, 'rerun', { stepId }, { startedAtMs: startedAt });
    if (!result.ok) return NextResponse.json({ error: result.error, code: result.code ?? 'control_failed' }, { status: statusForServiceCode(result.code, result.retryable) });
    return NextResponse.json(result.data);
  } catch (error) {
    console.error('[api/ai/runs/rerun] control failed', error);
    return NextResponse.json({ error: t('rerun.bubalyCouldNotReRun'), code: 'unknown' }, { status: 500 });
  }
}
