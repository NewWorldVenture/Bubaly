import 'server-only';
import { Agent, request as httpsRequest, type RequestOptions } from 'node:https';
import { Transform, type Readable } from 'node:stream';
import type { LookupFunction } from 'node:net';
import {
  PublicDocumentError, isPublicDocumentAddress, resolvePublicAddresses,
} from '@/lib/server/public-document-fetch';

// lib/server/public-media-fetch.ts
//
// Streams one podcast episode from its publisher, through the same address
// guard document fetching uses.
//
// Why this exists at all, when the browser could fetch the enclosure URL
// itself — and did:
//
//   `cache.add()` performs its fetch from the DOCUMENT context, so it is
//   governed by `connect-src`, not `media-src`. Bubaly's policy allows
//   `media-src https:` (which is why streaming worked) and restricts
//   `connect-src` to self, Supabase and four named APIs. No podcast CDN is on
//   that list, so every Download press failed with a CSP refusal — on every
//   feed, every device, deterministically, since the button shipped. Widening
//   connect-src to the whole web to fix it would trade the feature for the
//   policy. Serving the bytes from our own origin keeps the policy intact and
//   makes `cache.add` a same-origin request, which `connect-src 'self'` already
//   permits. It also sidesteps CORS: `cache.add` rejects an opaque response, so
//   a CDN without `Access-Control-Allow-Origin` would have failed regardless.
//
// This is a proxy, so it is written like one that could be abused:
//
//   • the URL is never taken from the request. The caller passes a `media_url`
//     it read from a row the user is allowed to see, so the reachable set is
//     the family's own subscriptions and not the whole internet.
//   • every hop is DNS-resolved and PINNED before connecting, rejecting any
//     address that is not global unicast, so a publisher cannot redirect us at
//     a metadata endpoint or something on the internal network.
//   • https only, a redirect budget, a byte ceiling, and no proxy or pooled
//     connection that could bypass the pinned lookup.

/** Media types a podcast or audiobook actually arrives as. */
const MEDIA_TYPES = [
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac',
  'audio/ogg', 'audio/opus', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/flac',
  'video/mp4', 'video/webm',
  // Plenty of CDNs serve episodes as a generic stream; the extension and the
  // player decide. This is the one loose entry, and it is why the size ceiling
  // and the address guard below are not optional.
  'application/octet-stream',
];

/** An episode nobody needs is still an episode somebody can make us fetch. */
export const MAX_MEDIA_BYTES = 500 * 1024 * 1024;
const MAX_REDIRECTS = 4;
export const MEDIA_TIMEOUT_MS = 60_000;

export type MediaResponse = {
  status: 200 | 206;
  headers: Record<string, string>;
  body: Readable;
  /** Closes the socket and the per-request agent. Always call it. */
  close: () => void;
};

type Address = { address: string; family: 4 | 6 };

function openHop(
  url: URL, pinned: Address, range: string | null, signal: AbortSignal,
  request: typeof httpsRequest,
): Promise<{ redirect: string } | MediaResponse> {
  return new Promise((resolve, reject) => {
    // Per-request agent and an explicit lookup: no pooled connection and no
    // environment proxy may reach an address this did not approve.
    const lookup: LookupFunction = (_host, options, callback) => {
      if (typeof options === 'object' && options.all) callback(null, [pinned]);
      else callback(null, pinned.address, pinned.family);
    };
    const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 });
    const headers: Record<string, string> = {
      Accept: 'audio/*,video/*;q=0.9,*/*;q=0.1',
      'Accept-Encoding': 'identity',
      'User-Agent': 'Bubaly-Library/1.0',
    };
    // The player asks for a byte range when it seeks; pass it through so the
    // publisher answers 206 and scrubbing keeps working through the proxy.
    if (range) headers.Range = range;

    const options: RequestOptions & { autoSelectFamily: boolean } = {
      agent, lookup, family: pinned.family, autoSelectFamily: false,
      servername: url.hostname, rejectUnauthorized: true, signal,
      maxHeaderSize: 16 * 1024, method: 'GET', headers,
    };

    const req = request(url, options, (response) => {
      const fail = (error: Error) => { reject(error); response.destroy(); agent.destroy(); };
      const status = response.statusCode ?? 0;

      if ([301, 302, 303, 307, 308].includes(status)) {
        if (!response.headers.location) return fail(new PublicDocumentError('unsupported'));
        resolve({ redirect: response.headers.location });
        response.destroy(); agent.destroy();
        return;
      }
      if (status !== 200 && status !== 206) {
        return fail(new PublicDocumentError(status === 429 || status >= 500 ? 'unavailable' : 'unsupported', status === 429 || status >= 500));
      }

      const contentType = (response.headers['content-type'] ?? '').toLowerCase();
      const mediaType = contentType.split(';')[0].trim();
      if (!MEDIA_TYPES.includes(mediaType)) return fail(new PublicDocumentError('unsupported'));

      const declared = response.headers['content-length'];
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_MEDIA_BYTES)) {
        return fail(new PublicDocumentError('too_large'));
      }

      // A publisher that declares nothing can still send forever, so count.
      //
      // Through a Transform, NOT an `on('data')` listener. Attaching a data
      // listener switches the stream to flowing mode there and then, and every
      // chunk that arrives before the caller attaches its own reader is
      // delivered to nobody — the episode plays short, or empty, depending on
      // timing. A pipe hands the bytes to something that buffers them until
      // they are read.
      let seen = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          seen += chunk.length;
          if (seen > MAX_MEDIA_BYTES) { done(new PublicDocumentError('too_large')); return; }
          done(null, chunk);
        },
      });
      response.pipe(meter);
      response.once('error', (error) => meter.destroy(error));

      const out: Record<string, string> = { 'content-type': mediaType, 'accept-ranges': 'bytes' };
      if (declared) out['content-length'] = declared;
      const contentRange = response.headers['content-range'];
      if (typeof contentRange === 'string') out['content-range'] = contentRange;

      resolve({
        status: status === 206 ? 206 : 200,
        headers: out,
        body: meter,
        close: () => { response.destroy(); meter.destroy(); agent.destroy(); },
      });
    });
    req.once('error', (error) => { reject(error); agent.destroy(); });
    req.end();
  });
}

/**
 * Open one episode for streaming. The caller owns the body and must call
 * `close()` when it is done or the client goes away.
 */
export async function openPublicMedia(
  raw: string,
  { range = null, signal, resolve = resolvePublicAddresses, request = httpsRequest }: {
    range?: string | null;
    signal?: AbortSignal;
    /** Injected in tests; the default is the shared, guarded resolver. */
    resolve?: typeof resolvePublicAddresses;
    request?: typeof httpsRequest;
  } = {},
): Promise<MediaResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new PublicDocumentError('unavailable', true)), MEDIA_TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });

  try {
    let url: URL;
    try { url = new URL(raw); } catch { throw new PublicDocumentError('unsupported'); }

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      // https only, no embedded credentials (they would be sent to whatever the
      // host resolves to, and travel along every redirect), and no non-default
      // port — the same URL rules document fetching applies.
      if (url.protocol !== 'https:') throw new PublicDocumentError('unsupported');
      if (url.username || url.password) throw new PublicDocumentError('unsupported');
      if (url.port && url.port !== '443') throw new PublicDocumentError('unsupported');

      const addresses = await resolve(url.hostname, controller.signal);
      const pinned = addresses.find((candidate) => isPublicDocumentAddress(candidate.address));
      if (!pinned) throw new PublicDocumentError('blocked');

      const result = await openHop(url, pinned, range, controller.signal, request);
      if (!('redirect' in result)) {
        // The deadline covers reaching the first byte, not the whole download:
        // a 40-minute episode on a slow line is not a failure.
        clearTimeout(timer);
        return result;
      }
      try { url = new URL(result.redirect, url); } catch { throw new PublicDocumentError('unsupported'); }
    }
    throw new PublicDocumentError('unsupported');
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}
