import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { fetchPublicCalendarText } from '@/lib/server/public-calendar-fetch';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { readBoundedRequestText } from '@/lib/server/bounded-request-body';

import { parseICS, type IcsEvent } from '@/lib/sync/ics';
import { parseICSSource } from '@/lib/sync/ics-source';
import { assertFeedRecurrenceAdmission, icsRruleToRecurrence } from '@/lib/calendar/feeds';

/** Native rows have no free/busy metadata. Only opaque live copies are faithful. */
function nativeCopyTransparency(raw: string | null): 'opaque' | 'transparent' {
  if (typeof raw !== 'string') throw new Error('Missing source metadata');
  let depth = 0, seen = false;
  let transparency: 'opaque' | 'transparent' = 'opaque';
  for (const line of raw.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n')) {
    if (/^BEGIN:[A-Z]+$/i.test(line)) { depth++; continue; }
    if (/^END:[A-Z]+$/i.test(line)) { depth--; continue; }
    if (depth !== 1 || !/^TRANSP[;:]/i.test(line)) continue;
    // The strict parser owns the envelope. Qualify this immediate VEVENT
    // property separately: extensions/duplicates cannot silently become busy.
    if (seen || !/^TRANSP:(OPAQUE|TRANSPARENT)$/i.test(line)) throw new Error('Unqualified source transparency');
    seen = true;
    transparency = line.slice(line.indexOf(':') + 1).toUpperCase() === 'TRANSPARENT' ? 'transparent' : 'opaque';
  }
  return transparency;
}

/** A one-shot import makes native copies, never source archives or exception
 * identities. Qualify the ENTIRE calendar before its first native write. */
function importedEvents(text:string):IcsEvent[] {
  const documents=parseICSSource(text); // Strict envelope and original clocks.
  for(const document of documents){
    const component=document.master;
    if(document.timezones.length)throw new Error('Source timezone definitions need an archive');
    for (const candidate of [...(component ? [component] : []), ...document.overrides]) {
      const transparency = nativeCopyTransparency(candidate.raw);
      if (candidate.status !== 'cancelled' && transparency === 'transparent') throw new Error('Transparent source events need an archive');
    }
    if(component?.status==='cancelled')continue;
    if(component?.dtstart?.kind==='floating'||component?.end?.kind==='dtend'&&component.end.value.kind==='floating')throw new Error('Floating source clock needs a durable timezone');
    if(component?.end?.kind==='dtend'&&((component.dtstart?.kind==='date')!==(component.end.value.kind==='date')))throw new Error('Mixed source clock types');
  }
  // Normalize structural tokens only. Property values (UID, title, clocks) stay original.
  const projectionText=text.replace(/\r\n/g,'\n').replace(/\n[ \t]/g,'').replace(/^(BEGIN|END):([A-Z]+)$/gim,line=>line.toUpperCase());
  if(/^BEGIN:VALARM$/m.test(projectionText))throw new Error('Source alarms cannot be preserved by native copies');
  const events=parseICS(projectionText,{bareCancellations:true,validateEvent:event=>{
    assertFeedRecurrenceAdmission(event);
    if(event.status==='cancelled')return;
    if(!event.uid||!event.startsAt||!event.title||event.hasDuration)throw new Error('Unrepresentable calendar component');
    // Native missing-end timed rows estimate one hour; source defaults are points.
    if(!event.allDay&&!event.endsAt)throw new Error('Unknown source duration');
    if(event.endsAt&&(Date.parse(event.endsAt)<Date.parse(event.startsAt)||event.allDay&&Date.parse(event.endsAt)===Date.parse(event.startsAt)))throw new Error('Invalid source interval');
  }});
  if(events.length!==documents.length)throw new Error('Incomplete source projection');
  const seen=new Set<string>();
  for(const event of events){if(seen.has(event.uid))throw new Error('Multiple source revisions');seen.add(event.uid);}
  return events.filter(event=>event.status!=='cancelled');
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

    let events:IcsEvent[];
    try { events=importedEvents(icsText); }
    catch { return NextResponse.json({error:t('calendarImport.invalidCalendar')},{status:422}); }
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
      description: e.description ? `${e.description}\n[UID: ${e.uid}]` : `[Imported from ${label ?? 'ICS'}]\n[UID: ${e.uid}]`,
      location: e.location ?? null,
      starts_at: e.startsAt,
      ends_at: e.endsAt ?? null,
      all_day: e.allDay ?? false,
      recurrence: icsRruleToRecurrence(e.recurrenceRule) as 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly',
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
