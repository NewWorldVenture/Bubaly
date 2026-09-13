// lib/assistant/alexa-verify.ts
//
// Proving that a request to /api/assistant/alexa actually came from Amazon.
//
// Until this existed the endpoint took anybody's POST. The access token inside
// the envelope was still checked, so it was never a way to read a stranger's
// family — but everything Amazon's own request signing is for was missing:
//
//   • nothing tied a request to Amazon at all, so the envelope could be forged
//     wholesale by anyone who learned or guessed a `bub_asst_…` token,
//   • nothing stopped a captured envelope being replayed forever, and
//   • nothing stopped somebody else's Alexa skill pointing at our endpoint.
//
// Amazon requires all of this before a skill may be certified, so it is both
// the correct security posture and a hard prerequisite for shipping.
//
// The checks, in the order they are cheapest to run:
//
//   1. `Signature-256` and `SignatureCertChainUrl` headers are present.
//   2. The cert chain URL matches Amazon's published policy exactly. This one
//      is load-bearing beyond spec-compliance: we FETCH that URL, so an
//      unchecked one turns this endpoint into an SSRF primitive.
//   3. `request.timestamp` is within 150 seconds, which is what makes a
//      captured envelope stop working. Replay protection lives here.
//   4. The skill id matches, when one is configured.
//   5. Only then is the chain fetched (cached), validated to a trusted root,
//      and the signature checked over the RAW body bytes.
//
// SERVER ONLY.
import 'server-only';
import { X509Certificate, createVerify } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { Agent, request as httpsRequest, type RequestOptions } from 'node:https';
import type { LookupFunction } from 'node:net';
import { isPublicDocumentAddress, resolvePublicAddresses } from '@/lib/server/public-document-fetch';
import type { AlexaRequestBody } from '@/lib/assistant/alexa';

/** The only host Amazon serves skill certificates from. */
export const ALEXA_CERT_HOST = 's3.amazonaws.com';
/** The only path prefix on it. Case-sensitive, per Amazon's own wording. */
export const ALEXA_CERT_PATH_PREFIX = '/echo.api/';
/** The SAN every valid Alexa signing certificate carries. */
export const ALEXA_SERVICE_DOMAIN = 'echo-api.amazon.com';
/** Amazon's published tolerance. A request older than this is a replay. */
export const ALEXA_MAX_SKEW_MS = 150_000;

const MAX_CHAIN_BYTES = 32 * 1024;
const CERT_FETCH_TIMEOUT_MS = 5_000;
const MAX_CHAIN_CERTS = 10;
/** Amazon rotates these rarely; an hour keeps a busy kitchen off S3. */
const CERT_CACHE_TTL_MS = 60 * 60 * 1000;
const CERT_CACHE_MAX = 8;
/** Below this a signature is not worth the bytes it is written in. */
const MIN_RSA_MODULUS_BITS = 2048;

export type AlexaVerifyReason =
  | 'missing_signature'
  | 'missing_cert_url'
  | 'bad_cert_url'
  | 'cert_unavailable'
  | 'bad_cert'
  | 'bad_chain'
  | 'untrusted_root'
  | 'bad_signature'
  | 'stale_timestamp'
  | 'wrong_application';

export type AlexaVerifyResult = { ok: true } | { ok: false; reason: AlexaVerifyReason };

const fail = (reason: AlexaVerifyReason): AlexaVerifyResult => ({ ok: false, reason });

/**
 * Amazon's cert-chain URL policy, applied before anything is fetched.
 *
 * Returns the parsed URL or null. The rules are Amazon's, but the reason to be
 * strict is ours: this value comes from the request and decides what the server
 * connects to. Anything looser is a server-side request forgery hole with a
 * spec citation attached.
 */
export function normalizeAlexaCertUrl(raw: string | null | undefined): URL | null {
  if (!raw || typeof raw !== 'string' || raw.length > 2_048) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  // Credentials would be sent to whatever the host resolved to.
  if (url.username || url.password) return null;
  if (url.hostname.toLowerCase() !== ALEXA_CERT_HOST) return null;
  if (url.port && url.port !== '443') return null;
  // `new URL` has already resolved `.` and `..`, so a path that still starts
  // with the prefix cannot climb out of it.
  if (!url.pathname.startsWith(ALEXA_CERT_PATH_PREFIX)) return null;
  return url;
}

/**
 * Is this envelope recent enough to act on?
 *
 * Checked in BOTH directions. Only rejecting old timestamps leaves a forger
 * free to date an envelope in the future and keep replaying it.
 */
export function alexaTimestampFresh(
  body: AlexaRequestBody, now: Date, skewMs = ALEXA_MAX_SKEW_MS,
): boolean {
  const raw = (body.request as { timestamp?: unknown } | undefined)?.timestamp;
  if (typeof raw !== 'string') return false;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return false;
  return Math.abs(now.getTime() - at) <= skewMs;
}

/**
 * Is this request for OUR skill?
 *
 * Amazon will happily sign a request from somebody else's skill that names our
 * endpoint, and that signature is genuine. Only the application id tells the
 * two apart.
 *
 * With no skill id configured this returns true: the signature and the access
 * token are what keep the endpoint closed, and refusing every request before
 * an operator has set one would mean the skill cannot be brought up at all.
 * `.env.example` and the setup docs both name it.
 */
export function alexaApplicationIdOk(body: AlexaRequestBody, expected: string | null | undefined): boolean {
  const want = (expected ?? '').trim();
  if (!want) return true;
  const withApp = body as AlexaRequestBody & {
    session?: { application?: { applicationId?: string } };
    context?: { System?: { application?: { applicationId?: string } } };
  };
  const seen = withApp.session?.application?.applicationId
    ?? withApp.context?.System?.application?.applicationId
    ?? '';
  return seen === want;
}

/** The configured skill id, or null when the operator has not set one. */
export function configuredAlexaSkillId(): string | null {
  const value = (process.env.ALEXA_SKILL_ID ?? '').trim();
  return value || null;
}

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/** Split a PEM bundle into certificates, newest (leaf) first, as Amazon sends it. */
export function parseCertChain(pem: string): X509Certificate[] | null {
  const blocks = pem.match(PEM_BLOCK);
  if (!blocks || !blocks.length || blocks.length > MAX_CHAIN_CERTS) return null;
  try {
    return blocks.map((block) => new X509Certificate(block));
  } catch {
    return null;
  }
}

function withinValidity(cert: X509Certificate, now: Date): boolean {
  const from = cert.validFromDate?.getTime() ?? Date.parse(cert.validFrom);
  const to = cert.validToDate?.getTime() ?? Date.parse(cert.validTo);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  const at = now.getTime();
  return at >= from && at <= to;
}

/**
 * The platform trust store, indexed by subject so anchoring one chain is a map
 * lookup rather than 144 signature checks.
 *
 * Built lazily and once. Parsing the whole store costs a few milliseconds;
 * doing it per request would put that on every utterance.
 */
let anchorsBySubject: Map<string, X509Certificate[]> | null = null;
let anchorSource: readonly string[] | null = null;

function anchorIndex(pems: readonly string[]): Map<string, X509Certificate[]> {
  if (anchorsBySubject && anchorSource === pems) return anchorsBySubject;
  const index = new Map<string, X509Certificate[]>();
  for (const pem of pems) {
    let cert: X509Certificate;
    try { cert = new X509Certificate(pem); } catch { continue; }
    const existing = index.get(cert.subject);
    if (existing) existing.push(cert);
    else index.set(cert.subject, [cert]);
  }
  anchorsBySubject = index;
  anchorSource = pems;
  return index;
}

/**
 * Verify a chain and the signature it vouches for.
 *
 * Split out from the fetching so the security-critical half is testable
 * against a chain a test mints itself, with no network and no Amazon.
 *
 * `trustAnchors` defaults to the platform root store. It is a parameter only
 * so a test can anchor its own root — there is no environment variable and no
 * request header that can move it, because an "allow this root" switch is
 * exactly the switch that ends up flipped in production.
 */
export function verifyAlexaSignatureWithChain({
  chainPem, signature, body, now, trustAnchors = rootCertificates,
}: {
  chainPem: string;
  signature: string;
  body: Uint8Array;
  now: Date;
  trustAnchors?: readonly string[];
}): AlexaVerifyResult {
  if (!/^[A-Za-z0-9+/=\s]+$/.test(signature) || signature.length > 4_096) return fail('bad_signature');

  const chain = parseCertChain(chainPem);
  if (!chain) return fail('bad_cert');

  const leaf = chain[0];
  // The SAN check is what stops a certificate Amazon issued for something else
  // from signing skill traffic.
  if (!leaf.checkHost(ALEXA_SERVICE_DOMAIN)) return fail('bad_cert');
  // An expired certificate is the normal shape of a replayed capture that has
  // outlived its key, so every cert in the chain is checked, not just the leaf.
  if (chain.some((cert) => !withinValidity(cert, now))) return fail('bad_cert');

  const key = leaf.publicKey;
  if (key.asymmetricKeyType !== 'rsa') return fail('bad_cert');
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_RSA_MODULUS_BITS) return fail('bad_cert');

  // Each certificate must actually be signed by the next one along. Checking
  // only that the issuer NAMES match would accept any chain an attacker cared
  // to assemble out of correctly-named certificates.
  for (let i = 0; i < chain.length - 1; i += 1) {
    if (!chain[i].checkIssued(chain[i + 1])) return fail('bad_chain');
    if (!chain[i].verify(chain[i + 1].publicKey)) return fail('bad_chain');
  }

  // And the top of it must reach a root the platform already trusts, or the
  // whole chain is just a self-signed one with extra steps.
  const top = chain[chain.length - 1];
  const index = anchorIndex(trustAnchors);
  const anchored = (index.get(top.issuer) ?? []).some(
    (anchor) => top.checkIssued(anchor) && top.verify(anchor.publicKey),
  )
    // A chain that already includes its root: accept it only if that root is
    // byte-for-byte one we trust.
    || (index.get(top.subject) ?? []).some((anchor) => anchor.raw.equals(top.raw));
  if (!anchored) return fail('untrusted_root');

  // Finally the signature itself, over the bytes that arrived — not over a
  // re-serialisation of the parsed body, which would not be the same bytes.
  let verified = false;
  try {
    verified = createVerify('RSA-SHA256').update(body).verify(key, signature.trim(), 'base64');
  } catch {
    return fail('bad_signature');
  }
  return verified ? { ok: true } : fail('bad_signature');
}

type CachedChain = { pem: string; at: number };
const chainCache = new Map<string, CachedChain>();

/** Exported for tests; a per-process cache would otherwise leak between them. */
export function clearAlexaCertCache(): void {
  chainCache.clear();
  anchorsBySubject = null;
  anchorSource = null;
}

function readChain(url: URL, pinned: { address: string; family: 4 | 6 }, signal: AbortSignal, request: typeof httpsRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const lookup: LookupFunction = (_host, options, callback) => {
      if (typeof options === 'object' && options.all) callback(null, [pinned]);
      else callback(null, pinned.address, pinned.family);
    };
    const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 });
    const options: RequestOptions & { autoSelectFamily: boolean } = {
      agent, lookup, family: pinned.family, autoSelectFamily: false,
      servername: url.hostname, rejectUnauthorized: true, signal,
      maxHeaderSize: 8 * 1024, method: 'GET',
      headers: { Accept: 'application/x-pem-file,text/plain,*/*', 'Accept-Encoding': 'identity', 'User-Agent': 'Bubaly-Assistant/1.0' },
    };
    const req = request(url, options, (response) => {
      const stop = (error: Error) => { reject(error); response.destroy(); agent.destroy(); };
      // Redirects are NOT followed. The policy above pins one host and one path
      // prefix; following a redirect would hand that decision back to whoever
      // answered, which is the whole thing the policy exists to prevent.
      if (response.statusCode !== 200) return stop(new Error(`cert_status_${response.statusCode}`));
      const declared = response.headers['content-length'];
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_CHAIN_BYTES)) {
        return stop(new Error('cert_too_large'));
      }
      const chunks: Buffer[] = [];
      let seen = 0;
      response.on('data', (chunk: Buffer) => {
        seen += chunk.length;
        if (seen > MAX_CHAIN_BYTES) return stop(new Error('cert_too_large'));
        chunks.push(chunk);
      });
      response.once('end', () => { agent.destroy(); resolve(Buffer.concat(chunks).toString('utf8')); });
      response.once('error', stop);
    });
    req.once('error', (error) => { reject(error); agent.destroy(); });
    req.end();
  });
}

/** Fetch a cert chain through the same address guard everything else uses. */
export async function fetchAlexaCertChain(
  url: URL,
  { resolve = resolvePublicAddresses, request = httpsRequest }: {
    resolve?: typeof resolvePublicAddresses; request?: typeof httpsRequest;
  } = {},
): Promise<string> {
  const key = url.toString();
  const hit = chainCache.get(key);
  if (hit && Date.now() - hit.at < CERT_CACHE_TTL_MS) return hit.pem;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('cert_timeout')), CERT_FETCH_TIMEOUT_MS);
  try {
    const addresses = await resolve(url.hostname, controller.signal);
    const pinned = addresses.find((candidate) => isPublicDocumentAddress(candidate.address));
    if (!pinned) throw new Error('cert_blocked');
    const pem = await readChain(url, pinned, controller.signal, request);
    if (chainCache.size >= CERT_CACHE_MAX) {
      const oldest = chainCache.keys().next().value;
      if (oldest !== undefined) chainCache.delete(oldest);
    }
    chainCache.set(key, { pem, at: Date.now() });
    return pem;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The whole check, in the order that does the cheap work first.
 *
 * The network fetch is last on purpose: everything above it is a string
 * comparison, so an unsigned flood costs no outbound requests.
 */
export async function verifyAlexaRequest({
  headers, rawBody, body, now = new Date(), skillId = configuredAlexaSkillId(),
  fetchChain = fetchAlexaCertChain, trustAnchors,
}: {
  headers: Headers;
  rawBody: Uint8Array;
  body: AlexaRequestBody;
  now?: Date;
  skillId?: string | null;
  fetchChain?: typeof fetchAlexaCertChain;
  trustAnchors?: readonly string[];
}): Promise<AlexaVerifyResult> {
  // Amazon has sent both `Signature-256` (SHA-256) and `Signature` (SHA-1) at
  // different times. Only the SHA-256 one is accepted; taking the legacy header
  // would mean an attacker could pick the weaker algorithm by choosing which
  // header to send, which is the entire shape of a downgrade attack.
  const signature = headers.get('signature-256');
  if (!signature) return fail('missing_signature');

  const rawUrl = headers.get('signaturecertchainurl');
  if (!rawUrl) return fail('missing_cert_url');
  const url = normalizeAlexaCertUrl(rawUrl);
  if (!url) return fail('bad_cert_url');

  if (!alexaTimestampFresh(body, now)) return fail('stale_timestamp');
  if (!alexaApplicationIdOk(body, skillId)) return fail('wrong_application');

  let chainPem: string;
  try {
    chainPem = await fetchChain(url);
  } catch {
    return fail('cert_unavailable');
  }

  return verifyAlexaSignatureWithChain({ chainPem, signature, body: rawBody, now, trustAnchors });
}
