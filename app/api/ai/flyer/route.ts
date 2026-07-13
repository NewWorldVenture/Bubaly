import { NextRequest, NextResponse } from 'next/server';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { getAIConfig } from '@/lib/ai/settings';
import { MAX_FLYER_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';

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

    const limited = await enforceAIRateLimit(supabase, `ai-flyer:${userId}`, { limit: 15 });
    if (!limited.ok) return NextResponse.json(
      { error: 'Too many flyer scans. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );

    const boundedBody = await readBoundedRequestJson(req, MAX_FLYER_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Flyer upload is too large.' : 'Invalid request body' }, { status: 400 });
    const body = (boundedBody.value ?? {}) as {
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

    // OpenAI-only deployment. Use the admin-configured OpenAI key/model
    // (Admin → AI Engine) with env fallback. gpt-4o reads images directly and
    // PDFs via the file input part.
    const aiConfig = await getAIConfig(createServiceClient());
    const apiKey = aiConfig.openaiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'Flyer scanning needs an OpenAI API key. Add one in Admin → AI Engine.' }, { status: 503 });
    }
    const model = aiConfig.model && /^(gpt-|o\d|chatgpt-)/i.test(aiConfig.model) ? aiConfig.model : 'gpt-4o';

    const filePart = isPdf
      ? { type: 'file' as const, file: { filename: 'flyer.pdf', file_data: `data:application/pdf;base64,${data}` } }
      : { type: 'image_url' as const, image_url: { url: `data:${mediaType};base64,${data}` } };

    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, filePart] }],
      }),
    });
    if (!aiRes.ok) {
      console.error('Flyer OpenAI error', aiRes.status, await aiRes.text().catch(() => ''));
      return NextResponse.json({ error: 'Could not read that flyer. Try a clearer photo or a different file.' }, { status: 502 });
    }
    const aiJson = await aiRes.json();
    const text: string = aiJson.choices?.[0]?.message?.content ?? '[]';
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
