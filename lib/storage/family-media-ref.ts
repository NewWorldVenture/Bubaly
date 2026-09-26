import { FAMILY_MEDIA_BUCKET } from './family-media';

// A stored reference to family media, and the one way to turn it into
// something an <img> may load. (SEC-001)
//
// `family-media` was created public (0216), so writers stored the result of
// `getPublicUrl` in family_photos.url, family_messages.attachment_url,
// family_reminders.image_url and families.cover_url, and closet/inventory
// rendered `getPublicUrl(photo_path)` on the fly. A public URL is readable by
// anyone who has it, for ever: proven by execution, an unauthenticated GET of a
// family photo returned 200 and its bytes, while the RLS policy that says
// "family members can read their media" was never consulted.
//
// The stored values are NOT rewritten. A stored public URL is treated as a
// reference — the object path it names — and every reader resolves it through
// `signFamilyMediaRefs`, which asks Storage for a short-lived signed URL. That
// request is authorized by the storage.objects SELECT policy
// (`is_family_member` of the path's first segment), so a member of the family
// gets a URL and nobody else does, whether the bucket is public or private.
// Once every reader signs, the bucket can be made private (0338) and a stored
// public URL stops being a way in.
//
// Three rules, each of which the obvious shortcut breaks:
//   * A reference to this bucket that cannot be signed resolves to NOTHING,
//     never to the stored public URL. Falling back would keep the bytes on the
//     open internet exactly as long as the bucket stays public, and blank the
//     image the day it does not, so the failure would be invisible until then.
//   * A signed URL is never persisted. It is a bearer credential with an
//     expiry; written into a row it would outlive both, and realtime/offline
//     caches keep rows for days.
//   * External media (a GIF picked in Messages, an album cover pasted from the
//     web) is not ours to sign and passes through, but only as http(s): a
//     `javascript:` or `data:` value is not an image reference.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_PREFIX = /^\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/;

/** Signed URLs last an hour: long enough for a session, never long enough to keep. */
export const FAMILY_MEDIA_SIGNED_TTL_SECONDS = 60 * 60;

export type FamilyMediaRef =
  | { kind: 'object'; path: string }
  | { kind: 'external'; url: string }
  | { kind: 'none' };

function objectPath(raw: string): string | null {
  const parts = raw.split('/');
  if (parts.length < 2 || !UUID.test(parts[0])) return null;
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return raw;
}

function configuredOrigin(): string | null {
  const value = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!value) return null;
  try { return new URL(value).origin; } catch { return null; }
}

/**
 * Classify a stored media value.
 *
 * `expectedOrigin` is the Supabase project the app is configured for. A storage
 * URL on that origin is ours: in `family-media` it is an object reference, and
 * in any other bucket it is left alone as external (the other public buckets —
 * avatars, marketplace photos — are public by design). With no configured
 * origin, a `/storage/v1/object/.../family-media/` path on any host is taken
 * as ours, so a missing env var fails closed rather than passing the public
 * URL through.
 */
export function parseFamilyMediaRef(
  value: string | null | undefined,
  expectedOrigin: string | null = configuredOrigin(),
): FamilyMediaRef {
  const raw = (value ?? '').trim();
  if (!raw) return { kind: 'none' };
  if (!raw.includes('://')) {
    const path = objectPath(raw);
    return path ? { kind: 'object', path } : { kind: 'none' };
  }

  let url: URL;
  try { url = new URL(raw); } catch { return { kind: 'none' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'none' };

  const match = OBJECT_PREFIX.exec(url.pathname);
  const ours = expectedOrigin ? url.origin === expectedOrigin : Boolean(match && match[1] === FAMILY_MEDIA_BUCKET);
  if (!ours || !match) return { kind: 'external', url: url.toString() };
  if (match[1] !== FAMILY_MEDIA_BUCKET) return { kind: 'external', url: url.toString() };

  let decoded: string;
  try { decoded = decodeURIComponent(match[2]); } catch { return { kind: 'none' }; }
  const path = objectPath(decoded);
  return path ? { kind: 'object', path } : { kind: 'none' };
}

/** The object path a stored value names in this bucket, or null. */
export function familyMediaObjectPath(value: string | null | undefined, expectedOrigin?: string | null): string | null {
  const ref = parseFamilyMediaRef(value, expectedOrigin === undefined ? configuredOrigin() : expectedOrigin);
  return ref.kind === 'object' ? ref.path : null;
}

type SignedUrlsResult = {
  data: { path: string | null; signedUrl: string | null; error: string | null }[] | null;
  error: unknown;
};

/** The slice of a Supabase client this needs; both the browser and server clients fit. */
export type FamilyMediaSigner = {
  storage: {
    from: (bucket: string) => {
      createSignedUrls: (paths: string[], expiresIn: number) => PromiseLike<SignedUrlsResult>;
    };
  };
};

/**
 * Resolve many stored values in one round trip.
 *
 * Returns a map from each distinct stored value to what an <img> may load: a
 * signed URL for an object in this bucket that the caller may read, the URL
 * itself for external media, and null for everything else — including a
 * reference the caller may not read, and every reference if signing fails.
 */
export async function signFamilyMediaRefs(
  supabase: FamilyMediaSigner,
  values: Iterable<string | null | undefined>,
  ttlSeconds: number = FAMILY_MEDIA_SIGNED_TTL_SECONDS,
  expectedOrigin: string | null = configuredOrigin(),
): Promise<Map<string, string | null>> {
  const resolved = new Map<string, string | null>();
  const byPath = new Map<string, string[]>();

  for (const value of values) {
    if (!value || resolved.has(value)) continue;
    const ref = parseFamilyMediaRef(value, expectedOrigin);
    if (ref.kind === 'external') { resolved.set(value, ref.url); continue; }
    resolved.set(value, null);
    if (ref.kind === 'object') byPath.set(ref.path, [...(byPath.get(ref.path) ?? []), value]);
  }
  if (byPath.size === 0) return resolved;

  let result: SignedUrlsResult;
  try {
    result = await supabase.storage.from(FAMILY_MEDIA_BUCKET).createSignedUrls([...byPath.keys()], ttlSeconds);
  } catch (error) {
    console.error('[family-media] could not sign media URLs', error);
    return resolved;
  }
  if (result.error) {
    console.error('[family-media] could not sign media URLs', result.error);
    return resolved;
  }
  for (const entry of result.data ?? []) {
    if (!entry.path || !entry.signedUrl || entry.error) continue;
    for (const value of byPath.get(entry.path) ?? []) resolved.set(value, entry.signedUrl);
  }
  return resolved;
}

/**
 * Return `rows` with each named media field replaced by what an <img> may
 * load (see `signFamilyMediaRefs`), signing every field of every row in one
 * round trip. The stored rows are not modified.
 */
export async function withSignedFamilyMedia<T extends object, K extends keyof T>(
  supabase: FamilyMediaSigner,
  rows: readonly T[],
  fields: readonly K[],
  ttlSeconds?: number,
): Promise<T[]> {
  const values: string[] = [];
  for (const row of rows) {
    for (const field of fields) {
      const value = row[field];
      if (typeof value === 'string' && value) values.push(value);
    }
  }
  if (values.length === 0) return [...rows];
  const resolved = await signFamilyMediaRefs(supabase, values, ttlSeconds);
  return rows.map((row) => {
    const next = { ...row };
    for (const field of fields) {
      const value = row[field];
      if (typeof value === 'string' && value) next[field] = (resolved.get(value) ?? null) as T[K];
    }
    return next;
  });
}

/** Sign one stored value. Prefer `signFamilyMediaRefs` for a list. */
export async function signFamilyMediaRef(
  supabase: FamilyMediaSigner,
  value: string | null | undefined,
  ttlSeconds?: number,
): Promise<string | null> {
  if (!value) return null;
  return (await signFamilyMediaRefs(supabase, [value], ttlSeconds)).get(value) ?? null;
}
