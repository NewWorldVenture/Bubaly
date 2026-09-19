import 'server-only';
import { createHash } from 'node:crypto';
import { callbackAdmissionMaterial, encodeCallbackAdmissionWitness, parseCallbackAdmissionCookies } from './callback-witness';

type Cookie = { name: string; value: string };

/** Hash request-owned comparison data only; never exchange or publish cookies. */
export function captureCallbackAdmissionWitness(cookies: readonly Cookie[]): string | null {
  try {
    const raw = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim();
    const url = new URL(/^(["']).*\1$/.test(raw) ? raw.slice(1, -1).trim() : raw);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) return null;
    const material = callbackAdmissionMaterial(cookies, `sb-${url.hostname.split('.')[0]}-auth-token`);
    if (!material) return null;
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    return encodeCallbackAdmissionWitness({ v: 1, project: digest(material.project), generation: digest(material.generation),
      verifier: digest(material.verifier), session: digest(material.session) });
  } catch { return null; }
}

/** Capture synchronously from the original route request before yielding. */
export function captureCallbackRequestWitness(cookieHeader: string | null): string | null {
  try {
    const cookies = parseCallbackAdmissionCookies(cookieHeader);
    return cookies ? captureCallbackAdmissionWitness(cookies) : null;
  } catch { return null; }
}
