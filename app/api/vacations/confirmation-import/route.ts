import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { scopeFromUserContext } from '@/lib/services/scope';
import { readBoundedRequestBytes } from '@/lib/server/bounded-request-body';
import { previewConfirmationImport, applyConfirmationImport } from '@/lib/services/trips/confirmation-import';
import { confirmationSourceSchema, confirmationFieldsSchema, confirmationPreviewSchema } from '@/lib/vacations/confirmation-import';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_BODY_BYTES = 512 * 1024;
const identity = {
  familyId: z.string().uuid(),
  memberId: z.string().uuid(),
  vacationId: z.string().uuid(),
  source: confirmationSourceSchema,
  fields: confirmationFieldsSchema,
};
const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preview'), ...identity }).strict(),
  z.object({
    action: z.literal('apply'), ...identity,
    expected: confirmationPreviewSchema, requestId: z.string().uuid(),
  }).strict(),
]);
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' };
const errorResponse = (error: string, status: number, code?: string) =>
  NextResponse.json({ error, ...(code ? { code } : {}) }, { status, headers });

function failureStatus(code: string | undefined): number {
  switch (code) {
    case 'invalid_input': return 400;
    case 'unauthorized': return 401;
    case 'denied': return 403;
    case 'not_found': return 404;
    case 'conflict': return 409;
    default: return 503;
  }
}

export async function POST(request: Request) {
  try {
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return errorResponse('A JSON confirmation import is required.', 400);
    }
    const bounded = await readBoundedRequestBytes(request, MAX_BODY_BYTES);
    if (!bounded.ok) return errorResponse('The request is unreadable or exceeds 512 KiB.', 400);
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bounded.bytes));
    } catch {
      return errorResponse('The request must contain valid UTF-8 JSON.', 400);
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) return errorResponse('The confirmation import request is invalid.', 400);
    const body = parsed.data;

    const db = await createServer();
    const auth = await db.auth.getUser();
    if (auth.error || !auth.data.user) {
      if (!auth.error || auth.error.name === 'AuthSessionMissingError' || auth.error.code === 'session_missing') {
        return errorResponse('Sign in to review a travel confirmation.', 401);
      }
      return errorResponse('Account context is temporarily unavailable.', 503);
    }
    // getUserContext avoids the onboarding/provisioning side effect of requireUserContext.
    const ctx = await getUserContext();
    if (!ctx) return errorResponse('Sign in to review a travel confirmation.', 401);
    if ('needsFamily' in ctx) return errorResponse('Select an active family first.', 403);
    const active = ctx.active;
    if (ctx.user.id !== auth.data.user.id || active.familyId !== body.familyId
      || active.family.id !== body.familyId || active.member.id !== body.memberId
      || active.member.family_id !== body.familyId || active.member.user_id !== ctx.user.id
      || active.member.is_active !== true || active.member.role !== active.role
      || !['parent', 'adult'].includes(active.role)) {
      return errorResponse('The active parent or adult family context has changed.', 403);
    }
    const scope = scopeFromUserContext(ctx, db);
    const input = { vacationId: body.vacationId, source: body.source, fields: body.fields };
    const result = body.action === 'apply'
      ? await applyConfirmationImport(scope, { ...input, expected: body.expected, requestId: body.requestId })
      : await previewConfirmationImport(scope, input);
    if (!result.ok) return errorResponse(result.error, failureStatus(result.code), result.code);
    return NextResponse.json(result.data, { headers });
  } catch {
    return errorResponse('Confirmation import is temporarily unavailable. Retry a save with the same request ID.', 503);
  }
}
