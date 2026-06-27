import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { findFreeSlots, isCalendarContext, type BusyEvent, type CalendarContext } from '@/lib/calendar/scheduling';

// AI scheduling: read the selected family members' calendars (events + school +
// sports) over a window and return time slots where everyone is free. This is the
// engine the AI uses to schedule across each person's calendar. Resilient to the
// `context` column not existing yet (treats events as 'family' until 0094 is applied).
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;
    const body = (await req.json()) as {
      memberIds?: string[];
      windowStartISO?: string;
      windowEndISO?: string;
      durationMin?: number;
      contexts?: string[];
      workingHours?: { startHour: number; endHour: number };
      maxSuggestions?: number;
    };

    const durationMin = Math.min(Math.max(body.durationMin ?? 60, 15), 8 * 60);
    const now = Date.now();
    const windowStart = body.windowStartISO ? new Date(body.windowStartISO).getTime() : now;
    const windowEnd = body.windowEndISO ? new Date(body.windowEndISO).getTime() : now + 14 * 24 * 60 * 60 * 1000;
    if (Number.isNaN(windowStart) || Number.isNaN(windowEnd) || windowEnd <= windowStart) {
      return NextResponse.json({ error: 'Invalid window' }, { status: 400 });
    }
    const memberIds = (body.memberIds ?? []).filter(Boolean);
    const contexts = (body.contexts ?? []).filter(isCalendarContext) as CalendarContext[];

    const supabase = await createServer();
    const fromISO = new Date(windowStart - 24 * 60 * 60 * 1000).toISOString(); // catch spanning events
    const toISO = new Date(windowEnd).toISOString();

    const [{ data: events }, { data: school }, { data: sports }] = await Promise.all([
      supabase.from('calendar_events').select('*').eq('family_id', familyId).gte('starts_at', fromISO).lte('starts_at', toISO),
      supabase.from('school_events').select('starts_at, ends_at, member_id').eq('family_id', familyId).gte('starts_at', fromISO).lte('starts_at', toISO),
      supabase.from('sports_events').select('starts_at, ends_at, member_id').eq('family_id', familyId).gte('starts_at', fromISO).lte('starts_at', toISO),
    ]);

    // A member-scoped event blocks the busy set only if it belongs to a selected
    // member (or is unassigned → a whole-family commitment). With no members
    // selected, schedule across the whole family.
    const includesMember = (assignee: string | null | undefined) =>
      memberIds.length === 0 || assignee == null || memberIds.includes(assignee);

    const busy: BusyEvent[] = [];
    for (const e of (events ?? []) as Record<string, unknown>[]) {
      if (!includesMember(e.assignee_id as string | null)) continue;
      busy.push({
        starts_at: e.starts_at as string,
        ends_at: (e.ends_at as string | null) ?? null,
        all_day: (e.all_day as boolean | null) ?? false,
        context: (e.context as CalendarContext | undefined) ?? 'family',
        assignee_id: (e.assignee_id as string | null) ?? null,
      });
    }
    for (const s of (school ?? []) as { starts_at: string; ends_at: string | null; member_id: string | null }[]) {
      if (!includesMember(s.member_id)) continue;
      busy.push({ starts_at: s.starts_at, ends_at: s.ends_at, context: 'family', assignee_id: s.member_id });
    }
    for (const s of (sports ?? []) as { starts_at: string; ends_at: string | null; member_id: string | null }[]) {
      if (!includesMember(s.member_id)) continue;
      busy.push({ starts_at: s.starts_at, ends_at: s.ends_at, context: 'family', assignee_id: s.member_id });
    }

    const slots = findFreeSlots(busy, {
      windowStart, windowEnd, durationMin,
      workingHours: body.workingHours,
      contexts: contexts.length > 0 ? contexts : undefined,
      maxSuggestions: Math.min(body.maxSuggestions ?? 6, 12),
    });

    return NextResponse.json({
      durationMin,
      slots: slots.map((s) => ({ startISO: new Date(s.start).toISOString(), endISO: new Date(s.end).toISOString() })),
      busyCount: busy.length,
    });
  } catch (err) {
    console.error('AI schedule error:', err);
    return NextResponse.json({ error: 'Failed to find times' }, { status: 500 });
  }
}
