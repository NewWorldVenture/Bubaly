import { NextRequest, NextResponse } from 'next/server';
import { ProviderHttpError, ProviderMalformedResponse } from '@/lib/server/provider-http-error';
import { refuseOverAIAllowance } from '@/lib/server/ai-access';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { getTranslations } from '@/lib/i18n/server';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { refuseUnlessEntitled } from '@/lib/server/route-feature-gate';
import { requireUserContext } from '@/lib/supabase/auth';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { getAIConfig } from '@/lib/ai/settings';
import { MAX_FLYER_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { readBoundedResponseJson, readBoundedResponseText } from '@/lib/server/bounded-response-body';
import { fetchWithDeadline } from '@/lib/server/fetch-with-deadline';

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

/** A string field, or null: a provider value of any other type is not used. */
const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/**
 * The model's reply, as the events the confirm step can use. Only rows with a
 * string title and date are kept; every optional field the model sent with the
 * wrong type is dropped to null rather than cast, so the response never carries
 * an object where `ProposedEvent` says string. A reply with no JSON array is no
 * events, as before.
 */
function buildEvents(text: string): ProposedEvent[] {
  let raw: unknown = [];
  try {
    const match = text.match(/\[[\s\S]*\]/);
    raw = JSON.parse(match?.[0] ?? '[]');
  } catch {
    raw = [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as Record<string, unknown>).title === 'string' && typeof (r as Record<string, unknown>).date === 'string')
    .map((r) => {
      const date = r.date as string;
      const { iso, allDay } = toIso(date, textOrNull(r.time));
      const endTime = textOrNull(r.end_time);
      const ends = endTime ? toIso(date, endTime).iso : null;
      const location = textOrNull(r.location);
      const category = typeof r.category === 'string' && CATEGORIES.includes(r.category) ? r.category : 'general';
      return {
        title: r.title as string,
        starts_at: iso,
        ends_at: ends,
        all_day: allDay,
        location,
        description: textOrNull(r.description),
        category,
        summary: fmtSummary(r.title as string, iso, allDay, location),
      };
    });
}

/** The most events one confirm may create — the cap `/api/ai/import` uses. */
const MAX_CONFIRMED_EVENTS = 50;

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
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;
    const userId = ctx.user.id;
    const supabase = await createServer();
    // The page in front of this is feature-gated; this endpoint was not, and it
    // calls a model. Same resolver, so the two cannot disagree.
    const refused = await refuseUnlessEntitled(supabase, ctx.active.familyId, ['/dashboard/scan']);
    if (refused) return refused;

    const limited = await enforceAIRateLimit(supabase, `ai-flyer:${userId}`, { limit: 15 });
    if (!limited.ok) return NextResponse.json(
      { error: t('flyer.tooManyFlyerScansPlease') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );

    const boundedBody = await readBoundedRequestJson(req, MAX_FLYER_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Flyer upload is too large.' : 'Invalid request body' }, { status: 400 });
    const body = (boundedBody.value ?? {}) as {
      data?: string; mediaType?: string; confirm?: ProposedEvent[];
    };

    // ── Phase 2: create the confirmed events ───────────────────────────────
    // `confirm` is whatever the caller posts, not what phase 1 proposed — the
    // two halves share a route, not a session — and this block used to forward
    // it to the database field for field. Nothing capped the array (an 8 MiB
    // body holds tens of thousands of rows for one insert), nothing checked
    // that `title` was a string (it is `not null`, so an object without one is
    // a 23502 the catch below reports as a 500), and nothing checked that
    // `starts_at` was a date (`timestamptz not null`, so "tomorrow-ish" is a
    // 22007, likewise a 500). `/api/ai/import` already takes the same confirm
    // shape with `.slice(0, 50)`; this is that rule plus the field checks the
    // columns imply, so a malformed item is dropped rather than turned into a
    // server error.
    if (Array.isArray(body.confirm)) {
      const text = (value: unknown, max: number): string | null => (
        typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
      );
      const instant = (value: unknown): string | null => {
        const raw = typeof value === 'string' ? value.trim() : '';
        if (!raw) return null;
        const at = new Date(raw);
        return Number.isNaN(at.getTime()) ? null : at.toISOString();
      };
      const rows = body.confirm.slice(0, MAX_CONFIRMED_EVENTS).flatMap((e) => {
        const title = text(e?.title, 200);
        const startsAt = instant(e?.starts_at);
        if (!title || !startsAt) return [];
        return [{
          family_id: familyId,
          created_by: userId,
          title,
          starts_at: startsAt,
          ends_at: instant(e.ends_at),
          all_day: e.all_day === true,
          location: text(e.location, 300),
          description: text(e.description, 2000),
          category: (CATEGORIES.includes(e.category) ? e.category : 'general') as never,
        }];
      });
      if (rows.length === 0) return NextResponse.json({ created: 0 });
      const { data, error } = await supabase.from('calendar_events').insert(rows).select('id');
      if (error) {
        console.error('Flyer calendar write failed:', error);
        return NextResponse.json({ error: t('flyer.couldNotSaveTheCalendar') }, { status: 500 });
      }
      return NextResponse.json({ created: data?.length ?? 0 });
    }

    // ── Phase 1: extract events from the uploaded flyer ────────────────────
    const data = body.data ?? '';
    const mediaType = body.mediaType ?? '';
    if (!data) return NextResponse.json({ error: t('flyer.noFileReceived') }, { status: 400 });
    if (data.length > 8_000_000) return NextResponse.json({ error: t('flyer.fileIsTooLarge5') }, { status: 400 });

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
    if (!isPdf && !isImage) return NextResponse.json({ error: t('flyer.uploadAnImageJpgPng') }, { status: 400 });

    // OpenAI-only deployment. Use the admin-configured OpenAI key/model
    // (Admin → AI Engine) with env fallback. gpt-4o reads images directly and
    // PDFs via the file input part.
    // F19: the monthly AI allowance the plans sell, checked before the model runs.
    const overAllowance = await refuseOverAIAllowance(ctx, supabase);
    if (overAllowance) return overAllowance;

    const aiConfig = await getAIConfig(createServiceClient());
    const apiKey = aiConfig.openaiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: t('flyer.flyerScanningNeedsAnOpenai') }, { status: 503 });
    }
    const model = aiConfig.model && /^(gpt-|o\d|chatgpt-)/i.test(aiConfig.model) ? aiConfig.model : 'gpt-4o';

    const filePart = isPdf
      ? { type: 'file' as const, file: { filename: 'flyer.pdf', file_data: `data:application/pdf;base64,${data}` } }
      : { type: 'image_url' as const, image_url: { url: `data:${mediaType};base64,${data}` } };

    // Recorded like every other AI route, so the call counts against the allowance (F19).
    // The status, the body and the field the route reads are all checked INSIDE
    // the observed body: a provider 500 or 429, invalid JSON, or a non-string
    // answer is a failed call, and checking any of them after the Response was
    // returned recorded it as completed.
    let events: ProposedEvent[];
    try {
      events = await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: 'flyer.scan', text: 'Scan a flyer' },
      async (obs) => {
        const res = await fetchWithDeadline('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            max_tokens: 1500,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, filePart] }],
          }),
        }, 60_000);
        obs.used(model, null);
        if (!res.ok) {
          const bounded = await readBoundedResponseText(res, 64 * 1024);
          throw new ProviderHttpError(res.status, bounded.ok ? bounded.text : '[provider error response exceeded 64 KiB]');
        }
        let body: { choices?: Array<{ message?: { content?: unknown } }> };
        try {
          body = await readBoundedResponseJson<typeof body>(res, 1 * 1024 * 1024);
        } catch (parseErr) {
          throw new ProviderMalformedResponse(res.status, `unreadable body: ${String(parseErr)}`);
        }
        const content = body?.choices?.[0]?.message?.content;
        if (content !== undefined && content !== null && typeof content !== 'string') {
          throw new ProviderMalformedResponse(res.status, `message content is ${typeof content}, not text`);
        }
        // The events are parsed and shaped here too, while the request is
        // still open: a nested field of the wrong type (a location object, a
        // value that throws when formatted) is a malformed answer, and building
        // the response after the row closed recorded it as completed and then
        // failed the caller with a 500.
        try {
          return buildEvents(content ?? '[]');
        } catch (buildErr) {
          throw new ProviderMalformedResponse(res.status, `unusable events: ${String(buildErr)}`);
        }
      },
      );
    } catch (err) {
      if (!(err instanceof ProviderHttpError)) throw err;
      console.error('Flyer OpenAI error', err.status, err.detail);
      return NextResponse.json({ error: t('flyer.couldNotReadThatFlyer') }, { status: 502 });
    }
    return NextResponse.json({ events });
  } catch (err) {
    console.error('Flyer scan error:', err);
    return NextResponse.json({ error: t('flyer.couldNotReadThatFlyer2') }, { status: 500 });
  }
}
