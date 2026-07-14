// lib/sync/providers/apple.ts — Apple iCloud (CalDAV) adapter (R9, third provider).
//
// Closes the R9 note "once its adapter drops in, Apple/CalDAV sync flips on." Apple
// is architecturally UNLIKE Google/Microsoft: iCloud exposes no OAuth calendar REST
// API — calendar access is CalDAV (RFC 4791) over HTTP Basic auth with an Apple ID +
// an app-specific password. This adapter bends the OAuth-shaped SyncProviderAdapter
// contract onto CalDAV WITHOUT changing the generic engine:
//   • the app-specific-password credential (appleId + password) is packed into the
//     opaque "token" the engine stores encrypted and passes back to every method;
//   • authUrl points at an in-app credential-entry page (there is no consent redirect);
//   • exchangeCode VALIDATES the entered credential via a CalDAV principal PROPFIND;
//   • refreshAccessToken is a no-op (Basic-auth credentials do not expire) — the
//     engine's token-refresh path simply re-hands the same credential.
// Calendar sync uses CalDAV `sync-collection` (its sync-token is the engine's cursor).
// Reminders (VTODO) are a follow-up: defaultTaskListId() returns null, which the
// generic engine treats as "no task sync" — so this ships calendar-only and honest.
//
// Key-gated: isConfigured() is false until APPLE_SYNC_ENABLED=true (owner decision,
// B3 — the credential-entry surface is opt-in), so no network call fires until then.
// The PURE pieces below (ICS event mappers built on lib/sync/ics.ts, the CalDAV
// request builders, and the multistatus/sync-token/href/etag parsers) are
// provider-neutral and fully unit-tested (tests/sync-apple.test.ts), verified offline.
//
// SERVER ONLY.

import { randomUUID } from 'node:crypto';
import type {
  SyncProviderAdapter, OAuthTokens, NormalizedCalendar, NormalizedEvent, NormalizedTask,
  EventPullResult, LocalEventRow, LocalReminderRow,
} from '@/lib/sync/adapter';
import { SyncApiError } from '@/lib/sync/adapter';
import { eventContentHash, reminderContentHash } from '@/lib/sync/hash';
import { buildVevent, parseICS, toIcsUtc } from '@/lib/sync/ics';
import { readBoundedResponseText } from '@/lib/server/bounded-response-body';
import { fetchExternal } from '@/lib/server/external-fetch';

const ICLOUD_CALDAV = process.env.APPLE_CALDAV_BASE_URL || 'https://caldav.icloud.com';
const PRODID = '-//bubaly.com//Sync Platform//EN';
// A far-future expiry: Basic-auth credentials do not expire, so the engine never
// tries to "refresh" them (getValidAccessToken only refreshes within 2 min of expiry).
const NON_EXPIRING_MS = 10 * 365 * 24 * 60 * 60 * 1000;
// A single unit-separator byte keeps the two credential halves unambiguous even if
// the Apple ID or password contains ':' (which the base64 Basic header would split on).
const CRED_SEP = '\x1f';

export function isAppleSyncConfigured(): boolean {
  return process.env.APPLE_SYNC_ENABLED === 'true';
}

// ── credential packing ──────────────────────────────────────────────────────
// The engine stores ONE opaque token string per account (encrypted). For CalDAV we
// pack the Apple ID + app-specific password into it and unpack on every request.

/** Pack an Apple ID + app-specific password into the opaque engine token. */
export function packAppleCredential(appleId: string, appPassword: string): string {
  return `${appleId.trim()}${CRED_SEP}${appPassword.trim()}`;
}

/** Unpack the opaque engine token back into { appleId, appPassword }. */
export function unpackAppleCredential(packed: string): { appleId: string; appPassword: string } {
  const i = packed.indexOf(CRED_SEP);
  if (i === -1) throw new SyncApiError(400, 'Malformed Apple credential');
  return { appleId: packed.slice(0, i), appPassword: packed.slice(i + 1) };
}

/** HTTP Basic auth header value for a packed credential. */
export function appleBasicAuth(packed: string): string {
  const { appleId, appPassword } = unpackAppleCredential(packed);
  return `Basic ${Buffer.from(`${appleId}:${appPassword}`).toString('base64')}`;
}

// ── path helpers ────────────────────────────────────────────────────────────
/** Normalize an href (absolute URL or absolute path) to a leading-slash path. */
export function hrefPath(href: string): string {
  const h = href.trim();
  if (/^https?:\/\//i.test(h)) { try { return new URL(h).pathname; } catch { return h; } }
  return h;
}

/** The stable UID we encode into a resource filename `{uid}.ics`. */
export function uidFromHref(href: string): string {
  const path = hrefPath(href);
  const last = path.split('/').filter(Boolean).pop() ?? '';
  return last.replace(/\.ics$/i, '') || last;
}

// ── XML (pure, dependency-free — WebDAV multistatus is regular enough) ────────
/** Unescape the XML entities CalDAV servers use inside calendar-data / text nodes. */
export function xmlUnescape(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** First inner text of `<[ns:]local ...>…</[ns:]local>`, namespace-prefix-agnostic. */
export function extractLocal(xml: string, local: string): string | null {
  const re = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${local}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${local}>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}

/** True when `<[ns:]local .../>` or `<[ns:]local>…</…>` appears at all. */
export function hasLocal(xml: string, local: string): boolean {
  return new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${local}\\b`, 'i').test(xml);
}

/** Split a multistatus document into its individual <response> blocks. */
export function responseBlocks(xml: string): string[] {
  const re = /<(?:[A-Za-z0-9_.-]+:)?response\b[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?response>/gi;
  return xml.match(re) ?? [];
}

/** current-user-principal href from a PROPFIND response. */
export function parsePrincipalHref(xml: string): string | null {
  const block = extractLocal(xml, 'current-user-principal');
  if (!block) return null;
  const href = extractLocal(block, 'href');
  return href ? hrefPath(href) : null;
}

/** calendar-home-set href from a PROPFIND response. */
export function parseCalendarHomeHref(xml: string): string | null {
  const block = extractLocal(xml, 'calendar-home-set');
  if (!block) return null;
  const href = extractLocal(block, 'href');
  return href ? hrefPath(href) : null;
}

/** Calendar collections from a Depth:1 PROPFIND on the calendar-home. */
export function parseCalendarCollections(xml: string): NormalizedCalendar[] {
  const out: NormalizedCalendar[] = [];
  for (const block of responseBlocks(xml)) {
    const resourcetype = extractLocal(block, 'resourcetype') ?? '';
    // A real calendar collection carries <C:calendar/> in its resourcetype.
    if (!hasLocal(resourcetype, 'calendar')) continue;
    const hrefRaw = extractLocal(block, 'href');
    if (!hrefRaw) continue;
    const externalId = hrefPath(hrefRaw);
    // Skip the home container itself and any non-VEVENT collections we can detect.
    const comps = extractLocal(block, 'supported-calendar-component-set');
    if (comps && !/VEVENT/i.test(comps)) continue;
    const name = xmlUnescape((extractLocal(block, 'displayname') ?? '').trim()) || 'iCloud Calendar';
    const color = (extractLocal(block, 'calendar-color') ?? '').trim() || null;
    out.push({ externalId, name, primary: /(^|\/)calendar\/?$/i.test(externalId) || /^calendar$/i.test(name), timezone: null, color });
  }
  // Guarantee exactly one primary: first if none matched.
  if (out.length && !out.some((c) => c.primary)) out[0].primary = true;
  return out;
}

export type SyncItem = { href: string; etag: string | null; calendarData: string | null; deleted: boolean };
export type ParsedSync = { items: SyncItem[]; syncToken: string | null; invalidToken: boolean };

/** Parse a `sync-collection` REPORT response into items + the next sync-token. */
export function parseSyncResponse(xml: string): ParsedSync {
  // iCloud signals an expired/rejected token with a DAV:valid-sync-token error.
  if (hasLocal(xml, 'valid-sync-token')) return { items: [], syncToken: null, invalidToken: true };
  const syncTokenRaw = extractLocal(xml, 'sync-token');
  const syncToken = syncTokenRaw ? xmlUnescape(syncTokenRaw.trim()) : null;
  const items: SyncItem[] = [];
  for (const block of responseBlocks(xml)) {
    const hrefRaw = extractLocal(block, 'href');
    if (!hrefRaw) continue;
    const href = hrefPath(hrefRaw);
    const status = extractLocal(block, 'status') ?? '';
    const deleted = /\b404\b/.test(status);
    const etagRaw = extractLocal(block, 'getetag');
    const etag = etagRaw ? xmlUnescape(etagRaw.trim()).replace(/^"|"$/g, '') : null;
    const dataRaw = extractLocal(block, 'calendar-data');
    const calendarData = dataRaw ? xmlUnescape(dataRaw) : null;
    // Ignore the collection's own href (no calendar-data, not a deletion).
    if (!deleted && !calendarData) continue;
    items.push({ href, etag, calendarData, deleted });
  }
  return { items, syncToken, invalidToken: false };
}

// ── ICS mappers (pure; built on the tested lib/sync/ics.ts) ───────────────────
/** A parsed CalDAV item (VEVENT + href + etag) → the engine's NormalizedEvent. */
export function appleEventToRow(item: SyncItem): NormalizedEvent | null {
  if (item.deleted) {
    return {
      external_id: item.href, uid: null, title: '', description: null, location: null,
      starts_at: new Date(0).toISOString(), ends_at: null, all_day: false,
      recurrence_rule: null, status: 'cancelled', etag: item.etag, cancelled: true,
    };
  }
  if (!item.calendarData) return null;
  const events = parseICS(item.calendarData);
  const ev = events[0];
  if (!ev) return null;
  return {
    external_id: item.href,
    uid: ev.uid,
    title: ev.title,
    description: ev.description ?? null,
    location: ev.location ?? null,
    starts_at: ev.startsAt,
    ends_at: ev.endsAt ?? null,
    all_day: ev.allDay ?? false,
    recurrence_rule: ev.recurrenceRule ?? null,
    status: ev.status ?? 'confirmed',
    etag: item.etag,
    updated_at: ev.updatedAt ?? null,
    cancelled: ev.status === 'cancelled',
  };
}

/** A local event row → the normalized fields insert/patch turn into an ICS body. */
export function rowToAppleEvent(row: LocalEventRow): Record<string, unknown> {
  return {
    title: row.title,
    description: row.description ?? null,
    location: row.location ?? null,
    starts_at: row.starts_at,
    ends_at: row.ends_at ?? null,
    all_day: row.all_day === true,
    recurrence_rule: row.recurrence_rule ?? null,
  };
}

/** Build a single-VEVENT VCALENDAR document for a PUT, keyed by a stable uid. */
export function buildEventIcs(fields: Record<string, unknown>, uid: string, dtstamp?: string): string {
  const stamp = dtstamp ?? new Date().toISOString();
  const vevent = buildVevent({
    uid,
    title: String(fields.title ?? ''),
    description: (fields.description as string | null) ?? null,
    location: (fields.location as string | null) ?? null,
    startsAt: String(fields.starts_at),
    endsAt: (fields.ends_at as string | null) ?? null,
    allDay: fields.all_day === true,
    recurrenceRule: (fields.recurrence_rule as string | null) ?? null,
    updatedAt: stamp,
    status: 'confirmed',
  }, stamp);
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'CALSCALE:GREGORIAN', ...vevent, 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

// ── CalDAV request builders (pure) ────────────────────────────────────────────
export const PROPFIND_PRINCIPAL =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>';

export const PROPFIND_CALENDAR_HOME =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
  '<D:prop><C:calendar-home-set/></D:prop></D:propfind>';

export const PROPFIND_CALENDARS =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:IC="http://apple.com/ns/ical/">' +
  '<D:prop><D:resourcetype/><D:displayname/><IC:calendar-color/>' +
  '<C:supported-calendar-component-set/></D:prop></D:propfind>';

/** A sync-collection REPORT body; an empty token requests the initial full set. */
export function buildSyncCollectionReport(syncToken: string | null): string {
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<D:sync-collection xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
    `<D:sync-token>${syncToken ? escapeXml(syncToken) : ''}</D:sync-token>` +
    '<D:sync-level>1</D:sync-level>' +
    '<D:prop><D:getetag/><C:calendar-data/></D:prop></D:sync-collection>';
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── network ───────────────────────────────────────────────────────────────────
type DavResult = { status: number; text: string; etag: string | null };

async function dav(packed: string, method: string, path: string, body?: string, extraHeaders?: Record<string, string>): Promise<DavResult> {
  const url = path.startsWith('http') ? path : `${ICLOUD_CALDAV}${path}`;
  const res = await fetchExternal(url, {
    method,
    headers: {
      Authorization: appleBasicAuth(packed),
      ...(body ? { 'Content-Type': method === 'PUT' ? 'text/calendar; charset=utf-8' : 'application/xml; charset=utf-8' } : {}),
      ...(extraHeaders ?? {}),
    },
    ...(body ? { body } : {}),
  }, 20_000);
  const bounded = await readBoundedResponseText(res, 4 * 1024 * 1024);
  if (!bounded.ok) throw new SyncApiError(res.status, `iCloud CalDAV ${res.status} response too large`, '[provider response exceeded 4 MiB]');
  return { status: res.status, text: bounded.text, etag: res.headers.get('etag') };
}

/** current-user-principal → calendar-home-set discovery (two PROPFINDs). */
async function discoverCalendarHome(packed: string): Promise<string> {
  const principalRes = await dav(packed, 'PROPFIND', '/', PROPFIND_PRINCIPAL, { Depth: '0' });
  if (principalRes.status === 401 || principalRes.status === 403) {
    throw new SyncApiError(principalRes.status, 'iCloud rejected the Apple ID / app-specific password');
  }
  if (principalRes.status >= 400) throw new SyncApiError(principalRes.status, `iCloud principal PROPFIND ${principalRes.status}`);
  const principal = parsePrincipalHref(principalRes.text);
  if (!principal) throw new SyncApiError(principalRes.status, 'iCloud returned no current-user-principal');

  const homeRes = await dav(packed, 'PROPFIND', principal, PROPFIND_CALENDAR_HOME, { Depth: '0' });
  if (homeRes.status >= 400) throw new SyncApiError(homeRes.status, `iCloud calendar-home PROPFIND ${homeRes.status}`);
  const home = parseCalendarHomeHref(homeRes.text);
  if (!home) throw new SyncApiError(homeRes.status, 'iCloud returned no calendar-home-set');
  return home;
}

// ── adapter methods ────────────────────────────────────────────────────────────
function authUrl(redirectUri: string, state: string): string {
  // No OAuth consent screen — route the user to the in-app credential-entry page
  // (dark until APPLE_SYNC_ENABLED). The connect page collects Apple ID + an
  // app-specific password and posts it to the callback, which calls exchangeCode.
  let origin = '';
  try { origin = new URL(redirectUri).origin; } catch { origin = ''; }
  return `${origin}/dashboard/sync/accounts/apple/connect?state=${encodeURIComponent(state)}`;
}

/** `code` is the packed Apple credential; validate it with a principal PROPFIND. */
async function exchangeCode(code: string, _redirectUri: string): Promise<OAuthTokens> {
  await discoverCalendarHome(code); // throws on bad credentials
  return { accessToken: code, refreshToken: code, expiresAt: Date.now() + NON_EXPIRING_MS, tokenType: 'Basic' };
}

async function refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
  // CalDAV Basic-auth credentials do not expire — re-hand the same one.
  return { accessToken: refreshToken, refreshToken, expiresAt: Date.now() + NON_EXPIRING_MS, tokenType: 'Basic' };
}

async function revokeToken(): Promise<void> {
  // Nothing to revoke server-side; disconnect drops the stored credential. The user
  // revokes access by deleting the app-specific password in appleid.apple.com.
}

async function getAccountIdentity(accessToken: string): Promise<string | null> {
  try { return unpackAppleCredential(accessToken).appleId || null; } catch { return null; }
}

async function listCalendars(accessToken: string): Promise<NormalizedCalendar[]> {
  const home = await discoverCalendarHome(accessToken);
  const res = await dav(accessToken, 'PROPFIND', home, PROPFIND_CALENDARS, { Depth: '1' });
  if (res.status >= 400) throw new SyncApiError(res.status, `iCloud calendars PROPFIND ${res.status}`);
  return parseCalendarCollections(res.text);
}

async function pullEvents(accessToken: string, calendarExternalId: string, cursor: string | null): Promise<EventPullResult> {
  const res = await dav(accessToken, 'REPORT', calendarExternalId, buildSyncCollectionReport(cursor), { Depth: '1' });
  // A rejected/expired sync-token → full resync (engine retries with cursor=null).
  if (res.status === 409 || res.status === 410 || res.status === 412) return { events: [], nextCursor: null, expired: true };
  if (res.status >= 400) throw new SyncApiError(res.status, `iCloud sync REPORT ${res.status}`, res.text.slice(0, 400));
  const parsed = parseSyncResponse(res.text);
  if (parsed.invalidToken) return { events: [], nextCursor: null, expired: true };
  const events: NormalizedEvent[] = [];
  for (const item of parsed.items) {
    const row = appleEventToRow(item);
    if (row) events.push(row);
  }
  return { events, nextCursor: parsed.syncToken, expired: false };
}

async function insertEvent(accessToken: string, calendarExternalId: string, body: Record<string, unknown>) {
  const uid = randomUUID();
  const href = `${calendarExternalId.replace(/\/?$/, '/')}${uid}.ics`;
  const res = await dav(accessToken, 'PUT', href, buildEventIcs(body, uid), { 'If-None-Match': '*' });
  if (res.status >= 400) throw new SyncApiError(res.status, `iCloud PUT (insert) ${res.status}`, res.text.slice(0, 400));
  return { id: href, etag: res.etag };
}

async function patchEvent(accessToken: string, _calendarExternalId: string, eventExternalId: string, body: Record<string, unknown>) {
  const uid = uidFromHref(eventExternalId);
  const res = await dav(accessToken, 'PUT', eventExternalId, buildEventIcs(body, uid));
  if (res.status >= 400) throw new SyncApiError(res.status, `iCloud PUT (update) ${res.status}`, res.text.slice(0, 400));
  return { id: eventExternalId, etag: res.etag };
}

async function deleteEvent(accessToken: string, _calendarExternalId: string, eventExternalId: string): Promise<void> {
  const res = await dav(accessToken, 'DELETE', eventExternalId);
  // 404/410 = already gone; treat as success (idempotent delete).
  if (res.status >= 400 && res.status !== 404 && res.status !== 410) {
    throw new SyncApiError(res.status, `iCloud DELETE ${res.status}`, res.text.slice(0, 400));
  }
}

// ── tasks (VTODO): follow-up. Null default list disables task sync in the engine. ──
async function defaultTaskListId(): Promise<string | null> { return null; }
async function listTasks(): Promise<NormalizedTask[]> { return []; }
async function insertTask(): Promise<{ id: string }> { throw new SyncApiError(501, 'iCloud reminders (VTODO) sync not yet implemented'); }
async function patchTask(): Promise<void> { throw new SyncApiError(501, 'iCloud reminders (VTODO) sync not yet implemented'); }
async function deleteTask(): Promise<void> { throw new SyncApiError(501, 'iCloud reminders (VTODO) sync not yet implemented'); }

/** Reminder-row → ICS body placeholder (kept for contract completeness; unused
 *  until VTODO sync lands, since defaultTaskListId() returns null). */
export function rowToAppleTask(row: LocalReminderRow): Record<string, unknown> {
  return { title: row.title, notes: row.notes ?? null, due_at: row.due_at ?? null, is_completed: row.is_completed === true };
}

export const appleAdapter: SyncProviderAdapter = {
  provider: 'apple',
  label: 'Apple iCloud',
  isConfigured: isAppleSyncConfigured,
  authUrl,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
  getAccountIdentity,
  listCalendars,
  pullEvents,
  insertEvent,
  patchEvent,
  deleteEvent,
  defaultTaskListId,
  listTasks,
  insertTask,
  patchTask,
  deleteTask,
  rowToEventBody: rowToAppleEvent,
  rowToTaskBody: rowToAppleTask,
  eventContentHash,
  reminderContentHash,
};

export { toIcsUtc };
