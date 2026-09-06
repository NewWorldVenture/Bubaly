import { isDeepStrictEqual } from 'node:util';
import { NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { getUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { isManager } from '@/lib/constants/roles';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { featureAccessByTier, isFeatureTier, resolveFeatureTiers, type FeatureOverrides } from '@/lib/features/tiers';
import { isMoveDate, isMoveDatePreview, isMoveDateResult, type MoveDatePreview } from '@/lib/moving/recalculation';
import type { Json } from '@/lib/database.types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_KEYS = new Set(['familyId', 'memberId', 'moveId', 'date', 'expected', 'requestId']);
const SCHEMA_ERRORS = new Set(['42883', '42703', '42P01', '3F000', 'PGRST002', 'PGRST200', 'PGRST202', 'PGRST203', 'PGRST204', 'PGRST205']);

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

function failure(code: string, error: string, status: number) {
  return json({ code, error }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

class BodyError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

async function readBody(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_BODY_BYTES) {
    throw new BodyError(413, 'body_too_large');
  }
  if (!request.body) throw new BodyError(400, 'invalid_body');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new BodyError(413, 'body_too_large');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    // Stop consuming an oversized or broken stream without waiting for its producer.
    void reader.cancel().catch(() => undefined);
    if (error instanceof BodyError) throw error;
    throw new BodyError(400, 'invalid_body');
  } finally {
    reader.releaseLock();
  }
}

function matchesScope(preview: MoveDatePreview, familyId: string, memberId: string, moveId: string, date: string) {
  return preview.familyId === familyId && preview.memberId === memberId
    && preview.moveId === moveId && preview.toDate === date;
}

function rpcFailure(error: unknown) {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
  switch (code) {
    case '40001':
      return failure('stale_review', 'The move or its tasks changed. Review the dates again before applying.', 409);
    case '23505':
      return failure('idempotency_conflict', 'This request ID belongs to a different reviewed change.', 409);
    case '42501':
      return failure('authorization', 'Your current membership cannot change this move.', 403);
    case 'P0002':
      return failure('move_unavailable', 'This move is not available in the current family.', 404);
    case '22023':
      return failure('invalid_request', 'This move-date request cannot be applied.', 400);
    case '54000':
      return failure('coverage_limit', 'There are too many tasks to safely review this move.', 422);
    default:
      if (SCHEMA_ERRORS.has(code)) {
        return failure('schema_unavailable', 'Move-date recalculation is not available yet.', 503);
      }
      return failure('recalculation_unavailable', 'Move-date recalculation is temporarily unavailable.', 503);
  }
}

export async function POST(request: Request) {
  try {
    if (request.method !== 'POST') {
      const response = failure('method_not_allowed', 'Use POST for move-date recalculation.', 405);
      response.headers.set('Allow', 'POST');
      return response;
    }
    const ctx = await getUserContext();
    if (!ctx) return failure('signed_out', 'Sign in to review move dates.', 401);
    if ('needsFamily' in ctx) return failure('needs_family', 'Select an existing family first.', 403);
    const active = ctx.active;
    if (!active || !isManager(active.role)) {
      return failure('role_required', 'A parent or adult must review move dates.', 403);
    }
    if (!isUuid(active.familyId) || !isUuid(active.member?.id) || active.member.is_active !== true) {
      return failure('membership_required', 'A current active membership is required.', 403);
    }

    let body: unknown;
    try {
      body = await readBody(request);
    } catch (error) {
      if (error instanceof BodyError) {
        return failure(error.code, error.status === 413 ? 'The request body exceeds the size limit.' : 'Send a valid JSON request body.', error.status);
      }
      throw error;
    }
    if (!isRecord(body) || Object.keys(body).some((key) => !BODY_KEYS.has(key))) {
      return failure('invalid_body', 'Send only the move-date request fields.', 400);
    }

    const familyId = active.familyId;
    const memberId = active.member.id;
    if (!isUuid(body.familyId) || !isUuid(body.memberId) || body.familyId !== familyId || body.memberId !== memberId) {
      return failure('context_changed', 'Your selected family or member changed. Open the move again.', 403);
    }
    if (!isUuid(body.moveId) || !isMoveDate(body.date)) {
      return failure('invalid_request', 'Choose an existing move and a valid calendar date.', 400);
    }

    const hasExpected = Object.hasOwn(body, 'expected');
    const hasRequestId = Object.hasOwn(body, 'requestId');
    if (hasExpected !== hasRequestId) {
      return failure('invalid_request', 'Applying a date requires both its reviewed preview and a request ID.', 400);
    }
    const expected = hasExpected && isMoveDatePreview(body.expected) ? body.expected : null;
    const requestId = hasRequestId && isUuid(body.requestId) ? body.requestId : null;
    if (hasExpected && (!expected || !matchesScope(expected, familyId, memberId, body.moveId, body.date))) {
      return failure('invalid_expected', 'The reviewed preview does not match this move-date request.', 400);
    }
    if (hasRequestId && !requestId) {
      return failure('invalid_request', 'Use a valid request ID for this reviewed change.', 400);
    }

    const db = await createServer();
    const { data: setting, error: settingError } = await db.from('app_settings')
      .select('value').eq('key', 'feature_tiers').maybeSingle();
    if (settingError) return failure('access_unavailable', 'Feature access could not be checked.', 503);
    const overrides: FeatureOverrides = {};
    const settingValue = setting?.value;
    if (settingValue !== null && settingValue !== undefined) {
      if (!isRecord(settingValue)) return failure('access_unavailable', 'Feature access could not be checked.', 503);
      for (const [key, value] of Object.entries(settingValue)) {
        if (typeof value === 'string' && isFeatureTier(value)) overrides[key] = value;
        else if (key === 'move-planner') return failure('access_unavailable', 'Feature access could not be checked.', 503);
      }
    }
    const tiers = resolveFeatureTiers(overrides);
    const superAdmin = await isSuperAdmin();
    const level = superAdmin ? 2 : await resolveFamilyPlanLevel(db, familyId);
    if (typeof superAdmin !== 'boolean' || !Number.isInteger(level) || level < 0 || level > 2 || !tiers['move-planner']) {
      return failure('access_unavailable', 'Feature access could not be checked.', 503);
    }
    // feature-catalog maps requireFeature('/dashboard/moving') to move-planner.
    const access = featureAccessByTier(tiers['move-planner'], level, superAdmin);
    if (access === 'hidden') return failure('feature_off', 'Not found.', 404);
    if (access !== 'visible') return failure('plan_required', 'Your family plan does not include the move planner.', 403);

    // This cookie-bound RPC owns scoped reads, optimistic concurrency and atomic writes.
    // A preview always sends both optional arguments as null; an apply forwards the review unchanged.
    const { data, error } = await db.rpc('move_recalculate_date', {
      p_family_id: familyId,
      p_move_id: body.moveId,
      p_member_id: memberId,
      p_new_date: body.date,
      p_expected: expected as unknown as Json | null,
      p_request_id: requestId,
    });
    if (error) return rpcFailure(error);
    if (!isMoveDateResult(data) || !matchesScope(data.preview, familyId, memberId, body.moveId, body.date)
      || data.applied !== hasExpected || data.requestId !== requestId
      || (hasExpected ? data.appliedAt === null : data.appliedAt !== null)
      || (expected !== null && !isDeepStrictEqual(data.preview, expected))) {
      return failure('invalid_result', 'The move-date result could not be confirmed.', 503);
    }
    return json(data);
  } catch {
    return failure('recalculation_unavailable', 'Move-date recalculation is temporarily unavailable.', 503);
  }
}
