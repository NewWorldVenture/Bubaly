import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { request as nativeRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { openPublicMedia, MAX_MEDIA_BYTES } from '@/lib/server/public-media-fetch';

// The library's Download button fetched the publisher's URL straight from the
// page. `cache.add()` fetches from the DOCUMENT context, so it answers to
// `connect-src` — not `media-src`, which is why streaming from a CDN worked and
// downloading from the same CDN could not. No podcast host is on this app's
// connect-src allowlist, so every press failed, on every feed and every device,
// from the day the button shipped.
//
// Serving the bytes from Bubaly's own origin fixes that without widening the
// policy to the whole web. The cost is that Bubaly now makes the request, which
// makes this a proxy — so what is tested here is mostly the ways a proxy is
// abused.

const publicAddress = { address: '93.184.216.34', family: 4 as const };
const resolve = vi.fn(async () => [publicAddress]);

type Spec = { status?: number; headers?: Record<string, string | undefined>; body?: Buffer; chunks?: Buffer[] };

function server(responses: Spec[]) {
  const calls: { url: URL; options: RequestOptions }[] = [];
  const request = vi.fn((url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    calls.push({ url, options });
    const spec = responses.shift() ?? {};
    const req = new EventEmitter() as ClientRequest;
    req.end = (() => {
      queueMicrotask(() => {
        const response = Object.assign(new PassThrough(), {
          statusCode: spec.status ?? 200,
          headers: { 'content-type': 'audio/mpeg', ...spec.headers },
          complete: true,
        });
        callback(response as unknown as IncomingMessage);
        if (spec.chunks) { for (const chunk of spec.chunks) response.write(chunk); response.end(); }
        else response.end(spec.body ?? Buffer.from('ID3 fake episode bytes'));
      });
      return req;
    }) as ClientRequest['end'];
    return req;
  }) as unknown as typeof nativeRequest;
  return { request, calls };
}

const read = async (body: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

describe('a proxy is only as safe as the addresses it will connect to', () => {
  it.each([
    'http://cdn.example.com/ep.mp3',
    'file:///etc/passwd',
    'https://u:p@cdn.example.com/ep.mp3',
  ])('refuses %s without connecting', async (url) => {
    const fake = server([]);
    await expect(openPublicMedia(url, { resolve, request: fake.request })).rejects.toBeTruthy();
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a host that resolves somewhere private', async () => {
    // The reason the guard is shared with document fetching rather than
    // reimplemented: this is the case a media proxy is used for.
    const fake = server([]);
    const internal = vi.fn(async () => [{ address: '169.254.169.254', family: 4 as const }]);
    await expect(openPublicMedia('https://cdn.example.com/ep.mp3', { resolve: internal, request: fake.request }))
      .rejects.toMatchObject({ message: 'blocked' });
    expect(fake.calls).toHaveLength(0);
  });

  it('re-checks the address on a redirect, not just the first hop', async () => {
    const fake = server([{ status: 302, headers: { location: 'https://evil.example.com/ep.mp3' } }]);
    const first = vi.fn(async (host: string) =>
      (host === 'cdn.example.com' ? [publicAddress] : [{ address: '10.0.0.5', family: 4 as const }]));
    await expect(openPublicMedia('https://cdn.example.com/ep.mp3', { resolve: first, request: fake.request }))
      .rejects.toMatchObject({ message: 'blocked' });
    expect(first).toHaveBeenCalledTimes(2);
  });

  it('pins the resolved address rather than letting the socket look it up again', async () => {
    const fake = server([{}]);
    const opened = await openPublicMedia('https://cdn.example.com/ep.mp3', { resolve, request: fake.request });
    opened.close();
    const options = fake.calls[0].options as RequestOptions & { lookup?: unknown; agent?: unknown };
    expect(typeof options.lookup).toBe('function');
    expect(options.servername).toBe('cdn.example.com');
    expect(options.rejectUnauthorized).toBe(true);
    // A pooled agent could hand back a connection this lookup never approved.
    expect(options.agent).toBeTruthy();
  });
});

describe('what it will and will not stream back', () => {
  it('streams an episode and reports its type', async () => {
    const fake = server([{ headers: { 'content-length': '22' } }]);
    const opened = await openPublicMedia('https://cdn.example.com/ep.mp3', { resolve, request: fake.request });
    expect(opened.status).toBe(200);
    expect(opened.headers['content-type']).toBe('audio/mpeg');
    expect(opened.headers['accept-ranges']).toBe('bytes');
    expect((await read(opened.body)).toString()).toContain('fake episode');
  });

  it('passes a Range through and returns the publisher\'s 206', async () => {
    // Scrubbing depends on this: without it, seeking a 40-minute episode would
    // re-download from the start.
    const fake = server([{ status: 206, headers: { 'content-range': 'bytes 100-199/5000', 'content-length': '100' } }]);
    const opened = await openPublicMedia('https://cdn.example.com/ep.mp3', {
      resolve, request: fake.request, range: 'bytes=100-199',
    });
    expect(fake.calls[0].options.headers).toMatchObject({ Range: 'bytes=100-199' });
    expect(opened.status).toBe(206);
    expect(opened.headers['content-range']).toBe('bytes 100-199/5000');
    opened.close();
  });

  it('refuses anything that is not media, whatever the URL says', async () => {
    const fake = server([{ headers: { 'content-type': 'text/html' } }]);
    await expect(openPublicMedia('https://cdn.example.com/ep.mp3', { resolve, request: fake.request }))
      .rejects.toMatchObject({ message: 'unsupported' });
  });

  it('refuses a declared length beyond the ceiling before reading a byte', async () => {
    const fake = server([{ headers: { 'content-length': String(MAX_MEDIA_BYTES + 1) } }]);
    await expect(openPublicMedia('https://cdn.example.com/ep.mp3', { resolve, request: fake.request }))
      .rejects.toMatchObject({ message: 'too_large' });
  });

  it('stops a publisher that declares nothing and then sends forever', async () => {
    // No content-length, so the ceiling has to be enforced while reading.
    const oversize = Buffer.alloc(1024 * 1024);
    const chunks = Array.from({ length: 8 }, () => oversize);
    const fake = server([{ headers: { 'content-length': undefined }, chunks }]);
    const opened = await openPublicMedia('https://cdn.example.com/ep.mp3', { resolve, request: fake.request });
    // The stream is live; the cap is enforced on the data path, so reading it
    // to completion is what proves the counter exists.
    const body = opened.body;
    let seen = 0;
    await new Promise<void>((done) => {
      body.on('data', (chunk: Buffer) => { seen += chunk.length; });
      body.on('close', () => done());
      body.on('error', () => done());
      body.on('end', () => done());
    });
    expect(seen).toBeLessThanOrEqual(MAX_MEDIA_BYTES);
  });

  it('gives up rather than following redirects forever', async () => {
    const fake = server(Array.from({ length: 6 }, () => ({ status: 302, headers: { location: 'https://cdn.example.com/next.mp3' } })));
    await expect(openPublicMedia('https://cdn.example.com/ep.mp3', { resolve, request: fake.request }))
      .rejects.toMatchObject({ message: 'unsupported' });
    expect(fake.calls.length).toBeLessThanOrEqual(5);
  });

  it('treats a publisher outage as retryable and a refusal as not', async () => {
    const down = server([{ status: 503 }]);
    await expect(openPublicMedia('https://cdn.example.com/ep.mp3', { resolve, request: down.request }))
      .rejects.toMatchObject({ retryable: true });
    const gone = server([{ status: 404 }]);
    await expect(openPublicMedia('https://cdn.example.com/ep.mp3', { resolve, request: gone.request }))
      .rejects.toMatchObject({ retryable: false });
  });
});
