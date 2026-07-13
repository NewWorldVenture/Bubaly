import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { normalizeFeedUrl } from '@/lib/calendar/feeds';

export const MAX_CALENDAR_RESPONSE_BYTES = 1_048_576;

type LookupAddress = { address: string; family: number };
export type PublicUrlLookup = (hostname: string) => Promise<LookupAddress[]>;

const lookupAll: PublicUrlLookup = async (hostname) => lookup(hostname, { all: true, verbatim: true });

function ipv4Number(address: string): number | null {
  const octets = address.split('.');
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return octets.reduce((value, part) => (value * 256) + Number(part), 0);
}

function inRange(value: number, start: number, end: number): boolean {
  return value >= start && value <= end;
}

function blockedIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return true;
  return [
    [0x00000000, 0x00ffffff], // unspecified/current network
    [0x0a000000, 0x0affffff], // private
    [0x64400000, 0x647fffff], // carrier-grade NAT
    [0x7f000000, 0x7fffffff], // loopback
    [0xa9fe0000, 0xa9feffff], // link-local
    [0xac100000, 0xac1fffff], // private
    [0xc0000000, 0xc00000ff], // protocol assignments
    [0xc0000200, 0xc00002ff], // TEST-NET-1
    [0xc0a80000, 0xc0a8ffff], // private
    [0xc6120000, 0xc613ffff], // benchmark
    [0xc6336400, 0xc63364ff], // TEST-NET-2
    [0xcb007100, 0xcb0071ff], // TEST-NET-3
    [0xe0000000, 0xffffffff], // multicast/reserved
  ].some(([start, end]) => inRange(value, start, end));
}

function ipv4String(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join('.');
}

function ipv6Number(address: string): bigint | null {
  const clean = address.toLowerCase().split('%', 1)[0];
  const sections = clean.split('::');
  if (sections.length > 2) return null;

  const expand = (section: string): string[] => {
    if (!section) return [];
    const groups = section.split(':');
    const result: string[] = [];
    for (const group of groups) {
      if (group.includes('.')) {
        const v4 = ipv4Number(group);
        if (v4 === null) return [];
        result.push(((v4 >>> 16) & 0xffff).toString(16), (v4 & 0xffff).toString(16));
      } else result.push(group);
    }
    return result;
  };

  const left = expand(sections[0]);
  const right = sections.length === 2 ? expand(sections[1]) : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (sections.length === 1 && missing !== 0) || (sections.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function blockedIp(address: string): boolean {
  const clean = address.replace(/^\[|\]$/g, '');
  const family = isIP(clean);
  if (family === 4) return blockedIpv4(clean);
  if (family !== 6) return true;

  const value = ipv6Number(clean);
  if (value === null) return true;
  const top8 = value >> 120n;
  const top7 = value >> 121n;
  const top10 = value >> 118n;
  const top96 = value >> 32n;
  if (top96 === 0xffffn || top96 === 0n) return blockedIpv4(ipv4String(value & 0xffffffffn));
  return value === 0n || value === 1n || top7 === 126n || top10 === 1018n || top8 === 255n
    || (value >> 96n) === 0x20010db8n;
}

function blockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return !host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal') || host === 'metadata.google.internal';
}

/** Resolves and rejects non-public targets before a server-side calendar fetch. */
export async function validatePublicCalendarUrl(raw: string, lookupImpl: PublicUrlLookup = lookupAll): Promise<string | null> {
  const normalized = normalizeFeedUrl(raw);
  if (!normalized) return null;
  let url: URL;
  try { url = new URL(normalized); } catch { return null; }
  if (url.username || url.password || blockedHostname(url.hostname)) return null;

  const literal = url.hostname.replace(/^\[|\]$/g, '');
  try {
    const addresses = isIP(literal) ? [{ address: literal, family: isIP(literal) }] : await lookupImpl(literal);
    if (!addresses.length || addresses.some((entry) => blockedIp(entry.address))) return null;
  } catch {
    return null;
  }
  return normalized;
}

async function readBoundedText(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_CALENDAR_RESPONSE_BYTES) return null;
  if (!response.body) {
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') <= MAX_CALENDAR_RESPONSE_BYTES ? text : null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_CALENDAR_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export type CalendarFetchResult =
  | { ok: true; url: string; text: string }
  | { ok: false; error: string; status: 400 | 413 | 422 };

/** Validates a public URL, limits response memory, and returns calendar text. */
export async function fetchPublicCalendarText(
  raw: string,
  fetchImpl: typeof fetch = fetch,
  lookupImpl: PublicUrlLookup = lookupAll,
): Promise<CalendarFetchResult> {
  let url = await validatePublicCalendarUrl(raw, lookupImpl);
  if (!url) return { ok: false, error: 'Calendar URL must resolve to a public HTTP(S) host.', status: 400 };
  try {
    let response: Response | null = null;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      response = await fetchImpl(url, {
        redirect: 'manual',
        headers: { 'User-Agent': 'Bubaly-Calendar-Sync/1.0', Accept: 'text/calendar, text/plain, */*' },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      if (!location) return { ok: false, error: 'Calendar provider returned an invalid redirect.', status: 422 };
      const next = await validatePublicCalendarUrl(new URL(location, url).toString(), lookupImpl);
      if (!next) return { ok: false, error: 'Calendar redirect points to a private or unreachable host.', status: 400 };
      url = next;
      if (redirect === 3) return { ok: false, error: 'Too many calendar redirects.', status: 422 };
    }
    if (!response || !response.ok) return { ok: false, error: 'Calendar provider could not be reached.', status: 422 };
    const text = await readBoundedText(response);
    if (text === null) return { ok: false, error: 'Calendar response is too large.', status: 413 };
    return { ok: true, url, text };
  } catch {
    return { ok: false, error: 'Could not reach the calendar URL.', status: 422 };
  }
}
