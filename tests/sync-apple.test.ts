import { describe, it, expect } from 'vitest';
import { REQUIRED_ADAPTER_METHODS } from '@/lib/sync/adapter';
import {
  appleAdapter, isAppleSyncConfigured,
  packAppleCredential, unpackAppleCredential, appleBasicAuth,
  hrefPath, uidFromHref, xmlUnescape, extractLocal, hasLocal, responseBlocks,
  parsePrincipalHref, parseCalendarHomeHref, parseCalendarCollections, parseSyncResponse,
  appleEventToRow, rowToAppleEvent, buildEventIcs, buildSyncCollectionReport,
  type SyncItem,
} from '@/lib/sync/providers/apple';
import { microsoftAdapter } from '@/lib/sync/providers/microsoft';
import { parseICS } from '@/lib/sync/ics';
import { getAdapter, listAdapters, configuredAdapters, isProviderConfigured } from '@/lib/sync/registry';

describe('apple adapter — contract conformance', () => {
  it('implements every required adapter method', () => {
    for (const m of REQUIRED_ADAPTER_METHODS) {
      expect(typeof (appleAdapter as unknown as Record<string, unknown>)[m], `apple.${m}`).toBe('function');
    }
    expect(appleAdapter.provider).toBe('apple');
    expect(appleAdapter.label).toBe('Apple iCloud');
  });

  it('is key-gated OFF by default (no APPLE_SYNC_ENABLED)', () => {
    expect(isAppleSyncConfigured()).toBe(false);
    expect(appleAdapter.isConfigured()).toBe(false);
  });

  it('shares the provider-neutral content hashers with the other adapters', () => {
    const ev = { title: 'Dentist', description: 'Cleaning', location: '1 Main', starts_at: '2026-08-01T09:00:00.000Z', ends_at: '2026-08-01T09:30:00.000Z', all_day: false, recurrence_rule: null };
    expect(appleAdapter.eventContentHash(ev)).toBe(microsoftAdapter.eventContentHash(ev));
    const rem = { title: 'Milk', notes: null, due_at: null, is_completed: false };
    expect(appleAdapter.reminderContentHash(rem)).toBe(microsoftAdapter.reminderContentHash(rem));
  });
});

describe('apple adapter — registry wiring', () => {
  it('is registered and discoverable but excluded until keys are set', () => {
    expect(getAdapter('apple')).toBe(appleAdapter);
    expect(listAdapters()).toContain(appleAdapter);
    expect(isProviderConfigured('apple')).toBe(false);
    expect(configuredAdapters()).not.toContain(appleAdapter);
  });
});

describe('apple credential packing', () => {
  it('round-trips an Apple ID + app-specific password', () => {
    const packed = packAppleCredential('jane@icloud.com', 'abcd-efgh-ijkl-mnop');
    expect(unpackAppleCredential(packed)).toEqual({ appleId: 'jane@icloud.com', appPassword: 'abcd-efgh-ijkl-mnop' });
  });

  it('survives a password/email that itself contains a colon', () => {
    const packed = packAppleCredential('a:b@icloud.com', 'x:y:z');
    expect(unpackAppleCredential(packed)).toEqual({ appleId: 'a:b@icloud.com', appPassword: 'x:y:z' });
  });

  it('builds a correct HTTP Basic header from the packed credential', () => {
    const header = appleBasicAuth(packAppleCredential('jane@icloud.com', 'pw'));
    expect(header).toBe(`Basic ${Buffer.from('jane@icloud.com:pw').toString('base64')}`);
  });

  it('rejects a malformed credential', () => {
    expect(() => unpackAppleCredential('no-separator')).toThrow();
  });
});

describe('apple path + xml helpers', () => {
  it('normalizes absolute-URL and absolute-path hrefs to a path', () => {
    expect(hrefPath('https://p01-caldav.icloud.com/123/calendars/')).toBe('/123/calendars/');
    expect(hrefPath('/123/calendars/')).toBe('/123/calendars/');
  });

  it('extracts a stable uid from a resource href', () => {
    expect(uidFromHref('/123/calendars/work/abc-def.ics')).toBe('abc-def');
    expect(uidFromHref('https://x.icloud.com/123/calendars/work/UID123.ics')).toBe('UID123');
  });

  it('unescapes the XML entities CalDAV wraps calendar-data in', () => {
    expect(xmlUnescape('a &amp; b &lt;x&gt; &#13;&#10;')).toBe('a & b <x> \r\n');
  });

  it('extractLocal / hasLocal / responseBlocks ignore namespace prefixes', () => {
    const xml = '<D:multistatus><D:response><D:href>/a</D:href></D:response><D:response><href>/b</href></D:response></D:multistatus>';
    expect(responseBlocks(xml)).toHaveLength(2);
    expect(extractLocal('<C:displayname>Work</C:displayname>', 'displayname')).toBe('Work');
    expect(hasLocal('<collection/><C:calendar/>', 'calendar')).toBe(true);
    expect(hasLocal('<collection/>', 'calendar')).toBe(false);
  });
});

const PRINCIPAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:">
  <response><href>/</href>
    <propstat><prop><current-user-principal><href>/123456/principal/</href></current-user-principal></prop>
    <status>HTTP/1.1 200 OK</status></propstat>
  </response>
</multistatus>`;

const HOME_XML = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <response><href>/123456/principal/</href>
    <propstat><prop><C:calendar-home-set><href>https://p01-caldav.icloud.com/123456/calendars/</href></C:calendar-home-set></prop>
    <status>HTTP/1.1 200 OK</status></propstat>
  </response>
</multistatus>`;

const CALENDARS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:IC="http://apple.com/ns/ical/">
  <response><href>/123456/calendars/</href>
    <propstat><prop><resourcetype><collection/></resourcetype><displayname>Home</displayname></prop></propstat>
  </response>
  <response><href>/123456/calendars/work/</href>
    <propstat><prop>
      <resourcetype><collection/><C:calendar/></resourcetype>
      <displayname>Work</displayname>
      <IC:calendar-color>#FF0000</IC:calendar-color>
      <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
    </prop></propstat>
  </response>
  <response><href>/123456/calendars/calendar/</href>
    <propstat><prop>
      <resourcetype><collection/><C:calendar/></resourcetype>
      <displayname>Calendar</displayname>
      <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
    </prop></propstat>
  </response>
  <response><href>/123456/calendars/tasks/</href>
    <propstat><prop>
      <resourcetype><collection/><C:calendar/></resourcetype>
      <displayname>Reminders</displayname>
      <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
    </prop></propstat>
  </response>
</multistatus>`;

describe('apple CalDAV discovery parsers', () => {
  it('parses the current-user-principal href', () => {
    expect(parsePrincipalHref(PRINCIPAL_XML)).toBe('/123456/principal/');
    expect(parsePrincipalHref('<multistatus xmlns="DAV:"></multistatus>')).toBeNull();
  });

  it('parses the calendar-home-set href, normalizing an absolute URL', () => {
    expect(parseCalendarHomeHref(HOME_XML)).toBe('/123456/calendars/');
  });

  it('keeps only VEVENT calendar collections and elects one primary', () => {
    const cals = parseCalendarCollections(CALENDARS_XML);
    // Home (no <calendar/>) and Reminders (VTODO only) are dropped.
    expect(cals.map((c) => c.name).sort()).toEqual(['Calendar', 'Work']);
    const primaries = cals.filter((c) => c.primary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].name).toBe('Calendar');
    const work = cals.find((c) => c.name === 'Work')!;
    expect(work.externalId).toBe('/123456/calendars/work/');
    expect(work.color).toBe('#FF0000');
  });
});

const SYNC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <response><href>/123456/calendars/work/abc.ics</href>
    <propstat><prop><getetag>"etag-1"</getetag>
    <C:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:abc@icloud
SUMMARY:Team Sync
DTSTART:20260715T150000Z
DTEND:20260715T153000Z
LOCATION:Zoom
DESCRIPTION:Weekly
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR</C:calendar-data></prop>
    <status>HTTP/1.1 200 OK</status></propstat>
  </response>
  <response><href>/123456/calendars/work/gone.ics</href>
    <status>HTTP/1.1 404 Not Found</status>
  </response>
  <sync-token>HwoQEgwAAAABBBB</sync-token>
</multistatus>`;

describe('apple sync-collection parsing', () => {
  it('extracts items, a deletion, and the next sync-token', () => {
    const parsed = parseSyncResponse(SYNC_XML);
    expect(parsed.invalidToken).toBe(false);
    expect(parsed.syncToken).toBe('HwoQEgwAAAABBBB');
    expect(parsed.items).toHaveLength(2);
    const live = parsed.items.find((i) => !i.deleted)!;
    expect(live.href).toBe('/123456/calendars/work/abc.ics');
    expect(live.etag).toBe('etag-1');
    expect(live.calendarData).toContain('SUMMARY:Team Sync');
    const dead = parsed.items.find((i) => i.deleted)!;
    expect(dead.href).toBe('/123456/calendars/work/gone.ics');
  });

  it('flags an expired/invalid sync-token for a full resync', () => {
    const err = '<multistatus xmlns="DAV:"><error><valid-sync-token/></error></multistatus>';
    expect(parseSyncResponse(err).invalidToken).toBe(true);
  });
});

describe('apple event mappers', () => {
  it('maps a CalDAV VEVENT item to a normalized event', () => {
    const item: SyncItem = {
      href: '/123456/calendars/work/abc.ics', etag: 'etag-1', deleted: false,
      calendarData: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:abc@icloud\r\nSUMMARY:Team Sync\r\nDTSTART:20260715T150000Z\r\nDTEND:20260715T153000Z\r\nSTATUS:CONFIRMED\r\nEND:VEVENT\r\nEND:VCALENDAR',
    };
    const row = appleEventToRow(item)!;
    expect(row.external_id).toBe('/123456/calendars/work/abc.ics');
    expect(row.uid).toBe('abc@icloud');
    expect(row.title).toBe('Team Sync');
    expect(row.starts_at).toBe('2026-07-15T15:00:00.000Z');
    expect(row.ends_at).toBe('2026-07-15T15:30:00.000Z');
    expect(row.cancelled).toBe(false);
    expect(row.etag).toBe('etag-1');
  });

  it('maps a deletion tombstone to a cancelled event', () => {
    const row = appleEventToRow({ href: '/x/gone.ics', etag: null, deleted: true, calendarData: null })!;
    expect(row.cancelled).toBe(true);
    expect(row.status).toBe('cancelled');
    expect(row.external_id).toBe('/x/gone.ics');
  });

  it('round-trips a timed local row through buildEventIcs → parseICS', () => {
    const fields = rowToAppleEvent({
      title: 'Dentist', description: 'Cleaning', location: '123 Main St',
      starts_at: '2026-08-01T09:00:00.000Z', ends_at: '2026-08-01T09:30:00.000Z',
      all_day: false, recurrence_rule: 'FREQ=WEEKLY',
    });
    const ics = buildEventIcs(fields, 'uid-1', '2026-07-14T00:00:00.000Z');
    const parsed = parseICS(ics)[0];
    expect(parsed.uid).toBe('uid-1');
    expect(parsed.title).toBe('Dentist');
    expect(parsed.description).toBe('Cleaning');
    expect(parsed.location).toBe('123 Main St');
    expect(parsed.startsAt).toBe('2026-08-01T09:00:00.000Z');
    expect(parsed.endsAt).toBe('2026-08-01T09:30:00.000Z');
    expect(parsed.recurrenceRule).toBe('FREQ=WEEKLY');
    expect(parsed.allDay).toBe(false);
  });

  it('round-trips an all-day local row', () => {
    const fields = rowToAppleEvent({
      title: 'Holiday', starts_at: '2026-12-25T00:00:00.000Z', ends_at: '2026-12-26T00:00:00.000Z', all_day: true,
    });
    const parsed = parseICS(buildEventIcs(fields, 'uid-2'))[0];
    expect(parsed.allDay).toBe(true);
    expect(parsed.title).toBe('Holiday');
    expect(parsed.startsAt).toBe('2026-12-25T00:00:00.000Z');
  });
});

describe('apple sync-collection request body', () => {
  it('sends an empty token for the initial full sync', () => {
    const body = buildSyncCollectionReport(null);
    expect(body).toContain('<D:sync-token></D:sync-token>');
    expect(body).toContain('sync-level>1<');
    expect(body).toContain('calendar-data');
  });

  it('embeds and escapes a stored token on incremental sync', () => {
    const body = buildSyncCollectionReport('tok&<en>');
    expect(body).toContain('<D:sync-token>tok&amp;&lt;en&gt;</D:sync-token>');
  });
});
