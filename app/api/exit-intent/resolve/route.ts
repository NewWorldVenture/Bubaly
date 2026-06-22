import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, clientIp } from '@/lib/server/rate-limit';
import { resolveActiveExitIntent } from '@/lib/marketing/exit-intent-server';
import type { VisitorContext } from '@/lib/marketing/personalization';

export const runtime = 'nodejs';

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined);

/** Public: resolve the best exit-intent offer for this visitor's context. */
export async function POST(req: NextRequest) {
  const limit = rateLimit(`ei-resolve:${clientIp(req.headers)}`, { limit: 60, windowMs: 60_000 });
  if (!limit.ok) return NextResponse.json({ offer: null }, { status: 429 });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty ctx is fine */ }

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
