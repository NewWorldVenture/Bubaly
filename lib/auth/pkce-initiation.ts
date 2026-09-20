import { stringFromBase64URL, stringToBase64URL } from '@supabase/ssr';
import { encodeCallbackAdmissionWitness, parseCallbackAdmissionWitness, type CallbackAdmissionWitness } from './callback-witness';

export type PkceInitiationKind = 'signup' | 'oauth' | 'recovery';
/** Comparison metadata only; provider verification remains authentication authority. */
export type PkceInitiationRecord = CallbackAdmissionWitness & { nonce: string; kind: PkceInitiationKind };
export type PkceInitiationSlot = { raw: string | null; record: PkceInitiationRecord | null };

const KEYS = ['v', 'project', 'generation', 'verifier', 'session', 'nonce', 'kind'];
const MAX_LENGTH = 1024;

export function isPkceInitiationNonce(value: unknown): value is string {
  return typeof value === 'string' && value.length === 32 && /^[a-f0-9]{32}$/.test(value);
}

export function pkceInitiationCookieName(storageKey: string): string {
  if (typeof storageKey !== 'string' || storageKey.length > 256 || /^sb-[A-Za-z0-9_-]+-auth-token$/.exec(storageKey)?.[0] !== storageKey) {
    throw new Error('Invalid auth storage key');
  }
  return `${storageKey}-pkce-initiation`;
}

function isRecord(value: unknown): value is PkceInitiationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== KEYS.length
    || KEYS.some(key => !Object.hasOwn(value, key))) return false;
  const record = value as PkceInitiationRecord;
  return isPkceInitiationNonce(record.nonce)
    && (record.kind === 'signup' || record.kind === 'oauth' || record.kind === 'recovery')
    && [record.project, record.generation, record.verifier, record.session].every(hash => typeof hash === 'string' && hash.length === 64)
    && parseCallbackAdmissionWitness(encodeCallbackAdmissionWitness(record)) !== null;
}

export function encodePkceInitiationRecord(record: PkceInitiationRecord): string {
  if (!isRecord(record)) throw new Error('Invalid PKCE initiation record');
  return stringToBase64URL(JSON.stringify({ v: record.v, project: record.project, generation: record.generation,
    verifier: record.verifier, session: record.session, nonce: record.nonce, kind: record.kind }));
}

/** Supplied malformed or noncanonical metadata must never acquire a newer owner. */
export function parsePkceInitiationRecord(value: unknown): PkceInitiationRecord | null {
  if (typeof value !== 'string' || !value || value.length > MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const record: unknown = JSON.parse(stringFromBase64URL(value));
    if (!isRecord(record)) return null;
    return encodePkceInitiationRecord(record) === value ? record : null;
  } catch { return null; }
}

/** Preserve a bounded malformed slot for an explicitly new, compare-before-write attempt. */
export function readPkceInitiationSlot(cookies: readonly { name: string; value: string }[], storageKey: string): PkceInitiationSlot | null {
  let name: string;
  try { name = pkceInitiationCookieName(storageKey); } catch { return null; }
  if (!Array.isArray(cookies) || cookies.some(cookie => !cookie || typeof cookie.name !== 'string')) return null;
  const matching = cookies.filter(cookie => cookie.name === name || cookie.name.startsWith(`${name}.`));
  if (!matching.length) return { raw: null, record: null };
  if (matching.length !== 1 || matching[0].name !== name || typeof matching[0].value !== 'string'
    || matching[0].value.length > MAX_LENGTH) return null;
  const raw = matching[0].value;
  return { raw, record: parsePkceInitiationRecord(raw) };
}
