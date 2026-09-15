import 'server-only';
import { isIP } from 'node:net';
import { isPublicDocumentAddress, resolvePublicAddresses } from '@/lib/server/public-document-fetch';
import { isPrivateOrReservedHost } from '@/lib/server/push-request';

/**
 * Does this push endpoint resolve somewhere the server is willing to POST to?
 *
 * `isPrivateOrReservedHost` inspects the hostname STRING. It never asks DNS
 * anything, so an ordinary public name whose A record is 127.0.0.1 — the
 * canonical example is `localtest.me` — passed it. A user could register such
 * an endpoint and every notification sent to them afterwards would make the
 * server POST an encrypted payload at an internal address: a blind SSRF
 * primitive that repeats on the product's own notification schedule.
 *
 * This resolves, and reuses the document fetcher's address rules rather than
 * writing a fourth copy of them — that module's own comment is "two copies of
 * an SSRF guard is two guards that drift, and the one that drifts is always the
 * copy". It had drifted; this is the copy being deleted, not added.
 *
 * Fail-closed: a name that will not resolve is a name the push library cannot
 * deliver to either, so refusing it costs nothing real.
 *
 * Audit C3-S5-03.
 */
const TTL_MS = 5 * 60_000;
const RESOLVE_TIMEOUT_MS = 3_000;
const seen = new Map<string, { deliverable: boolean; at: number }>();

export async function isDeliverablePushEndpoint(endpoint: string): Promise<boolean> {
  let host: string;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    host = url.hostname;
  } catch {
    return false;
  }
  // The string check still runs first: it is the cheap half, and it catches the
  // literals and local suffixes without a lookup.
  if (isPrivateOrReservedHost(host)) return false;
  if (isIP(host)) return isPublicDocumentAddress(host);

  const now = Date.now();
  const cached = seen.get(host);
  if (cached && now - cached.at < TTL_MS) return cached.deliverable;

  let deliverable: boolean;
  try {
    const addresses = await resolvePublicAddresses(host, AbortSignal.timeout(RESOLVE_TIMEOUT_MS));
    // EVERY address, not the first: a host that answers with one public and one
    // internal address is a host that reaches the internal one half the time.
    deliverable = addresses.length > 0 && addresses.every((a) => isPublicDocumentAddress(a.address));
  } catch {
    deliverable = false;
  }
  if (seen.size > 512) seen.clear(); // Bounded: this is a cache, not a registry.
  seen.set(host, { deliverable, at: now });
  return deliverable;
}

/** Exported for tests; the cache is per-process and otherwise invisible. */
export function __resetPushEndpointCache(): void {
  seen.clear();
}
