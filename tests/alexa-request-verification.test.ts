import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createSign } from 'node:crypto';
import { request as nativeRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALEXA_CERT_HOST, ALEXA_MAX_SKEW_MS, alexaApplicationIdOk, alexaTimestampFresh,
  clearAlexaCertCache, fetchAlexaCertChain, normalizeAlexaCertUrl,
  verifyAlexaRequest, verifyAlexaSignatureWithChain,
} from '@/lib/assistant/alexa-verify';
import type { AlexaRequestBody } from '@/lib/assistant/alexa';

// Before this existed, /api/assistant/alexa took anybody's POST. The access
// token inside the envelope was still checked, so it was never a way to read a
// stranger's family — but every property Amazon's request signing provides was
// absent: nothing tied a request to Amazon, nothing stopped a captured envelope
// being replayed forever, and nothing stopped someone else's skill pointing at
// the endpoint.
//
// The chain below is minted here rather than checked in, so nothing expires and
// the tests anchor their own root. Real requests anchor to the platform trust
// store, and one test below proves that is still what the default does.

let dir = '';
let rootPem = '';
let intPem = '';
let leafPem = '';
let leafKey = '';
/** leaf → intermediate → root, the order Amazon sends. */
let chainPem = '';

const ssl = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
const read = (name: string) => readFileSync(join(dir, name), 'utf8');

/** A leaf signed by `caName`, with whatever SAN and key size the case needs. */
function mintLeaf(name: string, { ca = 'int', san = 'DNS:echo-api.amazon.com', bits = 2048 } = {}) {
  ssl(['req', '-newkey', `rsa:${bits}`, '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`,
    '-subj', '/CN=echo-api.amazon.com']);
  writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${san}\nbasicConstraints=critical,CA:FALSE\n`);
  ssl(['x509', '-req', '-in', `${name}.csr`, '-CA', `${ca}.pem`, '-CAkey', `${ca}.key`,
    '-out', `${name}.pem`, '-days', '2', '-CAcreateserial', '-extfile', `${name}.ext`]);
  return { pem: read(`${name}.pem`), key: read(`${name}.key`) };
}

function mintCa(name: string, { signedBy = '' } = {}) {
  writeFileSync(join(dir, `${name}.ext`), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  if (!signedBy) {
    ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.pem`,
      '-days', '2', '-subj', `/CN=Bubaly Test ${name}`, '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  } else {
    ssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`,
      '-subj', '/CN=Bubaly Test Intermediate']);
    ssl(['x509', '-req', '-in', `${name}.csr`, '-CA', `${signedBy}.pem`, '-CAkey', `${signedBy}.key`,
      '-out', `${name}.pem`, '-days', '2', '-CAcreateserial', '-extfile', `${name}.ext`]);
  }
  return read(`${name}.pem`);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bubaly-alexa-certs-'));
  rootPem = mintCa('root');
  intPem = mintCa('int', { signedBy: 'root' });
  const leaf = mintLeaf('leaf');
  leafPem = leaf.pem;
  leafKey = leaf.key;
  chainPem = [leafPem, intPem, rootPem].join('\n');
}, 60_000);

afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { clearAlexaCertCache(); });

const sign = (body: Buffer | string, key = leafKey) =>
  createSign('RSA-SHA256').update(body).sign(key, 'base64');

// Real wall-clock, because certificate validity is wall-clock: the chain above
// is minted at run time with a two-day window, so a hard-coded instant would
// fall outside it and every signature test would fail on `bad_cert` for a
// reason that has nothing to do with what it is checking. A minute ahead,
// because openssl stamps notBefore at whole-second resolution when the chain is
// minted — which happens after this module is evaluated.
const NOW = new Date(Date.now() + 60_000);
const envelope = (over: Record<string, unknown> = {}): AlexaRequestBody => ({
  version: '1.0',
  session: { user: { accessToken: 'bub_asst_x' }, application: { applicationId: 'amzn1.ask.skill.bubaly' } },
  request: { type: 'IntentRequest', timestamp: NOW.toISOString(), intent: { name: 'AskBubaly', slots: {} } },
  ...over,
} as AlexaRequestBody);

describe('the certificate URL decides what the server connects to', () => {
  // Amazon publishes these rules, but the reason to enforce them is ours: this
  // value comes out of the request and we fetch it. Anything looser is an SSRF
  // hole with a spec citation attached.
  it('accepts the canonical form, with or without the default port', () => {
    expect(normalizeAlexaCertUrl(`https://${ALEXA_CERT_HOST}/echo.api/echo-api-cert-7.pem`)?.pathname)
      .toBe('/echo.api/echo-api-cert-7.pem');
    expect(normalizeAlexaCertUrl(`https://${ALEXA_CERT_HOST}:443/echo.api/cert.pem`)).not.toBeNull();
    // The HOST is case-insensitive because DNS is.
    expect(normalizeAlexaCertUrl('https://S3.AMAZONAWS.COM/echo.api/cert.pem')).not.toBeNull();
  });

  it.each([
    ['plain http', 'http://s3.amazonaws.com/echo.api/cert.pem'],
    ['another host entirely', 'https://evil.example.com/echo.api/cert.pem'],
    ['a host that merely starts the same', 'https://s3.amazonaws.com.evil.example.com/echo.api/cert.pem'],
    ['a subdomain', 'https://notreally.s3.amazonaws.com/echo.api/cert.pem'],
    ['a path outside the prefix', 'https://s3.amazonaws.com/evil/cert.pem'],
    // `new URL` resolves the `..` first, so what is actually checked is the
    // destination — which is how a traversal must be rejected.
    ['a traversal out of the prefix', 'https://s3.amazonaws.com/echo.api/../evil/cert.pem'],
    ['a differently-cased prefix', 'https://s3.amazonaws.com/ECHO.API/cert.pem'],
    ['embedded credentials', 'https://user:pass@s3.amazonaws.com/echo.api/cert.pem'],
    ['an odd port', 'https://s3.amazonaws.com:8443/echo.api/cert.pem'],
    ['a file URL', 'file:///etc/passwd'],
    ['nonsense', 'not a url at all'],
  ])('refuses %s', (_label, url) => {
    expect(normalizeAlexaCertUrl(url)).toBeNull();
  });

  it('refuses a missing header rather than throwing', () => {
    expect(normalizeAlexaCertUrl(null)).toBeNull();
    expect(normalizeAlexaCertUrl('')).toBeNull();
    expect(normalizeAlexaCertUrl('x'.repeat(4_000))).toBeNull();
  });
});

describe('a captured envelope has to stop working', () => {
  it('accepts a request inside Amazon’s tolerance', () => {
    expect(alexaTimestampFresh(envelope(), NOW)).toBe(true);
    expect(alexaTimestampFresh(envelope(), new Date(NOW.getTime() + ALEXA_MAX_SKEW_MS - 1_000))).toBe(true);
  });

  it('refuses one that has aged out', () => {
    expect(alexaTimestampFresh(envelope(), new Date(NOW.getTime() + ALEXA_MAX_SKEW_MS + 1_000))).toBe(false);
  });

  it('refuses one dated in the future', () => {
    // Checked in BOTH directions on purpose. Rejecting only old timestamps
    // leaves a forger free to post-date a capture and replay it indefinitely,
    // which is the exact attack the freshness window exists to stop.
    expect(alexaTimestampFresh(envelope(), new Date(NOW.getTime() - ALEXA_MAX_SKEW_MS - 1_000))).toBe(false);
  });

  it.each([
    ['absent', {}],
    ['not a string', { timestamp: 12345 }],
    ['unparsable', { timestamp: 'sometime last tuesday' }],
  ])('refuses a timestamp that is %s', (_label, request) => {
    expect(alexaTimestampFresh({ request } as AlexaRequestBody, NOW)).toBe(false);
  });
});

describe('someone else’s skill is still someone else’s', () => {
  // Amazon will sign a request from anyone's skill that names our endpoint, and
  // that signature is genuine. Only the application id tells them apart.
  const SKILL = 'amzn1.ask.skill.bubaly';

  it('accepts our id from either place Alexa puts it', () => {
    expect(alexaApplicationIdOk(envelope(), SKILL)).toBe(true);
    expect(alexaApplicationIdOk(
      { context: { System: { application: { applicationId: SKILL } } } } as AlexaRequestBody, SKILL,
    )).toBe(true);
  });

  it('refuses another skill’s id, and an envelope carrying none', () => {
    expect(alexaApplicationIdOk(
      { session: { application: { applicationId: 'amzn1.ask.skill.someone-else' } } } as AlexaRequestBody, SKILL,
    )).toBe(false);
    expect(alexaApplicationIdOk({} as AlexaRequestBody, SKILL)).toBe(false);
  });

  it('does not gate on an id nobody has configured', () => {
    // The signature and the access token are what keep this endpoint closed.
    // Refusing everything before an operator sets a skill id would mean the
    // skill could never be brought up at all.
    expect(alexaApplicationIdOk({} as AlexaRequestBody, null)).toBe(true);
    expect(alexaApplicationIdOk({} as AlexaRequestBody, '  ')).toBe(true);
  });
});

describe('the signature is the part that cannot be faked', () => {
  const body = Buffer.from(JSON.stringify(envelope()));
  const anchors = () => [rootPem];

  it('accepts a real signature over exactly the bytes that arrived', () => {
    expect(verifyAlexaSignatureWithChain({
      chainPem, signature: sign(body), body, now: NOW, trustAnchors: anchors(),
    })).toEqual({ ok: true });
  });

  it('refuses a body altered by one byte after signing', () => {
    const tampered = Buffer.from(body.toString().replace('AskBubaly', 'AskBubalx'));
    expect(tampered.length).toBe(body.length);
    expect(verifyAlexaSignatureWithChain({
      chainPem, signature: sign(body), body: tampered, now: NOW, trustAnchors: anchors(),
    })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a signature made with some other key', () => {
    const other = mintLeaf('other');
    expect(verifyAlexaSignatureWithChain({
      chainPem, signature: sign(body, other.key), body, now: NOW, trustAnchors: anchors(),
    })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a certificate that is not for the Alexa service domain', () => {
    const wrong = mintLeaf('wrongsan', { san: 'DNS:bubaly.example.com' });
    expect(verifyAlexaSignatureWithChain({
      chainPem: [wrong.pem, intPem, rootPem].join('\n'),
      signature: sign(body, wrong.key), body, now: NOW, trustAnchors: anchors(),
    })).toEqual({ ok: false, reason: 'bad_cert' });
  });

  it('refuses a chain whose top reaches no trusted root', () => {
    // THE load-bearing one. Without an anchor check, anyone can mint a
    // certificate that says echo-api.amazon.com and sign their own forgeries
    // with it — every other check in this file would pass.
    const rogueRoot = mintCa('rogue');
    const rogueLeaf = mintLeaf('rogueleaf', { ca: 'rogue' });
    expect(verifyAlexaSignatureWithChain({
      chainPem: [rogueLeaf.pem, rogueRoot].join('\n'),
      signature: sign(body, rogueLeaf.key), body, now: NOW, trustAnchors: anchors(),
    })).toEqual({ ok: false, reason: 'untrusted_root' });
  });

  it('anchors to the platform trust store by default', () => {
    // No parameter, no environment variable, no header moves this. Proven by
    // the test chain — which passes every other check — failing on it.
    expect(verifyAlexaSignatureWithChain({ chainPem, signature: sign(body), body, now: NOW }))
      .toEqual({ ok: false, reason: 'untrusted_root' });
  });

  it('refuses a chain whose links merely share a name', () => {
    // A second intermediate with the SAME subject as the real one and a
    // different key. Comparing issuer names alone would accept this.
    const impostor = mintCa('int2', { signedBy: 'root' });
    const result = verifyAlexaSignatureWithChain({
      chainPem: [leafPem, impostor, rootPem].join('\n'),
      signature: sign(body), body, now: NOW, trustAnchors: anchors(),
    });
    expect(result).toEqual({ ok: false, reason: 'bad_chain' });
  });

  it('refuses an expired certificate', () => {
    const later = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(verifyAlexaSignatureWithChain({
      chainPem, signature: sign(body), body, now: later, trustAnchors: anchors(),
    })).toEqual({ ok: false, reason: 'bad_cert' });
  });

  it('refuses a certificate not yet valid', () => {
    const earlier = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(verifyAlexaSignatureWithChain({
      chainPem, signature: sign(body), body, now: earlier, trustAnchors: anchors(),
    })).toEqual({ ok: false, reason: 'bad_cert' });
  });

  it('refuses a key too small to mean anything', () => {
    const weak = mintLeaf('weak', { bits: 1024 });
    expect(verifyAlexaSignatureWithChain({
      chainPem: [weak.pem, intPem, rootPem].join('\n'),
      signature: sign(body, weak.key), body, now: NOW, trustAnchors: anchors(),
    })).toEqual({ ok: false, reason: 'bad_cert' });
  });

  it.each([
    ['nothing that looks like a certificate', 'hello'],
    ['a truncated block', '-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----'],
  ])('refuses %s', (_label, pem) => {
    expect(verifyAlexaSignatureWithChain({
      chainPem: pem, signature: sign(body), body, now: NOW, trustAnchors: anchors(),
    })).toEqual({ ok: false, reason: 'bad_cert' });
  });

  it('refuses a signature that is not base64 without throwing', () => {
    expect(verifyAlexaSignatureWithChain({
      chainPem, signature: '../../etc/passwd', body, now: NOW, trustAnchors: anchors(),
    })).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('the cheap checks run before anything is fetched', () => {
  const body = Buffer.from(JSON.stringify(envelope()));
  const headers = (over: Record<string, string | null> = {}) => {
    const h = new Headers({
      'signature-256': sign(body),
      signaturecertchainurl: `https://${ALEXA_CERT_HOST}/echo.api/echo-api-cert-7.pem`,
    });
    for (const [key, value] of Object.entries(over)) {
      if (value === null) h.delete(key);
      else h.set(key, value);
    }
    return h;
  };
  const run = (over: Record<string, string | null> = {}, body_ = envelope(), skillId: string | null = null) => {
    const fetchChain = vi.fn(async () => chainPem);
    return verifyAlexaRequest({
      headers: headers(over), rawBody: body, body: body_, now: NOW, skillId,
      fetchChain: fetchChain as unknown as typeof fetchAlexaCertChain, trustAnchors: [rootPem],
    }).then((result) => ({ result, fetched: fetchChain.mock.calls.length }));
  };

  it('verifies a genuine request end to end', async () => {
    expect(await run()).toEqual({ result: { ok: true }, fetched: 1 });
  });

  it.each([
    ['no signature header', { 'signature-256': null }, 'missing_signature'],
    ['no certificate header', { signaturecertchainurl: null }, 'missing_cert_url'],
    ['a certificate URL we will not follow', { signaturecertchainurl: 'https://evil.example.com/x.pem' }, 'bad_cert_url'],
  ])('rejects %s without making a request', async (_label, over, reason) => {
    // The fetch count is the assertion that matters. An endpoint that resolves
    // and connects before checking the URL is a way to make this server issue
    // outbound requests at whatever rate the caller likes.
    expect(await run(over as Record<string, string | null>)).toEqual({ result: { ok: false, reason }, fetched: 0 });
  });

  it('rejects a stale envelope without making a request', async () => {
    const stale = envelope({
      request: { type: 'IntentRequest', timestamp: new Date(NOW.getTime() - 10 * 60_000).toISOString() },
    });
    expect(await run({}, stale)).toEqual({ result: { ok: false, reason: 'stale_timestamp' }, fetched: 0 });
  });

  it('rejects another skill without making a request', async () => {
    expect(await run({}, envelope(), 'amzn1.ask.skill.something-else'))
      .toEqual({ result: { ok: false, reason: 'wrong_application' }, fetched: 0 });
  });

  it('reports an unreachable certificate as its own reason', async () => {
    const fetchChain = vi.fn(async () => { throw new Error('boom'); });
    await expect(verifyAlexaRequest({
      headers: headers(), rawBody: body, body: envelope(), now: NOW, skillId: null,
      fetchChain: fetchChain as unknown as typeof fetchAlexaCertChain, trustAnchors: [rootPem],
    })).resolves.toEqual({ ok: false, reason: 'cert_unavailable' });
  });

  it('takes only the SHA-256 header, never the legacy SHA-1 one', async () => {
    // Accepting `Signature` as a fallback would let the caller choose the
    // weaker algorithm by choosing which header to send.
    const { result, fetched } = await run({ 'signature-256': null, signature: sign(body) });
    expect(result).toEqual({ ok: false, reason: 'missing_signature' });
    expect(fetched).toBe(0);
  });
});

describe('fetching the chain is itself a request we make on a stranger’s say-so', () => {
  const publicAddress = { address: '52.216.0.1', family: 4 as const };
  const resolve = vi.fn(async () => [publicAddress]);
  const url = new URL(`https://${ALEXA_CERT_HOST}/echo.api/echo-api-cert-7.pem`);

  function server(spec: { status?: number; headers?: Record<string, string>; body?: string } = {}) {
    const calls: { url: URL; options: RequestOptions }[] = [];
    const request = vi.fn((target: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      calls.push({ url: target, options });
      const req = new EventEmitter() as ClientRequest;
      req.end = (() => {
        queueMicrotask(() => {
          const response = Object.assign(new PassThrough(), {
            statusCode: spec.status ?? 200, headers: spec.headers ?? {}, complete: true,
          });
          callback(response as unknown as IncomingMessage);
          response.end(spec.body ?? chainPem);
        });
        return req;
      }) as ClientRequest['end'];
      return req;
    }) as unknown as typeof nativeRequest;
    return { request, calls };
  }

  it('pins the resolved address rather than letting the socket resolve again', async () => {
    const fake = server();
    await expect(fetchAlexaCertChain(url, { resolve, request: fake.request })).resolves.toContain('BEGIN CERTIFICATE');
    expect(typeof fake.calls[0].options.lookup).toBe('function');
    expect(fake.calls[0].options.agent).toBeTruthy();
  });

  it('refuses a host that resolves somewhere private', async () => {
    const fake = server();
    const internal = vi.fn(async () => [{ address: '169.254.169.254', family: 4 as const }]);
    await expect(fetchAlexaCertChain(url, { resolve: internal, request: fake.request })).rejects.toBeTruthy();
    expect(fake.calls).toHaveLength(0);
  });

  it('does not follow a redirect', async () => {
    // The URL policy pins one host and one path prefix. Following a redirect
    // would hand that decision back to whoever answered.
    const fake = server({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    await expect(fetchAlexaCertChain(url, { resolve, request: fake.request })).rejects.toBeTruthy();
    expect(fake.calls).toHaveLength(1);
  });

  it('refuses a response that declares more than a certificate chain could be', async () => {
    const fake = server({ headers: { 'content-length': String(1024 * 1024) } });
    await expect(fetchAlexaCertChain(url, { resolve, request: fake.request })).rejects.toBeTruthy();
  });

  it('refuses a response that keeps going past the ceiling it declared nothing about', async () => {
    const fake = server({ body: 'x'.repeat(64 * 1024) });
    await expect(fetchAlexaCertChain(url, { resolve, request: fake.request })).rejects.toBeTruthy();
  });

  it('serves the second request for the same URL from cache', async () => {
    // A busy kitchen should not mean a request to S3 per utterance.
    const fake = server();
    await fetchAlexaCertChain(url, { resolve, request: fake.request });
    await fetchAlexaCertChain(url, { resolve, request: fake.request });
    expect(fake.calls).toHaveLength(1);
  });
});

describe('the route proves the request before it does anything with it', () => {
  const route = readFileSync('app/api/assistant/alexa/route.ts', 'utf8');

  it('verifies before it looks at the token or the database', () => {
    const verify = route.indexOf('await verifyAlexaRequest(');
    const token = route.indexOf('alexaAccessToken(envelope)');
    const client = route.indexOf('createServiceClient()');
    expect(verify).toBeGreaterThan(-1);
    expect(verify).toBeLessThan(token);
    expect(verify).toBeLessThan(client);
  });

  it('signs over the bytes that arrived, not a re-serialisation of them', () => {
    // JSON.parse then JSON.stringify changes whitespace and key order, and the
    // signature would never verify again.
    expect(route).toContain('readBoundedRequestBytes');
    expect(route).toContain('rawBody: raw.bytes');
    expect(route).not.toContain('readBoundedRequestJson');
  });

  it('answers an unverifiable request with a status and no speech', () => {
    // There is no device on the other end of a forged request, so there is
    // nobody to speak to — and speech would confirm the endpoint is live.
    expect(route).toMatch(/verified\.ok[\s\S]{0,320}status: 403/);
  });

  it('still bounds the body', () => {
    expect(route).toContain('MAX_BODY_BYTES');
  });
});
