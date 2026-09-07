// POST /api/ai/runs/[id]/pause — one of the human levers over a run (§17).
// Authority lives in lib/ai/runs/controls.ts; this route only maps the result.
import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { applyRunControl, statusForServiceCode } from '@/lib/ai/runs/intake';
import { authenticateAI } from '@/lib/server/ai-access';
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
    if (!id) return NextResponse.json({ error: t('pause.runNotFound'), code: 'not_found' }, { status: 404 });

    const scope = scopeFromUserContext(authed.ctx, authed.supabase);
    const result = await applyRunControl(scope, id, 'pause', {}, { startedAtMs: startedAt });
    if (!result.ok) return NextResponse.json({ error: result.error, code: result.code ?? 'control_failed' }, { status: statusForServiceCode(result.code, result.retryable) });
    return NextResponse.json(result.data);
  } catch (error) {
    console.error('[api/ai/runs/pause] control failed', error);
    return NextResponse.json({ error: t('pause.bubalyCouldNotUpdateThat'), code: 'unknown' }, { status: 500 });
  }
}
