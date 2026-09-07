// POST /api/ai/runs/[id]/resume — one of the human levers over a run (§17).
// Authority lives in lib/ai/runs/controls.ts; this route only maps the result.
// Unlike pause and cancel, a resume kicks execution, so the family must still
// have the concierge (feature, plan, allowance) — the same gate as intake.
import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { applyRunControl, statusForServiceCode } from '@/lib/ai/runs/intake';
import { accessDeniedResponse, assertAIAccess, authenticateAI } from '@/lib/server/ai-access';
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
    if (!id) return NextResponse.json({ error: t('resume.runNotFound'), code: 'not_found' }, { status: 404 });

    const access = await assertAIAccess(authed.ctx, { db: authed.supabase });
    if (!access.ok) return accessDeniedResponse(access);

    const scope = scopeFromUserContext(authed.ctx, authed.supabase);
    const result = await applyRunControl(scope, id, 'resume', {}, { startedAtMs: startedAt });
    if (!result.ok) return NextResponse.json({ error: result.error, code: result.code ?? 'control_failed' }, { status: statusForServiceCode(result.code, result.retryable) });
    return NextResponse.json(result.data);
  } catch (error) {
    console.error('[api/ai/runs/resume] control failed', error);
    return NextResponse.json({ error: t('resume.bubalyCouldNotUpdateThat'), code: 'unknown' }, { status: 500 });
  }
}
