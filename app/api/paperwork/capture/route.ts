import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { scopeFromUserContext } from '@/lib/services/scope';
import { captureDocument } from '@/lib/services/paperwork/capture';
import { MAX_DOCUMENT_BYTES } from '@/lib/ai/document-text';
import { readBoundedRequestFormData, readBoundedRequestJson, MAX_SMALL_JSON_BYTES } from '@/lib/server/bounded-request-body';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { aal2Verdict } from '@/lib/auth/require-aal2';

export const runtime = 'nodejs';
export const maxDuration = 60;
const unavailable = { ok: false, reason: 'unavailable', retryable: true } as const;

export async function POST(req: NextRequest) {
  let ctx: Awaited<ReturnType<typeof requireUserContext>>;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json(unavailable, { status: 401 }); }
  try {
    const assurance = await aal2Verdict(ctx, 'documents', '/dashboard/paperwork');
    if (assurance.action === 'step_up') return NextResponse.json({ ok: false, reason: 'step_up', retryable: false, stepUp: assurance.to }, { status: 403 });
    const db = await createServer();
    let input: { captureId: string; file?: File; sender?: string };
    if (req.headers.get('content-type')?.startsWith('multipart/form-data')) {
      const form = await readBoundedRequestFormData(req, MAX_DOCUMENT_BYTES + 16 * 1024);
      if (!form.ok) return NextResponse.json({ ok: false, reason: form.reason === 'too_large' ? 'too_large' : 'invalid_file', retryable: false }, { status: 400 });
      const file = form.value.get('file');
      if (!(file instanceof File) || form.value.getAll('file').length !== 1) return NextResponse.json({ ok: false, reason: 'invalid_file', retryable: false }, { status: 400 });
      if (form.value.get('expectedFamilyId') !== ctx.active.familyId || form.value.get('expectedUserId') !== ctx.user.id) {
        return NextResponse.json({ ok: false, reason: 'context_changed', retryable: false }, { status: 409 });
      }
      const limited = await enforceAIRateLimit(db, `paperwork-capture:${ctx.user.id}`, { limit: 15 });
      if (!limited.ok) return NextResponse.json(unavailable, { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } });
      input = { captureId: String(form.value.get('captureId') ?? ''), file, sender: String(form.value.get('sender') ?? '') };
    } else {
      const body = await readBoundedRequestJson(req, MAX_SMALL_JSON_BYTES);
      if (!body.ok || !body.value || typeof body.value !== 'object' || typeof (body.value as { captureId?: unknown }).captureId !== 'string') {
        return NextResponse.json({ ok: false, reason: 'invalid_file', retryable: false }, { status: 400 });
      }
      const expected = body.value as { expectedFamilyId?: unknown; expectedUserId?: unknown };
      if (expected.expectedFamilyId !== ctx.active.familyId || expected.expectedUserId !== ctx.user.id) {
        return NextResponse.json({ ok: false, reason: 'context_changed', retryable: false }, { status: 409 });
      }
      input = { captureId: (body.value as { captureId: string }).captureId };
    }
    const result = await captureDocument(scopeFromUserContext(ctx, db), input);
    const status = result.ok ? 200 : result.reason === 'needs_file' ? 404 : result.retryable ? 503 : 400;
    return NextResponse.json(result, { status });
  } catch {
    console.error('[paperwork-capture] request failed');
    return NextResponse.json(unavailable, { status: 503 });
  }
}
