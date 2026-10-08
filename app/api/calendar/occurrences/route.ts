import { NextRequest, NextResponse } from 'next/server';
import { extractBearerToken, getBearerUserContext } from '@/lib/supabase/bearer';
import { briefingCalendarBounds } from '@/lib/briefing/calendar-window';
import { readCalendarOccurrences } from '@/lib/calendar/occurrences';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

/** Native calendar transport. Uses the caller's JWT/RLS, never a service client. */
export async function GET(req: NextRequest) {
  try {
    const token = extractBearerToken(req.headers.get('authorization'));
    if (!token) return json({ code: 'invalid_token' }, 401);
    const auth = await getBearerUserContext(token);
    if (!auth.ok) return json({ code: auth.reason }, auth.reason === 'invalid_token' ? 401 : auth.reason === 'needs_family' ? 403 : 503);
    const { ctx, supabase } = auth;
    if (req.headers.get('X-Bubaly-User-Id') !== ctx.user.id || req.headers.get('X-Bubaly-Family-Id') !== ctx.active.familyId) {
      return json({ code: 'context_changed' }, 409);
    }
    const p = req.nextUrl.searchParams;
    const fromDay = p.get('fromDay') ?? '';
    const days = Number(p.get('days') ?? '14');
    const limit = Number(p.get('limit') ?? '100');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDay) || !Number.isInteger(days) || days < 1 || days > 31 || !Number.isInteger(limit) || limit < 1 || limit > 100) return json({ code: 'invalid_window' }, 400);
    const timezone = ctx.active.family.timezone || 'UTC';
    let bounds;
    try { bounds = briefingCalendarBounds(fromDay, timezone, 0, days); } catch { return json({ code: 'invalid_window' }, 400); }
    const result = await readCalendarOccurrences(supabase, ctx.active.familyId, bounds, timezone, {
      columns: ['title', 'location', 'category'], overlap: true, limit,
    });
    if (result.error) return json({ code: 'calendar_unavailable' }, 503);
    return json({ userId: ctx.user.id, familyId: ctx.active.familyId, timezone, fromDay, toDay: bounds.allDayToDay, count: result.count,
      occurrences: result.data.map(row => ({
        eventId: row.id, occurrenceKey: JSON.stringify([row.id, row.starts_at]), title: row.title,
        starts_at: row.starts_at, ends_at: row.ends_at, all_day: row.all_day, location: row.location, category: row.category,
        startDate: row.all_day ? row.starts_at.slice(0, 10) : null,
        endDate: row.all_day ? row.ends_at?.slice(0, 10) ?? new Date(Date.parse(row.starts_at) + 86_400_000).toISOString().slice(0, 10) : null,
      })),
    });
  } catch { return json({ code: 'calendar_unavailable' }, 503); }
}
