import { EventEmitter } from 'node:events';
import dns from 'node:dns';
import { PassThrough } from 'node:stream';
import { request as nativeRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPublicDocument, fetchPublicFeed, isPublicDocumentAddress, DOCUMENT_MEDIA_TYPES,
} from '@/lib/server/public-document-fetch';
import { MAX_DOCUMENT_BYTES } from '@/lib/ai/document-text';
import { canonicalDocumentUrl, documentLinkCandidates } from '@/lib/capture/document-link';

const publicAddress = { address: '93.184.216.34', family: 4 as const };
const resolve = vi.fn(async () => [publicAddress]);
afterEach(() => vi.restoreAllMocks());
type ResponseSpec = { status?: number; headers?: Record<string, string | undefined>; body?: Buffer; incomplete?: boolean; hang?: boolean };
function server(responses: ResponseSpec[]) {
  const calls: { url: URL; options: RequestOptions }[] = [];
  const request = vi.fn((url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    calls.push({ url, options });
    const spec = responses.shift() ?? {};
    const req = new EventEmitter() as ClientRequest;
    req.end = (() => {
      queueMicrotask(() => {
        const response = Object.assign(new PassThrough(), { statusCode: spec.status ?? 200, headers: { 'content-type': 'text/plain; charset=utf-8', ...spec.headers }, complete: !spec.incomplete });
        const abort = () => response.destroy(new Error('AbortError'));
        options.signal?.addEventListener('abort', abort, { once: true });
        response.once('close', () => options.signal?.removeEventListener('abort', abort));
        callback(response as unknown as IncomingMessage);
        if (!spec.hang) response.end(spec.body ?? Buffer.from('School permission slip'));
      });
      return req;
    }) as ClientRequest['end'];
    return req;
  }) as unknown as typeof nativeRequest;
  return { request, calls };
}

describe('explicit public document transport', () => {
  it.each(['127.0.0.1', '10.1.1.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.1.1', '168.63.129.16', '192.88.99.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:93.184.216.34', '64:ff9b::7f00:1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::', '3fff::1'])('rejects private/reserved/translated address %s', (address) => {
    expect(isPublicDocumentAddress(address)).toBe(false);
  });
  it.each(['93.184.216.34', '2606:4700:4700::1111'])('allows ordinary global unicast %s', (address) => expect(isPublicDocumentAddress(address)).toBe(true));

  it('keeps signed query identity and bounded, escaped HTML candidates without visiting them', () => {
    expect(canonicalDocumentUrl('https://DOCS.school.org:443/form?b=2&a=1!#page=3')).toBe('https://docs.school.org/form?b=2&a=1!');
    expect(documentLinkCandidates('<a href="https://docs.school.org/form?a=1&amp;b=2">open</a> https://docs.school.org/form?a=1&b=2')).toEqual(['https://docs.school.org/form?a=1&b=2']);
    expect(documentLinkCandidates(Array.from({ length: 15 }, (_, n) => `https://docs.school.org/${n}`).join(' '))).toHaveLength(10);
  });
  it.each(['http://school.org/a', 'https://u:p@school.org/a', 'https://school.org:444/a', 'https://localhost/a', 'https://school.internal/a', 'https://school.org/a\nheader', 'file:///etc/passwd', 'https://127.1/a', 'https://[::1]/a'])('never connects to forbidden URL %s', async (url) => {
    const fake = server([]);
    await expect(fetchPublicDocument(url, { resolve, request: fake.request })).rejects.toMatchObject({ retryable: false });
    expect(fake.calls).toHaveLength(0);
  });

  it('passes the approved address into the actual native TLS lookup while keeping hostname verification', async () => {
    const reboundLookup = vi.spyOn(dns, 'lookup').mockImplementation(((_host: unknown, _options: unknown, callback: (error: null, address: string, family: number) => void) => callback(null, '127.0.0.1', 4)) as typeof dns.lookup);
    let nativeLookup: { host: string; address: string; family: number } | null = null;
    let observed: RequestOptions | null = null;
    const request = ((url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      observed = options;
      const pinnedLookup = options.lookup!;
      const lookup: LookupFunction = (host, lookupOptions, done) => {
        pinnedLookup(host, lookupOptions, (error, address, family) => {
          expect(error).toBeNull();
          nativeLookup = { host, address: address as string, family: family as number };
          // Stop before any external connection. The native TLS path must use this callback,
          // not resolve the hostname a second time after our validation.
          done(new Error('Test stopped before socket connection'), '', 4);
        });
      };
      return nativeRequest(url, { ...options, lookup }, callback);
    }) as typeof nativeRequest;
    await expect(fetchPublicDocument('https://docs.school.org/form', { resolve, request })).rejects.toMatchObject({ reason: 'unavailable' });
    expect(nativeLookup).toEqual({ host: 'docs.school.org', ...publicAddress });
    expect(reboundLookup).not.toHaveBeenCalled();
    expect(observed).toMatchObject({ servername: 'docs.school.org', rejectUnauthorized: true, family: 4, autoSelectFamily: false, method: 'GET', maxHeaderSize: 16_384 });
    expect((observed as unknown as RequestOptions).headers).toEqual({ Accept: 'application/pdf,image/png,image/jpeg,image/gif,image/webp,text/plain', 'Accept-Encoding': 'identity', 'User-Agent': 'Bubaly-Document-Import/1.0' });
  });

  it('revalidates and repins every redirect, never forwarding cookies or fetching embedded URLs', async () => {
    const fake = server([{ status: 302, headers: { location: 'https://files.school.org/form.txt', 'set-cookie': 'session=private' } }, { body: Buffer.from('Read https://internal.local/secret later') }]);
    const dns = vi.fn(async (host: string) => [{ address: host.startsWith('files') ? '1.1.1.1' : publicAddress.address, family: 4 as const }]);
    const result = await fetchPublicDocument('https://docs.school.org/a', { resolve: dns, request: fake.request });
    expect(result.url).toBe('https://files.school.org/form.txt');
    expect(dns.mock.calls.map((call) => call[0])).toEqual(['docs.school.org', 'files.school.org']);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].options.headers).not.toHaveProperty('Cookie');
    expect(fake.calls[1].options.headers).not.toHaveProperty('Authorization');
    expect(fake.calls[1].options.headers).not.toHaveProperty('Referer');
    expect(fake.calls[1].options.agent).not.toBe(fake.calls[0].options.agent);
  });

  it.each(['http://docs.school.org/a', 'https://127.0.0.1/a', 'https://docs.school.org/a'])('stops unsafe or looping redirect %s', async (location) => {
    const fake = server([{ status: 302, headers: { location } }]);
    await expect(fetchPublicDocument('https://docs.school.org/a', { resolve, request: fake.request })).rejects.toMatchObject({ retryable: false });
    expect(fake.calls).toHaveLength(1);
  });
  it('rejects mixed public/private DNS answers and private answers after redirect', async () => {
    const fake = server([{ status: 302, headers: { location: '/next' } }]);
    const dns = vi.fn().mockResolvedValueOnce([publicAddress]).mockResolvedValueOnce([publicAddress, { address: '127.0.0.1', family: 4 }]);
    await expect(fetchPublicDocument('https://docs.school.org/a', { resolve: dns, request: fake.request })).rejects.toMatchObject({ reason: 'blocked' });
    expect(fake.calls).toHaveLength(1);
  });
  it('permits no more than three redirects', async () => {
    const fake = server(Array.from({ length: 5 }, (_, n) => ({ status: 302, headers: { location: `/${n}` } })));
    await expect(fetchPublicDocument('https://docs.school.org/a', { resolve, request: fake.request })).rejects.toMatchObject({ reason: 'blocked' });
    expect(fake.calls).toHaveLength(4);
  });
  it.each([
    { headers: { 'content-type': 'text/html' } }, { headers: { 'content-type': 'text/plain; charset=iso-8859-1' } },
    { headers: { 'content-encoding': 'gzip' } }, { headers: { 'content-type': 'application/zip' } },
    { headers: { 'content-type': 'application/pdf' }, body: Buffer.from('PK archive') },
    { body: Buffer.from('<!doctype html><html>Sign in</html>') }, { body: Buffer.from(`<!--${'a'.repeat(1_000)}--><html>Sign in</html>`) }, { status: 401 }, { status: 403 },
  ])('truthfully rejects HTML/login/archive/type/encoding response %#', async (spec) => {
    await expect(fetchPublicDocument('https://docs.school.org/a', { resolve, request: server([spec]).request })).rejects.toMatchObject({ reason: 'unsupported', retryable: false });
  });
  it.each(['utf-8', '"utf-8"', 'us-ascii', '"us-ascii"'])('accepts supported plain text charset %s', async (charset) => {
    const result = await fetchPublicDocument('https://docs.school.org/a', { resolve, request: server([{ headers: { 'content-type': `text/plain; charset=${charset}` } }]).request });
    expect(result.mediaType).toBe('text/plain');
  });
  it.each([
    ['application/pdf', Buffer.from('%PDF-1.7\nDocument')],
    ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff])],
    ['image/gif', Buffer.from('GIF89a')],
    ['image/webp', Buffer.from('RIFF1234WEBP')],
  ])('keeps supported %s bytes intact for the shared extractor', async (mediaType, body) => {
    const result = await fetchPublicDocument('https://docs.school.org/document', { resolve, request: server([{ headers: { 'content-type': mediaType as string }, body: body as Buffer }]).request });
    expect(result.mediaType).toBe(mediaType);
    expect(Buffer.from(result.bytes)).toEqual(body);
  });
  it.each([{ headers: { 'content-length': String(MAX_DOCUMENT_BYTES + 1) } }, { body: Buffer.alloc(MAX_DOCUMENT_BYTES + 1) }])('bounds declared and streamed bytes %#', async (spec) => {
    await expect(fetchPublicDocument('https://docs.school.org/a', { resolve, request: server([spec]).request })).rejects.toMatchObject({ reason: 'too_large' });
  });
  it.each([429, 500, 503])('makes transient status %s retryable', async (status) => {
    await expect(fetchPublicDocument('https://docs.school.org/a', { resolve, request: server([{ status }]).request })).rejects.toMatchObject({ reason: 'unavailable', retryable: true });
  });
  it('fails on a truncated response rather than importing an apparent complete document', async () => {
    await expect(fetchPublicDocument('https://docs.school.org/a', { resolve, request: server([{ incomplete: true }]).request })).rejects.toMatchObject({ reason: 'unavailable', retryable: true });
  });
  it('bounds an unresolved DNS query and the streamed response by the same overall deadline', async () => {
    const dns = async (_host: string, signal: AbortSignal) => new Promise<typeof publicAddress[]>((_done, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    await expect(fetchPublicDocument('https://docs.school.org/a', { resolve: dns, timeoutMs: 15 })).rejects.toMatchObject({ retryable: true });
    await expect(fetchPublicDocument('https://docs.school.org/a', { resolve, request: server([{ hang: true }]).request, timeoutMs: 15 })).rejects.toMatchObject({ retryable: true });
  });
});

describe('the feed path cannot weaken the document path', () => {
  // lib/server/public-document-fetch.ts gained an `accept` list so podcast and
  // book feeds could reuse this guard instead of a second, weaker one. These
  // pin the boundary that change created.
  const html = Buffer.from('<!doctype html><html><body>not a document</body></html>');
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]); // PK.. — a zip
  const feed = Buffer.from('<?xml version="1.0"?><rss version="2.0"><channel><title>Show</title></channel></rss>');

  it('still rejects HTML wearing a text/plain content-type', async () => {
    await expect(fetchPublicDocument('https://docs.school.org/a', {
      resolve, request: server([{ headers: { 'content-type': 'text/plain; charset=utf-8' }, body: html }]).request,
    })).rejects.toMatchObject({ reason: 'unsupported' });
  });

  it('still rejects an archive whatever it claims to be', async () => {
    await expect(fetchPublicDocument('https://docs.school.org/a', {
      resolve, request: server([{ headers: { 'content-type': 'text/plain; charset=utf-8' }, body: zip }]).request,
    })).rejects.toMatchObject({ reason: 'unsupported' });
  });

  it('verifies as a DOCUMENT even when handed a copy of the document media types', async () => {
    // The hazard this replaced: the first version decided feed-vs-document with
    // `accept !== DOCUMENT_MEDIA_TYPES` — reference identity. A caller passing
    // a copy of the same list, which is the natural thing to write, would have
    // silently skipped documentType()'s magic-byte check AND the HTML sniff,
    // leaving verification as "starts with '<'". HTML starts with '<'.
    const copy = [...DOCUMENT_MEDIA_TYPES];
    expect(copy).toEqual([...DOCUMENT_MEDIA_TYPES]);
    expect(copy).not.toBe(DOCUMENT_MEDIA_TYPES);
    await expect(fetchPublicDocument('https://docs.school.org/a', {
      resolve, accept: copy,
      request: server([{ headers: { 'content-type': 'text/plain; charset=utf-8' }, body: html }]).request,
    })).rejects.toMatchObject({ reason: 'unsupported' });
  });

  it('refuses a feed media type on the document path', async () => {
    await expect(fetchPublicDocument('https://docs.school.org/a', {
      resolve, request: server([{ headers: { 'content-type': 'application/rss+xml' }, body: feed }]).request,
    })).rejects.toMatchObject({ reason: 'unsupported' });
  });

  it('reads a real feed through fetchPublicFeed', async () => {
    const result = await fetchPublicFeed('https://docs.school.org/feed.xml', {
      resolve, request: server([{ headers: { 'content-type': 'application/rss+xml' }, body: feed }]).request,
    });
    expect(result.text).toContain('<title>Show</title>');
    expect(result.url).toBe('https://docs.school.org/feed.xml');
  });

  it('refuses a feed that is not markup at all', async () => {
    await expect(fetchPublicFeed('https://docs.school.org/feed.xml', {
      resolve, request: server([{ headers: { 'content-type': 'application/xml' }, body: Buffer.from('nope') }]).request,
    })).rejects.toMatchObject({ reason: 'unsupported' });
  });

  it('gives a feed the same address guard a document gets', async () => {
    // The whole reason feeds reuse this file rather than fetching for
    // themselves: a feed URL is chosen by a user.
    const privateDns = vi.fn(async () => [{ address: '169.254.169.254', family: 4 as const }]);
    await expect(fetchPublicFeed('https://metadata.school.org/feed.xml', {
      resolve: privateDns, request: server([]).request,
    })).rejects.toMatchObject({ reason: 'blocked' });
  });
});
