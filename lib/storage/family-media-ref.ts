// A stored family-media reference, and the one way it becomes something a
// browser may fetch.
//
// ── Why this exists (SEC-001) ───────────────────────────────────────────────
//
// `family-media` is the one bucket created with `public = true` (0216), so a
// photo, a message attachment or a reminder image is readable by anyone who
// holds its URL — and those URLs are stored in rows, shared, cached and logged.
// Making the bucket private is the fix, but it cannot come first: every
// consumer renders the stored URL directly, so flipping the bucket before the
// consumers change breaks every image in the product at once.
//
// So the order is consumers first. Every consumer now hands its stored value to
// `signFamilyMediaRefs`, which signs it with the VIEWER's session. That works
// against the bucket as it is today (public) and as it will be (private), so the
// release carrying this can ship, and the bucket can be flipped after it is
// live without a second client change.
//
// Signing is also where authorisation happens. Storage checks the
// "Family members can read their media" policy (0216) before it signs, so a
// member of the family in the path's first segment gets a URL and nobody else
// does — including the Grandparent portal's cross-household reads, which are
// authorised per family rather than per active household.
//
// ── Rules this module keeps ─────────────────────────────────────────────────
//
//  1. A failed signing resolves to `null`, NEVER to the stored URL. Falling back
//     to the public URL is the exact read this change exists to remove, and it
//     would keep "working" right up until the bucket flip, hiding the failure.
//  2. A signed URL is a bearer credential with an expiry. It is returned to be
//     rendered, and must never be written to a row, the offline cache or any
//     other persisted place — rows keep the stable reference they always held.
//  3. Anything that LOOKS like this bucket is this bucket. A stored reference
//     does not get to name its own project: the only project the viewer can be
//     authorised against is ours, and rendering a lookalike URL directly would
//     be a public read by another route. Signing a path the viewer is not a
//     member of simply fails, which is rule 1.
//  4. Anything else is not ours to sign. Giphy images in messages, recipe
//     photos, curated fallbacks and a typed-in family cover are external URLs,
//     and pass through unchanged — but only over http(s).

import type { SupabaseClient } from '@supabase/supabase-js';

export const FAMILY_MEDIA_BUCKET = 'family-media';

/**
 * One hour. Long enough that a page, a lightbox, a video that is paused and
 * resumed, and the kiosk's 120-second refresh all reuse one URL (and so hit
 * the browser's HTTP cache); short enough that a URL copied out of the page
 * stops working the same afternoon.
 */
export const FAMILY_MEDIA_SIGNED_TTL_SECONDS = 3600;

export type FamilyMediaRef =
  | { kind: 'family-media'; path: string }
  | { kind: 'external'; url: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every URL shape Storage serves this bucket under: the public object path
// getPublicUrl builds, a signed or authenticated one, and the image-render
// variants of each.
const STORAGE_PATH = new RegExp(
  `^/storage/v1/(?:object|render/image)/(?:public|sign|authenticated)/${FAMILY_MEDIA_BUCKET}/(.+)$`,
);

/** A decoded object path, or null when it is not one this bucket could hold. */
function objectPath(encoded: string): string | null {
  const segments = encoded.split('/');
  const decoded: string[] = [];
  for (const segment of segments) {
    let s: string;
    try { s = decodeURIComponent(segment); } catch { return null; }
    // An empty, dot or slash-bearing segment is a traversal attempt or a
    // malformed row, not a path any uploader writes.
    if (!s || s === '.' || s === '..' || s.includes('/') || s.includes('\\')) return null;
    decoded.push(s);
  }
  // `{family_id}/{folder…}/{name}`: the write policies key on the first segment
  // and so does the read policy that authorises signing.
  if (decoded.length < 2 || !UUID.test(decoded[0])) return null;
  return decoded.join('/');
}

/**
 * Classify a stored value. `null` means "render nothing": empty, malformed, or
 * a scheme that has no business in an image or a download link.
 */
export function parseFamilyMediaRef(ref: string | null | undefined): FamilyMediaRef | null {
  if (typeof ref !== 'string') return null;
  const value = ref.trim();
  if (!value) return null;

  // A bare object path, as closet and inventory store it.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('//')) {
    const path = objectPath(value.replace(/^\/+/, ''));
    return path ? { kind: 'family-media', path } : null;
  }

  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const match = STORAGE_PATH.exec(url.pathname);
  if (match) {
    const path = objectPath(match[1]);
    return path ? { kind: 'family-media', path } : null;
  }
  return { kind: 'external', url: value };
}

/** True when the value is (or claims to be) an object in this bucket. */
export function isFamilyMediaRef(ref: string | null | undefined): boolean {
  return parseFamilyMediaRef(ref)?.kind === 'family-media';
}

type StorageClient = Pick<SupabaseClient, 'storage'>;

/**
 * Resolve stored references to URLs a browser may fetch, in ONE round trip.
 *
 * The map holds every distinct non-empty input. Its value is the URL to render,
 * or `null` — for a malformed reference, a path the viewer may not read, or a
 * signing call that failed. There is no third outcome, and in particular no
 * fallback to the stored URL (rule 1 above).
 */
export async function signFamilyMediaRefs(
  client: StorageClient,
  refs: Iterable<string | null | undefined>,
  ttlSeconds = FAMILY_MEDIA_SIGNED_TTL_SECONDS,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const byPath = new Map<string, string[]>();
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref.trim() || out.has(ref)) continue;
    const parsed = parseFamilyMediaRef(ref);
    if (!parsed) { out.set(ref, null); continue; }
    if (parsed.kind === 'external') { out.set(ref, parsed.url); continue; }
    out.set(ref, null); // until signing proves otherwise
    const waiting = byPath.get(parsed.path);
    if (waiting) waiting.push(ref); else byPath.set(parsed.path, [ref]);
  }
  if (byPath.size === 0) return out;

  try {
    const { data, error } = await client.storage
      .from(FAMILY_MEDIA_BUCKET)
      .createSignedUrls([...byPath.keys()], ttlSeconds);
    if (error || !Array.isArray(data)) return out;
    for (const item of data) {
      if (!item || item.error || typeof item.path !== 'string' || typeof item.signedUrl !== 'string' || !item.signedUrl) continue;
      for (const ref of byPath.get(item.path) ?? []) out.set(ref, item.signedUrl);
    }
  } catch {
    // A thrown transport error is a failed signing like any other: nothing
    // renders, and nothing falls back.
  }
  return out;
}
