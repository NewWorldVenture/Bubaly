import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { rateLimit, clientIp } from '@/lib/server/rate-limit';

export const runtime = 'nodejs';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

type ProposedEvent = {
  title: string;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  location: string | null;
  description: string | null;
  category: string;
  summary: string;
};

const CATEGORIES = ['general', 'school', 'sports', 'appointment', 'medication', 'maintenance', 'birthday', 'holiday', 'other'];

function toIso(date: string, time: string | null): { iso: string; allDay: boolean } {
  if (!time) {
    const d = new Date(`${date}T09:00:00`);
    return { iso: Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(), allDay: true };
  }
  const d = new Date(`${date}T${time.length === 5 ? time : '09:00'}:00`);
  return { iso: Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(), allDay: false };
}

function fmtSummary(title: string, iso: string, allDay: boolean, location: string | null): string {
  const d = new Date(iso);
  const when = d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    ...(allDay ? {} : { hour: 'numeric', minute: '2-digit' }),
  });
  return `📅 ${title} — ${when}${allDay ? ' (all day)' : ''}${location ? ` @ ${location}` : ''}`;
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;
    const userId = ctx.user.id;
    const supabase = await createServer();

    const ip = clientIp(req.headers);
    const limit = rateLimit(`flyer:${userId || ip}`, { limit: 15, windowMs: 60_000 });
    if (!limit.ok) return NextResponse.json({ error: 'Slow down a moment and try again.' }, { status: 429 });

    const body = (await req.json()) as {
      data?: string; mediaType?: string; confirm?: ProposedEvent[];
    };

    // ── Phase 2: create the confirmed events ───────────────────────────────
    if (Array.isArray(body.confirm)) {
      const rows = body.confirm.map((e) => ({
        family_id: familyId,
        created_by: userId,
        title: e.title,
        starts_at: e.starts_at,
        ends_at: e.ends_at,
        all_day: e.all_day,
        location: e.location,
        description: e.description,
        category: (CATEGORIES.includes(e.category) ? e.category : 'general') as never,
      }));
      const { data, error } = await supabase.from('calendar_events').insert(rows).select('id');
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ created: data?.length ?? 0 });
    }

    // ── Phase 1: extract events from the uploaded flyer ────────────────────
    const data = body.data ?? '';
    const mediaType = body.mediaType ?? '';
    if (!data) return NextResponse.json({ error: 'No file received.' }, { status: 400 });
    if (data.length > 8_000_000) return NextResponse.json({ error: 'File is too large (≈5 MB max).' }, { status: 400 });

    const now = new Date();
    const prompt = `Extract EVERY calendar-worthy event from this flyer/document. Today is ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.

Return ONLY a JSON array (no markdown, no prose). Each item:
{"title": string, "date": "YYYY-MM-DD", "time": "HH:MM" (24h) or null, "end_time": "HH:MM" or null, "location": string or null, "description": string or null, "category": one of ${CATEGORIES.join('|')}}

Rules:
- Resolve partial dates ("Friday", "March 14") to absolute dates using today; pick the current or next occurrence and the correct year.
- Use null for time when the flyer gives only a date.
- If there are no events, return [].`;

    const isPdf = mediaType === 'application/pdf';
    const isImage = IMAGE_TYPES.includes(mediaType);
    if (!isPdf && !isImage) return NextResponse.json({ error: 'Upload an image (JPG/PNG/WebP) or PDF.' }, { status: 400 });

    const filePart = isPdf
      ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data } }
      : { type: 'image' as const, source: { type: 'base64' as const, media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif', data } };

    const response = await anthropic.messages.create({
      model: process.env.AI_MODEL ?? 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: [filePart, { type: 'text', text: prompt }] }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '[]';
    let raw: Array<Record<string, unknown>> = [];
    try {
      const match = text.match(/\[[\s\S]*\]/);
      raw = JSON.parse(match?.[0] ?? '[]');
    } catch {
      raw = [];
    }

    const events: ProposedEvent[] = raw
      .filter((r) => r && typeof r.title === 'string' && typeof r.date === 'string')
      .map((r) => {
        const { iso, allDay } = toIso(r.date as string, (r.time as string) ?? null);
        const ends = r.end_time ? toIso(r.date as string, r.end_time as string).iso : null;
        const location = (r.location as string) ?? null;
        const category = CATEGORIES.includes(r.category as string) ? (r.category as string) : 'general';
        return {
          title: r.title as string,
          starts_at: iso,
          ends_at: ends,
          all_day: allDay,
          location,
          description: (r.description as string) ?? null,
          category,
          summary: fmtSummary(r.title as string, iso, allDay, location),
        };
      });

    return NextResponse.json({ events });
  } catch (err) {
    console.error('Flyer scan error:', err);
    return NextResponse.json({ error: 'Could not read that flyer. Try a clearer photo.' }, { status: 500 });
  }
}
