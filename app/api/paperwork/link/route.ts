import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { scopeFromUserContext } from '@/lib/services/scope';
import { captureDocumentLink } from '@/lib/services/paperwork/link';
import { authorizeDocumentLink } from '@/lib/services/paperwork/link-access';
import { readBoundedRequestJson, MAX_SMALL_JSON_BYTES } from '@/lib/server/bounded-request-body';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { aal2Verdict } from '@/lib/auth/require-aal2';
import type { DocumentLinkResult } from '@/lib/capture/document-link';

export const runtime = 'nodejs';
export const maxDuration = 60;
const unavailable = { ok: false, reason: 'unavailable', retryable: true } as const;
const json = (result: DocumentLinkResult, status: number) => NextResponse.json(result, { status, headers: { 'Cache-Control': 'private, no-store' } });

export async function POST(req: NextRequest) {
  let ctx: Awaited<ReturnType<typeof requireUserContext>>;
  try { ctx = await requireUserContext(); } catch { return json(unavailable, 401); }
  try {
    const assurance = await aal2Verdict(ctx, 'documents', '/capture/link');
    if (assurance.action === 'step_up') return json({ ok: false, reason: 'step_up', retryable: false, stepUp: assurance.to }, 403);
    const body = await readBoundedRequestJson(req, MAX_SMALL_JSON_BYTES);
    if (!body.ok || !body.value || typeof body.value !== 'object') return json({ ok: false, reason: 'invalid_url', retryable: false }, 400);
    const input = body.value as Record<string, unknown>;
    if (input.expectedFamilyId !== ctx.active.familyId || input.expectedUserId !== ctx.user.id) return json({ ok: false, reason: 'context_changed', retryable: false }, 409);
    if (typeof input.url !== 'string' || typeof input.captureId !== 'string' || (input.messageId !== undefined && typeof input.messageId !== 'string')) return json({ ok: false, reason: 'invalid_url', retryable: false }, 400);
    const db = await createServer();
    const checkAccess = () => authorizeDocumentLink(ctx, db, input.messageId !== undefined);
    const access = await checkAccess();
    if (!access.ok) return json(access, access.retryable ? 503 : access.reason === 'context_changed' ? 409 : 403);
    const limited = await enforceAIRateLimit(db, `document-link:${ctx.user.id}`, { limit: 15 });
    if (!limited.ok) return json(unavailable, 429);
    const result = await captureDocumentLink(scopeFromUserContext(ctx, db), { url: input.url, captureId: input.captureId, messageId: input.messageId as string | undefined }, { signal: req.signal, beforeWrite: checkAccess });
    return json(result, result.ok ? 200 : result.retryable ? 503 : result.reason === 'context_changed' ? 409 : result.reason === 'access_denied' ? 403 : 400);
  } catch {
    console.error('[document-link] request failed');
    return json(unavailable, 503);
  }
}
