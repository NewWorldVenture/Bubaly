import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { rateLimit, clientIp } from '@/lib/server/rate-limit';
import { resolveActiveExitIntent } from '@/lib/marketing/exit-intent-server';
import type { VisitorContext } from '@/lib/marketing/personalization';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined);

/** Public: resolve the best exit-intent offer for this visitor's context. */
export async function POST(req: NextRequest) {
  const t = await getTranslations();
  const limit = rateLimit(`ei-resolve:${clientIp(req.headers)}`, { limit: 60, windowMs: 60_000 });
  if (!limit.ok) return NextResponse.json({ offer: null }, { status: 429 });

  const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_SMALL_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: t('resolve.requestBodyIsTooLarge') }, { status: 400 });
  const body = (boundedBody.value ?? {}) as Record<string, unknown>;

  const ctx: VisitorContext = {
    source: str(body.source) ?? null,
    medium: str(body.medium) ?? null,
    campaign: str(body.campaign) ?? null,
    path: str(body.path) ?? null,
    country: str(body.country) ?? null,
    returning: body.returning === true,
    segments: Array.isArray(body.segments) ? body.segments.map(String) : [],
    sessions: typeof body.sessions === 'number' ? body.sessions : undefined,
  };

  const offer = await resolveActiveExitIntent(ctx);
  return NextResponse.json({ offer });
}
