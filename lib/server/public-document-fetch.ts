import 'server-only';
import { Resolver } from 'node:dns/promises';
import { request as httpsRequest, Agent, type RequestOptions } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { canonicalDocumentUrl } from '@/lib/capture/document-link';
import { documentType, MAX_DOCUMENT_BYTES, type DocumentInput } from '@/lib/ai/document-text';

export const PUBLIC_DOCUMENT_TIMEOUT_MS = 15_000;
type Address = { address: string; family: 4 | 6 };
type FetchReason = 'invalid_url' | 'blocked' | 'unsupported' | 'too_large' | 'unavailable';
export class PublicDocumentError extends Error {
  constructor(readonly reason: FetchReason, readonly retryable = false) { super(reason); }
}
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
blocked.addAddress('168.63.129.16', 'ipv4'); // Azure platform endpoint despite its public-looking address.
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blocked.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
export function isPublicDocumentAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  // Only ordinary global unicast; this excludes mapped IPv4, NAT64, local and multicast forms.
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

/**
 * Every address a host resolves to, with the unroutable ones rejected.
 *
 * Exported so the media proxy pins addresses exactly the way document fetching
 * does. Two copies of an SSRF guard is two guards that drift, and the one that
 * drifts is always the copy.
 */
export async function resolvePublicAddresses(host: string, signal: AbortSignal): Promise<Address[]> {
  const resolver = new Resolver({ timeout: 3_000, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.throwIfAborted();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const answers = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    signal.throwIfAborted();
    const addresses: Address[] = [];
    answers.forEach((answer, i) => {
      if (answer.status === 'fulfilled') addresses.push(...answer.value.map((address) => ({ address, family: (i === 0 ? 4 : 6) as 4 | 6 })));
      else if (!['ENODATA', 'ENOTFOUND'].includes(answer.reason?.code)) throw new PublicDocumentError('unavailable', true);
    });
    if (!addresses.length) throw new PublicDocumentError('unavailable', true);
    return addresses;
  } finally { signal.removeEventListener('abort', cancel); }
}

/**
 * What fetchPublicDocument will accept. Named and exported so a test can pin
 * it: this list is a security boundary, and widening it by accident is the way
 * a document fetcher quietly becomes a general-purpose proxy.
 */
export const DOCUMENT_MEDIA_TYPES = [
  'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain',
] as const;

/** What a feed fetch accepts instead. Text only — nothing here is executed. */
export const FEED_MEDIA_TYPES = [
  'application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml', 'text/plain',
] as const;

type Options = {
  signal?: AbortSignal; resolve?: typeof resolvePublicAddresses; request?: typeof httpsRequest; timeoutMs?: number;
  /** Media types this call will take. Defaults to DOCUMENT_MEDIA_TYPES. */
  accept?: readonly string[];
  /**
   * How the BYTES are checked once they arrive, independent of which media
   * types were accepted. Defaults to 'document'.
   *
   * Explicit, because the first version of this inferred it as
   * `accept !== DOCUMENT_MEDIA_TYPES` — by reference identity. A caller passing
   * a COPY of the document list (`[...DOCUMENT_MEDIA_TYPES]`, a `.slice()`, or
   * the same strings inline) would have been treated as a feed, skipping
   * documentType()'s magic-byte rejection of executables and archives AND the
   * looksLikeHtml() check — leaving verification as "starts with '<'", which an
   * HTML page passes. Nothing did that yet; a guard should not depend on nobody
   * ever doing it.
   */
  verify?: 'document' | 'feed';
};
type Hop = { redirect: string } | { document: DocumentInput };

function looksLikeHtml(bytes: Uint8Array): boolean {
  let text = new TextDecoder().decode(bytes).trimStart();
  while (text.startsWith('<!--')) {
    const end = text.indexOf('-->');
    if (end < 0) return true;
    text = text.slice(end + 3).trimStart();
  }
  return /^(?:<!doctype\s+html|<(?:html|head|body|script|form)\b)/i.test(text);
}

function readHop(url: URL, pinned: Address, signal: AbortSignal, request: typeof httpsRequest, accept: readonly string[], verify: 'document' | 'feed'): Promise<Hop> {
  return new Promise((resolve, reject) => {
    // Per-request agent: no pooled connection or environment proxy may bypass this lookup.
    // Node HTTPS forwards lookup to net.connect and retains the URL hostname for Host/TLS.
    // https://nodejs.org/api/https.html#httpsrequestoptions-callback
    const lookup: LookupFunction = (_host, options, callback) => {
      if (typeof options === 'object' && options.all) callback(null, [pinned]);
      else callback(null, pinned.address, pinned.family);
    };
    const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 });
    const requestOptions: RequestOptions & { autoSelectFamily: boolean } = { agent, lookup, family: pinned.family, autoSelectFamily: false,
      servername: url.hostname, rejectUnauthorized: true, signal, maxHeaderSize: 16 * 1024,
      method: 'GET', headers: { Accept: 'application/pdf,image/png,image/jpeg,image/gif,image/webp,text/plain', 'Accept-Encoding': 'identity', 'User-Agent': 'Bubaly-Document-Import/1.0' },
    };
    const req = request(url, requestOptions, (response) => {
      const fail = (error: Error) => { reject(error); response.destroy(); agent.destroy(); };
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        if (!response.headers.location) return fail(new PublicDocumentError('unsupported'));
        resolve({ redirect: response.headers.location }); response.destroy(); agent.destroy(); return;
      }
      if (status !== 200) return fail(new PublicDocumentError(status === 429 || status >= 500 ? 'unavailable' : 'unsupported', status === 429 || status >= 500));
      const contentType = response.headers['content-type']?.toLowerCase() ?? '';
      const mediaType = contentType.split(';')[0].trim();
      const charsets = contentType.split(';').slice(1).map((part) => part.trim()).filter((part) => /^charset\b/.test(part));
      if (!accept.includes(mediaType)
        || (mediaType === 'text/plain' && charsets.some((part) => !/^charset\s*=\s*(?:"(?:utf-8|us-ascii)"|utf-8|us-ascii)$/.test(part)))
        || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) return fail(new PublicDocumentError('unsupported'));
      const declared = response.headers['content-length'];
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_DOCUMENT_BYTES)) return fail(new PublicDocumentError('too_large'));
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_DOCUMENT_BYTES) fail(new PublicDocumentError('too_large'));
        else chunks.push(chunk);
      });
      response.once('error', (error) => { reject(error); agent.destroy(); });
      response.once('end', () => {
        agent.destroy();
        if (!response.complete) { reject(new PublicDocumentError('unavailable', true)); return; }
        let name = 'document';
        try { name = decodeURIComponent(url.pathname.split('/').pop() || name).slice(0, 255); } catch { /* A filename is metadata, never a destination. */ }
        const document = { name, mediaType, bytes: new Uint8Array(Buffer.concat(chunks)) };
        // MIME and bytes must agree. HTML disguised as text/plain is still a web
        // page. A feed is markup by definition, so it is sniffed for a leading
        // '<' instead of run through documentType, which only knows documents —
        // the check is not skipped for feeds, it is the right check for them.
        const wellFormed = verify === 'feed'
          ? new TextDecoder().decode(document.bytes.subarray(0, 512)).trimStart().startsWith('<')
          : Boolean(documentType(document)) && !(mediaType === 'text/plain' && looksLikeHtml(document.bytes));
        if (!wellFormed) reject(new PublicDocumentError('unsupported'));
        else resolve({ document });
      });
    });
    req.once('error', (error) => { reject('code' in error && error.code === 'HPE_HEADER_OVERFLOW' ? new PublicDocumentError('unsupported') : error); agent.destroy(); });
    req.end();
  });
}

/** One explicit document, with a shared DNS/connect/redirect/body deadline. No embedded resources. */
export async function fetchPublicDocument(raw: string, options: Options = {}): Promise<DocumentInput & { url: string }> {
  const ownDeadline = AbortSignal.timeout(options.timeoutMs ?? PUBLIC_DOCUMENT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, ownDeadline]) : ownDeadline;
  try {
    let current = raw;
    const seen = new Set<string>();
    for (let hop = 0; hop <= 3; hop++) {
      signal.throwIfAborted();
      const normalized = canonicalDocumentUrl(current);
      if (!normalized) throw new PublicDocumentError('invalid_url');
      const url = new URL(normalized);
      if (isIP(url.hostname.replace(/^\[|\]$/g, '')) || seen.has(normalized)) throw new PublicDocumentError('blocked');
      seen.add(normalized);
      const addresses = await (options.resolve ?? resolvePublicAddresses)(url.hostname, signal);
      signal.throwIfAborted();
      if (!addresses.length || addresses.some(({ address, family }) => isIP(address) !== family || !isPublicDocumentAddress(address))) throw new PublicDocumentError('blocked');
      const result = await readHop(url, addresses[0], signal, options.request ?? httpsRequest, options.accept ?? DOCUMENT_MEDIA_TYPES, options.verify ?? 'document');
      if ('document' in result) return { ...result.document, url: normalized };
      current = new URL(result.redirect, url).href;
    }
    throw new PublicDocumentError('blocked');
  } catch (error) {
    if (error instanceof PublicDocumentError) throw error;
    throw new PublicDocumentError('unavailable', true);
  }
}

/**
 * A podcast or book feed, fetched through the same guard a document gets.
 *
 * Subscribing to a feed means a URL a USER chose is fetched by our server,
 * which is the textbook server-side request forgery setup: without this, a feed
 * URL of http://169.254.169.254/ asks the cloud provider's metadata service for
 * credentials on the attacker's behalf. Everything that makes fetchPublicDocument
 * safe applies unchanged — the blocked-subnet list, DNS resolution pinned to the
 * address actually connected to, https only, a redirect budget, a size cap and
 * one deadline across the lot. The only difference is which media types come
 * back, and that a feed is verified as markup rather than as a document.
 */
export async function fetchPublicFeed(raw: string, options: Omit<Options, 'accept' | 'verify'> = {}): Promise<{ url: string; text: string }> {
  const result = await fetchPublicDocument(raw, { ...options, accept: FEED_MEDIA_TYPES, verify: 'feed' });
  return { url: result.url, text: new TextDecoder().decode(result.bytes) };
}
