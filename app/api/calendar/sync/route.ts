import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { fetchPublicCalendarText } from '@/lib/server/public-calendar-fetch';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { readBoundedRequestText } from '@/lib/server/bounded-request-body';

// ICS parser — no external dep, pure hand-rolled RFC 5545 parser
function parseIcs(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/\n /g, '').replace(/\n\t/g, '').split('\n');

  let cur: IcsEvent | null = null;

  for (const raw of lines) {
    const colon = raw.indexOf(':');
    if (colon === -1) continue;
    const key = raw.slice(0, colon).toUpperCase();
    const val = raw.slice(colon + 1).trim();

    if (key === 'BEGIN' && val === 'VEVENT') { cur = {} as IcsEvent; continue; }
    if (key === 'END' && val === 'VEVENT') { if (cur && cur.uid && cur.start) events.push(cur); cur = null; continue; }
    if (!cur) continue;

    switch (key) {
      case 'UID':        cur.uid     = val;             break;
      case 'SUMMARY':    cur.title   = unescapeIcs(val); break;
      case 'DESCRIPTION': cur.notes  = unescapeIcs(val); break;
      case 'LOCATION':   cur.location= unescapeIcs(val); break;
      case 'DTSTART': case 'DTSTART;VALUE=DATE':
        cur.start = parseIcsDate(key, val); cur.allDay = key.includes('VALUE=DATE'); break;
      case 'DTEND': case 'DTEND;VALUE=DATE':
        cur.end = parseIcsDate(key, val); break;
      case 'RRULE':      cur.rrule   = val;             break;
      case 'STATUS':     cur.status  = val.toLowerCase(); break;
    }
    if (key.startsWith('DTSTART;')) { cur.start = parseIcsDate(key, val); cur.allDay = key.includes('VALUE=DATE'); }
    if (key.startsWith('DTEND;'))   { cur.end   = parseIcsDate(key, val); }
  }

  return events;
}

interface IcsEvent {
  uid: string; title?: string; notes?: string; location?: string;
  start: string; end?: string; allDay?: boolean; rrule?: string; status?: string;
}

function unescapeIcs(s: string) {
  return s.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function parseIcsDate(key: string, val: string): string {
  const isDate = key.includes('VALUE=DATE') || (val.length === 8 && !val.includes('T'));
  if (isDate) {
    const y = val.slice(0, 4), m = val.slice(4, 6), d = val.slice(6, 8);
    return `${y}-${m}-${d}T00:00:00.000Z`;
  }
  // YYYYMMDDTHHMMSSZ  or  YYYYMMDDTHHMMSS
  const clean = val.replace('Z', '');
  const y = clean.slice(0, 4), mo = clean.slice(4, 6), d = clean.slice(6, 8);
  const h = clean.slice(9, 11), mi = clean.slice(11, 13), s = clean.slice(13, 15);
  const z = val.endsWith('Z') ? 'Z' : '';
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${z || '.000Z'}`;
}

function icsRruleToDb(rrule: string | undefined): string {
  if (!rrule) return 'none';
  const match = rrule.match(/FREQ=(\w+)/i);
  if (!match) return 'none';
  switch (match[1].toUpperCase()) {
    case 'DAILY': return 'daily';
    case 'WEEKLY': return 'weekly';
    case 'MONTHLY': return 'monthly';
    case 'YEARLY': return 'yearly';
    default: return 'none';
  }
}

export async function POST(req: NextRequest) {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    const { familyId } = ctx.active;
    const supabase = await createServer();
    // This route fetches a URL the caller chooses and then writes as many
    // calendar rows as that URL returns, and it was the only import path with
    // no limiter — `/api/sync/run` and `/api/sync/google/sync` both gate the
    // same work with this helper. Same key shape, before the body is read so a
    // rejected caller costs neither the outbound fetch nor the parse.
    const limited = await enforceRequestRateLimit(supabase, `calendar-ics:${familyId}:${ctx.user.id}`, { limit: 10 });
    if (!limited.ok) return NextResponse.json(
      { error: t('sync.tooManySyncRequestsPlease') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
    const boundedBody = await readBoundedRequestText(req, 16_384);
    if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body too large' : 'Unable to read request body' }, { status: boundedBody.reason === 'too_large' ? 413 : 400 });
    const rawBody = boundedBody.text;
    let body: { icsUrl?: unknown; label?: unknown };
    try {
      body = JSON.parse(rawBody) as { icsUrl?: unknown; label?: unknown };
    } catch {
      return NextResponse.json({ error: t('sync.invalidRequestBody') }, { status: 400 });
    }
    const icsUrl = typeof body.icsUrl === 'string' ? body.icsUrl : '';
    const label = typeof body.label === 'string' ? body.label : undefined;

    if (!icsUrl || typeof icsUrl !== 'string') {
      return NextResponse.json({ error: t('sync.icsurlIsRequired') }, { status: 400 });
    }

    const fetched = await fetchPublicCalendarText(icsUrl);
    if (!fetched.ok) return NextResponse.json({ error: fetched.error }, { status: fetched.status });
    const icsText = fetched.text;
    if (!icsText.includes('BEGIN:VCALENDAR')) {
      return NextResponse.json({ error: t('sync.urlDoesNotAppearTo') }, { status: 422 });
    }

    const events = parseIcs(icsText);
    if (events.length === 0) {
      return NextResponse.json({ imported: 0, message: 'Calendar is empty or no events found' });
    }

    // NOT deduped. This comment used to say "Upsert events — dedup by
    // (family_id, external_uid)" and none of that was true: the write below is
    // a plain `.insert`, and `external_uid` (added in 0045, with the
    // `(feed_id, external_uid)` unique index 0285 made inferable) is never
    // written — the ICS UID goes into `description` as text. Re-importing the
    // same URL therefore duplicates the family's whole calendar. The subscribed
    // -feed path in `lib/server/calendar-feeds.ts` does it properly, via a
    // `calendar_feeds` row this one-shot importer never creates; deduping here
    // needs that row, which is more than a comment fix. What is fixed is the
    // claim, so the next reader is not told this is idempotent when it is not.
    const rows = events.map((e) => ({
      family_id: familyId,
      title: e.title ?? 'Untitled',
      description: e.notes ? `${e.notes}\n[UID: ${e.uid}]` : `[Imported from ${label ?? 'ICS'}]`,
      location: e.location ?? null,
      starts_at: e.start,
      ends_at: e.end ?? null,
      all_day: e.allDay ?? false,
      recurrence: icsRruleToDb(e.rrule) as 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly',
      category: 'general' as const,
    }));

    // Batch insert in chunks of 200. A Postgres insert is atomic per statement,
    // so a refused chunk is 200 events lost — and the discarded `error` meant
    // every one of them could be refused and this route still answered 200 with
    // a cheerful `{ imported: 0 }`. The importer is the only thing that knows
    // the write failed, so it is the only thing that can say so.
    let imported = 0;
    let failed = 0;
    let firstError: unknown = null;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error } = await supabase.from('calendar_events').insert(chunk);
      if (error) {
        failed += chunk.length;
        firstError ??= error;
        console.error('[calendar-sync] imported event write failed', error);
        continue;
      }
      imported += chunk.length;
    }
    if (imported === 0 && failed > 0) {
      return NextResponse.json({ error: t('sync.couldNotSaveImportedCalendar') }, { status: 503 });
    }

    return NextResponse.json({ imported, total: events.length, ...(failed ? { failed } : {}) });
  } catch (err: unknown) {
    console.error('ICS sync error:', err);
    return NextResponse.json({ error: 'Could not import the calendar.' }, { status: 500 });
  }
}
