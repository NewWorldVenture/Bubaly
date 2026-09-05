// GET /api/ai/runs/[id] — the run detail read (§17).
//
// Read through the caller's own client: a run that belongs to another family
// is "not found", never "forbidden" — a 403 would confirm the id exists.
import { NextRequest, NextResponse } from 'next/server';
import { loadRunDetail } from '@/lib/ai/runs/detail';
import { authenticateAI } from '@/lib/server/ai-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const authed = await authenticateAI(req);
    if (authed instanceof NextResponse) return authed;
    const { supabase, ctx } = authed;
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Run not found.', code: 'not_found' }, { status: 404 });

    const detail = await loadRunDetail(supabase, ctx.active.familyId, id, { viewerRole: ctx.active.role });
    if (!detail.ok) return NextResponse.json({ error: detail.error, code: detail.code ?? 'db' }, { status: detail.retryable ? 503 : 500 });
    if (!detail.data) return NextResponse.json({ error: 'Run not found.', code: 'not_found' }, { status: 404 });
    return NextResponse.json(detail.data);
  } catch (error) {
    console.error('[api/ai/runs] run detail failed', error);
    return NextResponse.json({ error: 'Bubaly could not open that run.', code: 'unknown' }, { status: 500 });
  }
}
