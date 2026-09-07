// GET /api/ai/runs/[id] — the run detail read (§17).
//
// Read through the caller's own client: a run that belongs to another family
// is "not found", never "forbidden" — a 403 would confirm the id exists.
//
// Answers the same `RunView` the page renders (`toRunView`), never the raw
// rows: a JSON reader must not get the step inputs, event payloads, lease and
// result columns, or the request's clarification log that the page strips.
import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { loadRunDetail, toRunView } from '@/lib/ai/runs/detail';
import { isManager } from '@/lib/constants/roles';
import { authenticateAI } from '@/lib/server/ai-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const t = await getTranslations();
  try {
    const authed = await authenticateAI(req);
    if (authed instanceof NextResponse) return authed;
    const { supabase, ctx } = authed;
    const { id } = await params;
    if (!id) return NextResponse.json({ error: t('runs.runNotFound'), code: 'not_found' }, { status: 404 });

    const detail = await loadRunDetail(supabase, ctx.active.familyId, id, { viewerRole: ctx.active.role });
    if (!detail.ok) return NextResponse.json({ error: detail.error, code: detail.code ?? 'db' }, { status: detail.retryable ? 503 : 500 });
    if (!detail.data) return NextResponse.json({ error: t('runs.runNotFound'), code: 'not_found' }, { status: 404 });
    return NextResponse.json(toRunView(detail.data, ctx.active.familyId, isManager(ctx.active.role)));
  } catch (error) {
    console.error('[api/ai/runs] run detail failed', error);
    return NextResponse.json({ error: t('runs.bubalyCouldNotOpenThat'), code: 'unknown' }, { status: 500 });
  }
}
