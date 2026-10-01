// The PostgreSQL DigestDeliveryStore: a thin, strict mapping onto the five
// functions of migration 0471 (admin_digest_freeze, _load, _claim, _begin_send,
// _complete). Every rule lives in the database, evaluated under a row lock with
// the database clock; this file only translates arguments and checks the shape
// of what comes back, so a malformed answer fails loudly instead of being read
// as a claim or a receipt.
//
// NOT WIRED INTO ANY ROUTE. The transport is injected: `supabaseRpc(client)`
// for a service-role Supabase client (later), or the psql transport the
// disposable-database tests use (tests/helpers/digest-delivery-postgres.ts).
import {
  MAX_PROVIDER_MESSAGE_ID_CHARS, payloadJsonOf, pgLength,
  type Admission, type BeginSendPolicy, type ClaimPolicy, type ClaimRefusal, type DeliveryPayload, type DeliveryRow, type DeliveryStatus,
  type DigestDeliveryStore, type FrozenOccurrence, type ProviderSendResult, type StoredOccurrence,
} from '@/lib/admin/digest-delivery';

/** Calls one database function with named arguments and resolves to its JSON result; rejects on any error. */
export type RpcCall = (fn: string, args: Record<string, unknown>) => Promise<unknown>;

type RpcClient = { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };

/** The production transport: a SERVICE-ROLE client (the functions are not executable by anon or authenticated). */
export function supabaseRpc(client: RpcClient): RpcCall {
  return async (fn, args) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`digest-delivery store: ${fn} failed`, { cause: error });
    return data;
  };
}

const STATUSES: readonly DeliveryStatus[] = ['pending', 'in_flight', 'failed', 'unknown', 'accepted', 'rejected', 'conflict', 'exhausted', 'needs_reconciliation', 'withdrawn'];
const REFUSALS: readonly string[] = ['leased', 'not_found', 'accepted', 'rejected', 'conflict', 'exhausted', 'needs_reconciliation', 'withdrawn'];
const BEGIN_REFUSALS = ['fenced_out', 'lease_expired', 'retention_passed', 'withdrawn'] as const;

function bad(what: string): never { throw new Error(`digest-delivery store: malformed ${what} from the database`); }
const obj = (v: unknown, what: string) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : bad(what));
const str = (v: unknown, what: string) => (typeof v === 'string' ? v : bad(what));
const int = (v: unknown, what: string) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : bad(what));
/** Database timestamps come back as `2026-09-30T12:31:00.123456+00:00`; the engine speaks `toISOString()`. */
const iso = (v: unknown, what: string) => {
  const t = Date.parse(str(v, what));
  return Number.isFinite(t) ? new Date(t).toISOString() : bad(what);
};
const isoOrNull = (v: unknown, what: string) => (v === null ? null : iso(v, what));
const strOrNull = (v: unknown, what: string) => (v === null ? null : str(v, what));

function parsePayload(json: string): DeliveryPayload {
  let p: unknown;
  try { p = JSON.parse(json); } catch { return bad('payload_json'); }
  const o = obj(p, 'payload');
  const payload = { from: str(o.from, 'payload.from'), to: str(o.to, 'payload.to'), subject: str(o.subject, 'payload.subject'), html: str(o.html, 'payload.html') };
  // The stored text must be exactly the engine's serialization of the same fields.
  return payloadJsonOf(payload) === json ? payload : bad('payload_json (not canonical)');
}

export function parseDeliveryRow(v: unknown): DeliveryRow {
  const r = obj(v, 'delivery');
  const status = str(r.status, 'status') as DeliveryStatus;
  if (!STATUSES.includes(status)) bad('status');
  if (typeof r.ambiguous !== 'boolean') bad('ambiguous');
  const payloadJson = str(r.payloadJson, 'payloadJson');
  return {
    occurrenceId: str(r.occurrenceId, 'occurrenceId'),
    recipientKey: str(r.recipientKey, 'recipientKey'),
    idempotencyKey: str(r.idempotencyKey, 'idempotencyKey'),
    payload: parsePayload(payloadJson),
    payloadJson,
    payloadHash: str(r.payloadHash, 'payloadHash'),
    status,
    attempts: int(r.attempts, 'attempts'),
    fence: int(r.fence, 'fence'),
    leaseOwner: strOrNull(r.leaseOwner, 'leaseOwner'),
    leaseExpiresAt: isoOrNull(r.leaseExpiresAt, 'leaseExpiresAt'),
    sendStartedAt: isoOrNull(r.sendStartedAt, 'sendStartedAt'),
    firstSendAt: isoOrNull(r.firstSendAt, 'firstSendAt'),
    ambiguous: r.ambiguous,
    providerMessageId: strOrNull(r.providerMessageId, 'providerMessageId'),
    lastError: strOrNull(r.lastError, 'lastError'),
    updatedAt: iso(r.updatedAt, 'updatedAt'),
  };
}

function parseStored(v: unknown): StoredOccurrence {
  const s = obj(v, 'occurrence');
  const o = obj(s.occurrence, 'occurrence');
  const w = obj(o.window, 'window');
  const keys = Array.isArray(o.recipientKeys) ? o.recipientKeys.map((k) => str(k, 'recipientKeys')) : bad('recipientKeys');
  const occurrence: FrozenOccurrence = {
    occurrenceId: str(o.occurrenceId, 'occurrenceId'),
    window: { start: iso(w.start, 'window.start'), end: iso(w.end, 'window.end') },
    recipientKeys: keys,
    payloadHash: str(o.payloadHash, 'payloadHash'),
    engineVersion: int(o.engineVersion, 'engineVersion'),
  };
  const deliveries = Array.isArray(s.deliveries) ? s.deliveries.map(parseDeliveryRow) : bad('deliveries');
  if (deliveries.length !== keys.length || deliveries.some((d, i) => d.recipientKey !== keys[i] || d.occurrenceId !== occurrence.occurrenceId)) bad('deliveries (do not match the occurrence)');
  return { occurrence, deliveries };
}

const ms = (n: number, what: string) => (Number.isSafeInteger(Math.round(n)) && n >= 0 ? Math.round(n) : bad(what));
/** A fence is a count: a stale one is answered fenced_out by the database; a non-integer (null included) is never sent. */
const fenceArg = (f: unknown) => {
  if (typeof f === 'number' && Number.isSafeInteger(f) && f >= 0) return f;
  throw new TypeError('digest-delivery store: a fence must be a non-negative integer');
};

export function createPostgresDigestDeliveryStore(rpc: RpcCall): DigestDeliveryStore {
  return {
    async freeze(occurrence, deliveries) {
      const out = obj(await rpc('admin_digest_freeze', {
        p_occurrence: occurrence,
        // Only identity and bytes travel: the database starts every row pending, on its own clock.
        p_deliveries: deliveries.map((d) => ({
          occurrenceId: d.occurrenceId, recipientKey: d.recipientKey, idempotencyKey: d.idempotencyKey,
          payloadJson: d.payloadJson, payloadHash: d.payloadHash,
        })),
      }), 'freeze');
      if (typeof out.created !== 'boolean') bad('freeze.created');
      return { ...parseStored(out), created: out.created };
    },

    async load(occurrenceId) {
      const out = await rpc('admin_digest_load', { p_occurrence_id: occurrenceId });
      return out === null ? null : parseStored(out);
    },

    async claim(occurrenceId, recipientKey, owner, policy: ClaimPolicy) {
      const out = obj(await rpc('admin_digest_claim', {
        p_occurrence_id: occurrenceId, p_recipient_key: recipientKey, p_owner: owner,
        p_lease_ms: ms(policy.leaseMs, 'leaseMs'), p_max_attempts: policy.maxAttempts,
        p_retention_ms: ms(policy.providerKeyRetentionMs, 'retention'), p_margin_ms: ms(policy.retentionSafetyMarginMs, 'margin'),
      }), 'claim');
      if (out.claimed === true) {
        const row = parseDeliveryRow(out.row);
        if (row.status !== 'in_flight' || row.leaseOwner !== owner) bad('claim.row');
        return { claimed: true, row };
      }
      const reason = str(out.reason, 'claim.reason');
      if (out.claimed !== false || !REFUSALS.includes(reason)) bad('claim');
      return { claimed: false, reason: reason as ClaimRefusal };
    },

    async beginSend(occurrenceId, recipientKey, fence, policy: BeginSendPolicy, admission: Admission) {
      // 0474: the database adds super_admins, read after the row lock; only a real boolean is sent.
      if (typeof admission?.allowlisted !== 'boolean') throw new TypeError('digest-delivery store: admission.allowlisted must be a boolean');
      const out = await rpc('admin_digest_begin_send', {
        p_occurrence_id: occurrenceId, p_recipient_key: recipientKey, p_fence: fenceArg(fence),
        p_min_lease_ms: ms(policy.minLeaseRemainingMs, 'minLease'),
        p_retention_ms: ms(policy.providerKeyRetentionMs, 'retention'), p_margin_ms: ms(policy.retentionSafetyMarginMs, 'margin'),
        p_allowlisted: admission.allowlisted,
      });
      const a = obj(out, 'begin_send');
      if (a.answer === 'ok') return { ok: true, dispatchBy: iso(a.dispatchBy, 'begin_send.dispatchBy') };
      return (BEGIN_REFUSALS as readonly unknown[]).includes(a.answer) && a.dispatchBy === undefined
        ? { ok: false, reason: a.answer as typeof BEGIN_REFUSALS[number] } : bad('begin_send');
    },

    async complete(occurrenceId, recipientKey, fence, result: ProviderSendResult, maxAttempts) {
      // 0471 would truncate a longer id; a receipt is never altered, so it is never sent. (An empty id
      // is sent: 0471, like decideCompletion, records it as unknown, not as a receipt.)
      if (result.kind === 'accepted' && typeof result.messageId === 'string' && pgLength(result.messageId) > MAX_PROVIDER_MESSAGE_ID_CHARS) {
        throw new TypeError(`digest-delivery store: an accepted message id must be 1-${MAX_PROVIDER_MESSAGE_ID_CHARS} characters`);
      }
      const out = await rpc('admin_digest_complete', {
        p_occurrence_id: occurrenceId, p_recipient_key: recipientKey, p_fence: fenceArg(fence), p_result: result, p_max_attempts: maxAttempts,
      });
      return out === 'ok' || out === 'fenced_out' ? out : bad('complete');
    },
  };
}
