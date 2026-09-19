import { isChunkLike, parseCookieHeader, stringFromBase64URL, stringToBase64URL } from '@supabase/ssr';

/** Comparison metadata only. Provider verification remains authentication authority. */
export type CallbackAdmissionWitness = {
  v: 1; project: string; generation: string; verifier: string; session: string;
};
export type CallbackAdmissionMaterial = Omit<CallbackAdmissionWitness, 'v'>;
type Cookie = { name: string; value: string };
const HASH = /^[a-f0-9]{64}$/;
const KEYS = ['v', 'project', 'generation', 'verifier', 'session'];
const canonical = (cookies: readonly Cookie[]) => [...cookies].sort((a, b) => a.name.localeCompare(b.name));

/** Preserve duplicate paths/names which the SDK's whole-header parser collapses. */
export function parseCallbackAdmissionCookies(header: string | null): Cookie[] | null {
  if (header !== null && (typeof header !== 'string' || header.length > 1024 * 1024)) return null;
  const parts = (header ?? '').split(';');
  if (parts.length > 4096) return null;
  try { return parts.flatMap(part => parseCookieHeader(part).map(({ name, value }) => ({ name, value: value ?? '' }))); }
  catch { return null; }
}

function sessionOwner(cookies: Cookie[], key: string): { userId: string; sessionId: string } | null {
  try {
    const parts = cookies.filter(cookie => isChunkLike(cookie.name, key));
    const whole = parts.find(cookie => cookie.name === key);
    if (!parts.length || (whole && parts.length !== 1)) return null;
    let encoded = whole?.value ?? '';
    if (!whole) for (let index = 0; index < parts.length; index++) {
      const part = parts.find(cookie => cookie.name === `${key}.${index}`);
      if (!part?.value) return null;
      encoded += part.value;
    }
    const value = JSON.parse(encoded.startsWith('base64-') ? stringFromBase64URL(encoded.slice(7)) : encoded);
    const userId = value?.user?.id;
    const token = value?.access_token;
    if (typeof userId !== 'string' || !userId || userId.length > 256 || typeof token !== 'string' || token.length > 65_536) return null;
    const claims = JSON.parse(stringFromBase64URL(token.split('.')[1]));
    return claims?.sub === userId && typeof claims.session_id === 'string' && claims.session_id.length > 0 && claims.session_id.length <= 128
      ? { userId, sessionId: claims.session_id } : null;
  } catch { return null; }
}

/** Canonical bounded inputs shared by request capture and browser comparison. */
export function callbackAdmissionMaterial(cookies: readonly Cookie[], storageKey: string): CallbackAdmissionMaterial | null {
  if (!/^sb-[A-Za-z0-9_-]+-auth-token$/.test(storageKey) || storageKey.length > 256) return null;
  const session = canonical(cookies.filter(cookie => isChunkLike(cookie.name, storageKey) || isChunkLike(cookie.name, `${storageKey}-user`)));
  const verifier = canonical(cookies.filter(cookie => isChunkLike(cookie.name, `${storageKey}-code-verifier`)));
  const generation = canonical(cookies.filter(cookie => cookie.name === `${storageKey}-logout-generation`));
  for (const parts of [session, verifier]) {
    if (parts.length > 128 || parts.some(part => typeof part.value !== 'string')
      || parts.reduce((size, part) => size + part.value.length, 0) > 256 * 1024
      || new Set(parts.map(part => part.name)).size !== parts.length) return null;
  }
  if (generation.length > 1 || generation.some(part => typeof part.value !== 'string' || part.value.length > 1024)) return null;
  if (verifier.length) {
    const key = `${storageKey}-code-verifier`;
    const whole = verifier.find(part => part.name === key);
    if (whole ? verifier.length !== 1 || !whole.value
      : verifier.some((_, index) => !verifier.some(part => part.name === `${key}.${index}` && part.value))) return null;
  }
  const identity = sessionOwner(session, storageKey);
  return {
    project: storageKey,
    generation: JSON.stringify(generation),
    verifier: JSON.stringify(verifier),
    session: identity ? JSON.stringify({ kind: 'identity', ...identity }) : JSON.stringify({ kind: 'cookies', cookies: session }),
  };
}

export function encodeCallbackAdmissionWitness(witness: CallbackAdmissionWitness): string {
  return stringToBase64URL(JSON.stringify({ v: witness.v, project: witness.project, generation: witness.generation,
    verifier: witness.verifier, session: witness.session }));
}

/** A supplied malformed witness is never replaced with a newer request snapshot. */
export function parseCallbackAdmissionWitness(value: unknown): CallbackAdmissionWitness | null {
  if (typeof value !== 'string' || !value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = JSON.parse(stringFromBase64URL(value));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || Object.keys(decoded).length !== KEYS.length
      || KEYS.some(key => !Object.hasOwn(decoded, key)) || decoded.v !== 1
      || KEYS.slice(1).some(key => typeof decoded[key] !== 'string' || !HASH.test(decoded[key]))) return null;
    const witness = decoded as CallbackAdmissionWitness;
    return encodeCallbackAdmissionWitness(witness) === value ? witness : null;
  } catch { return null; }
}
