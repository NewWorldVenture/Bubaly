// Per-recipient delivery engine for the daily Super Admin digest.
//
// NOT WIRED INTO ANY ROUTE. /api/cron/admin-digest still sends the way it did;
// this module is the delivery half of the durable design, published on its own
// so its rules can be reviewed and proven before any storage or route change.
// docs/admin-digest-delivery-contract.md is the integration contract: what a
// caller passes in, what a database adapter must guarantee, and what a
// provider adapter must classify.
//
// The caller owns scheduling. It decides the occurrence (its stable id and its
// window), reads the recipients (failing closed when that read fails, as #685
// does) and renders the payload. This engine takes those as a FROZEN plan and
// owns only delivery:
//
// - freeze    the plan is stored, one row per recipient, with the recipient's
//             stable idempotency key and the exact bytes that will be sent,
//             BEFORE anything is sent. A plan already stored for the occurrence
//             wins over a new one: a retry re-sends the original payload, never
//             a recomputed one, so a reused key never meets a changed payload.
// - claim     one atomic step per recipient, under a lease, with a fence that
//             grows on every claim. Two engines never both hold a recipient.
// - beginSend a fenced mark, written before the provider call, so a crash can
//             be told apart: no mark means nothing reached the provider. It is
//             refused once the lease has too little time left for the send, or
//             once an ambiguous row is past the retention cut-off, so a worker
//             that stalled after its claim cannot send late. A granted mark
//             carries a DISPATCH DEADLINE, and the engine re-reads the time
//             after the store answers and does not send once it has passed: a
//             mark whose answer arrived late cannot send late either.
// - complete  the provider's answer, fenced: a worker whose lease was taken over
//             writes nothing.
//
// What it guarantees, and no more:
// - a recipient whose delivery was CONFIRMED accepted (a success with a message
//   id) is never sent again;
// - every retry of a recipient uses the same key and the same bytes;
// - an outcome that is unknown (a timeout, a lost receipt, a worker that died
//   after it may have sent) is retried only while the provider still remembers
//   the key; after that the recipient is parked for reconciliation, because a
//   retry the provider no longer deduplicates could deliver twice;
// - a payload conflict (the key already used for other bytes) is never retried
//   and never escaped by changing the key.
// It is NOT exactly-once. The provider's key deduplication is what makes a
// retry after an unknown outcome harmless, and only inside the retention window.
// Nor does an in-memory store prove anything about PostgreSQL durability; the
// adapter requirements in the contract are what a real store must meet.

import { createHash } from 'node:crypto';

export const DIGEST_DELIVERY_ENGINE_VERSION = 1;

/**
 * How long Resend remembers an idempotency key: 24 hours (docs re-checked
 * 2026-09-30, https://resend.com/docs/dashboard/emails/idempotency-keys).
 * Re-verify before changing providers or this value.
 */
export const RESEND_KEY_RETENTION_MS = 24 * 60 * 60 * 1000;

// ── Plan ────────────────────────────────────────────────────────────────────

/** The occurrence-wide part of the email. Non-secret by construction: no headers, no credentials. */
export type DigestPayload = { from: string; subject: string; html: string };
/** What one recipient is sent, byte for byte (see `payloadJson`). */
export type DeliveryPayload = { from: string; to: string; subject: string; html: string };

export type OccurrencePlan = {
  /** Chosen by the caller and stable across retries of the same occurrence, e.g. `admin-digest:2026-09-30T12:30:00.000Z`. */
  occurrenceId: string;
  /** Recorded, not interpreted: which window of activity this digest covers. */
  window: { start: string; end: string };
  /** Frozen by the caller from a read that succeeded (#685 fails closed before this point). */
  recipients: readonly string[];
  payload: DigestPayload;
};

export type FrozenOccurrence = {
  occurrenceId: string;
  window: { start: string; end: string };
  /** Sorted. */
  recipientKeys: string[];
  /** sha256 of the canonical occurrence payload; a changed payload changes this. */
  payloadHash: string;
  engineVersion: number;
};

// ── Delivery rows and their state machine ───────────────────────────────────
//
//   pending ──claim──▶ in_flight ──complete──▶ accepted                 (terminal)
//                        │   ▲                 rejected                 (terminal)
//                        │   │                 conflict                 (terminal)
//                        │   └──claim── failed   (a definitive refusal, and nothing was ever possibly accepted)
//                        │   └──claim── unknown  (might have been accepted; ambiguous)
//                        │
//                        └─ lease expires: back to pending/failed (no beginSend mark) or unknown (marked)
//
//   exhausted             attempts used up, nothing ever possibly accepted  (terminal)
//   needs_reconciliation  possibly accepted, and retrying is no longer safe  (terminal)

export type DeliveryStatus =
  | 'pending' | 'in_flight' | 'failed' | 'unknown'
  | 'accepted' | 'rejected' | 'conflict' | 'exhausted' | 'needs_reconciliation';

export const TERMINAL_STATUSES: readonly DeliveryStatus[] = ['accepted', 'rejected', 'conflict', 'exhausted', 'needs_reconciliation'];
export const isTerminal = (s: DeliveryStatus) => TERMINAL_STATUSES.includes(s);

export type DeliveryRow = {
  occurrenceId: string;
  /** sha256 hex of the normalized address: stable, and free of the address itself. */
  recipientKey: string;
  /** Derived from (occurrence, recipient) only. Never rotated. */
  idempotencyKey: string;
  payload: DeliveryPayload;
  /** The exact request body. Stored, and sent verbatim. */
  payloadJson: string;
  /** sha256 hex of `payloadJson`. */
  payloadHash: string;
  status: DeliveryStatus;
  /** Claims so far. */
  attempts: number;
  /** Grows by one on every claim; `beginSend` and `complete` must present the current value. */
  fence: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  /** Set by `beginSend` for the CURRENT claim: the provider may have been called. */
  sendStartedAt: string | null;
  /** The first time any attempt may have reached the provider: the retention window's anchor. */
  firstSendAt: string | null;
  /** Sticky: some attempt may have been accepted without a receipt. */
  ambiguous: boolean;
  providerMessageId: string | null;
  /** Classified and non-secret. */
  lastError: string | null;
  updatedAt: string;
};

export type ClaimPolicy = {
  leaseMs: number;
  maxAttempts: number;
  /** How long the provider remembers a key (RESEND_KEY_RETENTION_MS). */
  providerKeyRetentionMs: number;
  /** Stop ambiguous retries this long before the provider can forget the key: covers clock skew and the send itself. */
  retentionSafetyMarginMs: number;
};

export type ClaimRefusal = 'leased' | 'not_found' | Exclude<DeliveryStatus, 'pending' | 'in_flight' | 'failed' | 'unknown'>;

export type ClaimDecision =
  | { claimed: true; next: DeliveryRow }
  /** `next` is set when the refusal itself is a transition the store must persist (a parked or exhausted row). */
  | { claimed: false; reason: ClaimRefusal; next: DeliveryRow | null };

const MAX_ERROR = 200;
const clip = (s: string) => s.slice(0, MAX_ERROR);
const plusMs = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

/**
 * The claim rule. A store MUST evaluate it and persist `next` in ONE atomic
 * step, with its own clock as `now` (a database adapter: the database's now(),
 * never a caller's timestamp).
 */
export function decideClaim(row: DeliveryRow, now: Date, owner: string, policy: ClaimPolicy): ClaimDecision {
  if (isTerminal(row.status)) return { claimed: false, reason: row.status as ClaimRefusal, next: null };
  const nowIso = now.toISOString();
  const next: DeliveryRow = { ...row };
  if (next.status === 'in_flight') {
    if (next.leaseExpiresAt !== null && Date.parse(next.leaseExpiresAt) > now.getTime()) {
      return { claimed: false, reason: 'leased', next: null };
    }
    // The worker died or stalled. With a beginSend mark it may have reached the
    // provider; without one it cannot have, because the mark precedes the call.
    if (next.sendStartedAt !== null) {
      next.ambiguous = true;
      next.status = 'unknown';
      next.lastError = 'lease_expired_after_send_started';
    } else {
      next.status = next.ambiguous ? 'unknown' : next.attempts > 1 ? 'failed' : 'pending';
      next.lastError = 'lease_expired_before_send';
    }
    next.leaseOwner = null;
    next.leaseExpiresAt = null;
    next.sendStartedAt = null;
  }
  const park = (status: 'exhausted' | 'needs_reconciliation'): ClaimDecision => {
    next.status = status;
    next.updatedAt = nowIso;
    return { claimed: false, reason: status, next };
  };
  if (next.attempts >= policy.maxAttempts) return park(next.ambiguous ? 'needs_reconciliation' : 'exhausted');
  if (next.ambiguous) {
    // Anchor on the FIRST attempt that may have reached the provider: its key
    // window can have started no later than that.
    // A row marked ambiguous with no anchor is inconsistent: nothing says it is still safe.
    if (next.firstSendAt === null) return park('needs_reconciliation');
    const lastSafe = Date.parse(next.firstSendAt) + policy.providerKeyRetentionMs - policy.retentionSafetyMarginMs;
    if (now.getTime() >= lastSafe) return park('needs_reconciliation');
  }
  next.status = 'in_flight';
  next.attempts += 1;
  next.fence += 1;
  next.leaseOwner = owner;
  next.leaseExpiresAt = plusMs(nowIso, policy.leaseMs);
  next.sendStartedAt = null;
  next.updatedAt = nowIso;
  return { claimed: true, next };
}

export type BeginSendPolicy = Pick<ClaimPolicy, 'providerKeyRetentionMs' | 'retentionSafetyMarginMs'> & {
  /** The send may start only while at least this much lease is left: the engine's send deadline. */
  minLeaseRemainingMs: number;
};

export type BeginSendDecision =
  /** `dispatchBy`: the provider call must START before this instant (see decideBeginSend). */
  | { ok: true; next: DeliveryRow; dispatchBy: string }
  /**
   * `fenced_out`: another claim superseded this one. `lease_expired`: too little lease left to finish
   * the send before another worker could claim; the row is left for the next claim. `retention_passed`:
   * an ambiguous row reached the cut-off after it was claimed; it is parked in `next`.
   */
  | { ok: false; reason: 'fenced_out' | 'lease_expired' | 'retention_passed'; next: DeliveryRow | null };

/**
 * The beginSend rule: fenced, and re-checked at the last moment before the
 * provider call. A store MUST evaluate it and persist `next` in one atomic
 * step, with its own clock. Only `ok` permits a send.
 */
export function decideBeginSend(row: DeliveryRow, fence: number, now: Date, policy: BeginSendPolicy): BeginSendDecision {
  if (row.status !== 'in_flight' || row.fence !== fence) return { ok: false, reason: 'fenced_out', next: null };
  const nowIso = now.toISOString();
  if (row.leaseExpiresAt === null || Date.parse(row.leaseExpiresAt) - now.getTime() <= policy.minLeaseRemainingMs) {
    return { ok: false, reason: 'lease_expired', next: null };
  }
  if (row.ambiguous) {
    const lastSafe = row.firstSendAt === null ? -Infinity : Date.parse(row.firstSendAt) + policy.providerKeyRetentionMs - policy.retentionSafetyMarginMs;
    if (now.getTime() >= lastSafe) {
      return {
        ok: false, reason: 'retention_passed',
        next: { ...row, status: 'needs_reconciliation', leaseOwner: null, leaseExpiresAt: null, sendStartedAt: null, updatedAt: nowIso },
      };
    }
  }
  const next = { ...row, sendStartedAt: nowIso, firstSendAt: row.firstSendAt ?? nowIso, updatedAt: nowIso };
  // Start the call no later than this, so it ends (within the send deadline) while the lease still
  // holds; and, when an earlier attempt may have been accepted, so it reaches the provider before it
  // can forget the key (the margin covers the send itself). A row that was only ever definitively
  // refused has nothing to duplicate, so only the lease bounds it.
  const byLease = Date.parse(row.leaseExpiresAt) - policy.minLeaseRemainingMs;
  const byRetention = row.ambiguous ? Date.parse(next.firstSendAt) + policy.providerKeyRetentionMs - policy.retentionSafetyMarginMs : Infinity;
  return { ok: true, next, dispatchBy: new Date(Math.min(byLease, byRetention)).toISOString() };
}

// ── Provider ────────────────────────────────────────────────────────────────

/** What a provider adapter must answer. Only `accepted` (with a message id) proves delivery. */
export type ProviderSendResult =
  | { kind: 'accepted'; messageId: string }
  /** The provider answered and did NOT accept. `retryable`: the same bytes may succeed later (a rate limit, a fixed configuration). */
  | { kind: 'rejected'; httpStatus: number; code: string; retryable: boolean }
  /** The key was already used for different bytes. Never retried, never re-keyed. */
  | { kind: 'payload_conflict' }
  /** A request under this key is still being processed. Its outcome is unknown. */
  | { kind: 'in_progress' }
  /** No answer that settles it: the provider may or may not have accepted. */
  | { kind: 'unknown'; reason: 'timeout' | 'network' | 'unreadable_response' | 'server_error' };

export interface DigestEmailProvider {
  send(request: { idempotencyKey: string; payload: DeliveryPayload; payloadJson: string; signal: AbortSignal }): Promise<ProviderSendResult>;
}

/**
 * Resend's answers, classified (docs re-checked 2026-09-30). The future HTTP
 * adapter feeds its response here; #692's `sendEmail` answers only `{ ok }`,
 * which cannot tell a payload conflict or a message id apart, so it is not
 * enough on its own. See the contract.
 */
export function classifyResendResponse(status: number, body: unknown): ProviderSendResult {
  const b = (body && typeof body === 'object' ? body : {}) as { id?: unknown; name?: unknown };
  const name = typeof b.name === 'string' ? b.name : '';
  if (status >= 200 && status < 300) {
    return typeof b.id === 'string' && b.id.length > 0
      ? { kind: 'accepted', messageId: b.id }
      : { kind: 'unknown', reason: 'unreadable_response' };
  }
  if (status === 409 && name === 'invalid_idempotent_request') return { kind: 'payload_conflict' };
  if (status === 409 && name === 'concurrent_idempotent_requests') return { kind: 'in_progress' };
  if (status === 409) return { kind: 'unknown', reason: 'unreadable_response' };
  if (status === 429) return { kind: 'rejected', httpStatus: status, code: name || 'rate_limited', retryable: true };
  // A missing or revoked key, or an unverified domain: nothing was accepted, and an operator can fix it.
  if (status === 401 || status === 403) return { kind: 'rejected', httpStatus: status, code: name || 'unauthorized', retryable: true };
  if (status >= 400 && status < 500) return { kind: 'rejected', httpStatus: status, code: name || 'invalid_request', retryable: false };
  // A 5xx may come after the provider accepted: it settles nothing.
  if (status >= 500) return { kind: 'unknown', reason: 'server_error' };
  return { kind: 'unknown', reason: 'unreadable_response' };
}

/**
 * The complete rule: fenced, and only after a mark. `null` means nothing may be written: the claim is
 * no longer current, or it never marked a send (so no provider answer can belong to it).
 */
export function decideCompletion(row: DeliveryRow, fence: number, result: ProviderSendResult, now: Date, maxAttempts: number): DeliveryRow | null {
  if (row.status !== 'in_flight' || row.fence !== fence || row.sendStartedAt === null) return null;
  const nowIso = now.toISOString();
  const next: DeliveryRow = { ...row, leaseOwner: null, leaseExpiresAt: null, sendStartedAt: null, updatedAt: nowIso };
  switch (result.kind) {
    case 'accepted':
      // A receipt needs a message id the store can hold whole; without one nothing is settled.
      if (!isStorableMessageId(result.messageId)) {
        next.ambiguous = true; next.status = 'unknown'; next.lastError = 'outcome_unknown:unreadable_response';
        break;
      }
      return { ...next, status: 'accepted', providerMessageId: result.messageId, lastError: null };
    case 'payload_conflict':
      return { ...next, status: 'conflict', lastError: 'provider_payload_conflict' };
    case 'rejected':
      next.lastError = clip(`provider_rejected:${result.httpStatus}:${result.code}`);
      // A refusal cannot undo an earlier attempt that may have been accepted.
      if (!result.retryable) { next.status = next.ambiguous ? 'needs_reconciliation' : 'rejected'; return next; }
      // Still retryable, but an earlier attempt may have been accepted: it stays unknown, not "failed".
      next.status = next.ambiguous ? 'unknown' : 'failed';
      break;
    case 'in_progress':
      next.ambiguous = true; next.status = 'unknown'; next.lastError = 'provider_in_progress';
      break;
    case 'unknown':
      next.ambiguous = true; next.status = 'unknown'; next.lastError = clip(`outcome_unknown:${result.reason}`);
      break;
  }
  if (next.attempts >= maxAttempts) next.status = next.ambiguous ? 'needs_reconciliation' : 'exhausted';
  return next;
}

// ── Storage ─────────────────────────────────────────────────────────────────

export type StoredOccurrence = { occurrence: FrozenOccurrence; deliveries: DeliveryRow[] };

export type BeginSendAnswer =
  | { ok: true; dispatchBy: string }
  | { ok: false; reason: 'fenced_out' | 'lease_expired' | 'retention_passed' };

/**
 * What a store must provide. Each method is ONE atomic step against durable
 * state, and every lease or retention decision uses the store's clock.
 * docs/admin-digest-delivery-contract.md gives the exact database requirements.
 */
export interface DigestDeliveryStore {
  /** Create the occurrence and all of its deliveries if absent, all or nothing. Return what is stored either way. */
  freeze(occurrence: FrozenOccurrence, deliveries: DeliveryRow[]): Promise<StoredOccurrence & { created: boolean }>;
  load(occurrenceId: string): Promise<StoredOccurrence | null>;
  /** Apply `decideClaim` atomically. */
  claim(occurrenceId: string, recipientKey: string, owner: string, policy: ClaimPolicy): Promise<{ claimed: true; row: DeliveryRow } | { claimed: false; reason: ClaimRefusal }>;
  /** Apply `decideBeginSend` atomically (persisting `next` when set); a granted mark returns its dispatch deadline. */
  beginSend(occurrenceId: string, recipientKey: string, fence: number, policy: BeginSendPolicy): Promise<BeginSendAnswer>;
  /** Apply `decideCompletion` atomically. */
  complete(occurrenceId: string, recipientKey: string, fence: number, result: ProviderSendResult, maxAttempts: number): Promise<'ok' | 'fenced_out'>;
}

// ── Keys and payloads ───────────────────────────────────────────────────────

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export const normalizeRecipient = (address: string) => address.trim().toLowerCase();
export const recipientKeyOf = (address: string) => sha256(normalizeRecipient(address));

/**
 * The stable key: a function of (occurrence, recipient) and nothing else, so no
 * attempt count, clock or payload can change it. Hashes keep the address out of
 * a header the provider stores. Fits #692's rule: printable ASCII, 1–256.
 */
export function idempotencyKeyFor(occurrenceId: string, recipientKey: string): string {
  return `bubaly/admin-digest/v${DIGEST_DELIVERY_ENGINE_VERSION}/${sha256(occurrenceId).slice(0, 32)}/${recipientKey.slice(0, 32)}`;
}

/** Fixed key order, so the same payload is always the same bytes. */
export const payloadJsonOf = (p: DeliveryPayload) => JSON.stringify({ from: p.from, to: p.to, subject: p.subject, html: p.html });

/**
 * 0471's bounds, in PostgreSQL characters (code points, what `length(text)` counts). The engine
 * admits nothing the store would refuse: the stored bytes are checked before anything is stored,
 * and a provider id the store could not hold whole is not a receipt (it is never truncated).
 */
export const MAX_PAYLOAD_JSON_CHARS = 600_000;
export const MAX_PROVIDER_MESSAGE_ID_CHARS = 200;
export function pgLength(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}
export function isStorableMessageId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length === 0) return false;
  let length = 0;
  // JSON can encode NUL and lone UTF-16 surrogates, but PostgreSQL jsonb/text cannot.
  // Iteration combines valid pairs, so supplementary Unicode remains one character.
  for (const character of id) {
    const point = character.codePointAt(0)!;
    if (point === 0 || (point >= 0xd800 && point <= 0xdfff) || ++length > MAX_PROVIDER_MESSAGE_ID_CHARS) return false;
  }
  return true;
}
const occurrencePayloadHash = (p: DigestPayload) => sha256(JSON.stringify({ from: p.from, subject: p.subject, html: p.html }));

// ── Validation (before any storage call or send) ────────────────────────────

const MAX_RECIPIENTS = 200;
const MAX_HTML_BYTES = 512 * 1024;
const EMAIL = /^[^\s@<>()",;:\\[\]]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const PRINTABLE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;
const LINE_BREAK = /[\r\n\u2028\u2029]/;

function planError(msg: string): never { throw new TypeError(`digest-delivery: ${msg}`); }

export function validatePlan(plan: OccurrencePlan): void {
  if (typeof plan.occurrenceId !== 'string' || plan.occurrenceId.length > 200 || !PRINTABLE.test(plan.occurrenceId)) planError('occurrenceId must be 1–200 printable ASCII characters');
  const start = Date.parse(plan.window?.start); const end = Date.parse(plan.window?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) planError('window must be two ISO instants, start before end');
  if (!Array.isArray(plan.recipients) || plan.recipients.length === 0) planError('recipients must be a non-empty frozen list; an empty or unreadable list is the caller\'s to refuse');
  if (plan.recipients.length > MAX_RECIPIENTS) planError(`at most ${MAX_RECIPIENTS} recipients`);
  const seen = new Set<string>();
  for (const r of plan.recipients) {
    if (typeof r !== 'string' || !EMAIL.test(normalizeRecipient(r))) planError('every recipient must be one plain email address');
    const k = normalizeRecipient(r);
    if (seen.has(k)) planError('recipients must be distinct');
    seen.add(k);
  }
  const p = plan.payload as Record<string, unknown>;
  const keys = p && typeof p === 'object' ? Object.keys(p).sort() : [];
  if (keys.join(',') !== 'from,html,subject') planError('payload must be exactly { from, subject, html }: nothing else is stored or sent');
  if (typeof p.from !== 'string' || !p.from.trim() || LINE_BREAK.test(p.from)) planError('payload.from must be one line');
  if (typeof p.subject !== 'string' || !p.subject.trim() || LINE_BREAK.test(p.subject)) planError('payload.subject must be one non-empty line');
  if (typeof p.html !== 'string' || !p.html.trim() || Buffer.byteLength(p.html, 'utf8') > MAX_HTML_BYTES) planError('payload.html must be non-empty and at most 512 KiB');
}

export type EngineConfig = ClaimPolicy & { sendTimeoutMs: number };

export function validateConfig(c: EngineConfig): void {
  const pos = (n: number) => Number.isFinite(n) && n > 0;
  if (!pos(c.leaseMs) || !pos(c.sendTimeoutMs) || !pos(c.providerKeyRetentionMs) || !pos(c.retentionSafetyMarginMs)) planError('durations must be positive');
  if (!Number.isInteger(c.maxAttempts) || c.maxAttempts < 1) planError('maxAttempts must be a positive integer');
  // A lease that can lapse mid-send lets a second worker claim while the first is still sending.
  if (c.leaseMs <= c.sendTimeoutMs) planError('leaseMs must exceed sendTimeoutMs');
  // The last safe retry must reach the provider before it forgets the key.
  if (c.retentionSafetyMarginMs <= c.sendTimeoutMs) planError('retentionSafetyMarginMs must exceed sendTimeoutMs');
  if (c.retentionSafetyMarginMs >= c.providerKeyRetentionMs) planError('retentionSafetyMarginMs must be shorter than the retention window');
  // A worker that dies after its mark leaves the row locked until its lease lapses. The
  // lease must lapse inside the retry window, or every such crash parks the row.
  if (c.leaseMs >= c.providerKeyRetentionMs - c.retentionSafetyMarginMs) planError('leaseMs must be shorter than the retry window (retention minus margin)');
  // Never assume the provider remembers a key longer than its documentation says.
  if (c.providerKeyRetentionMs > RESEND_KEY_RETENTION_MS) planError('providerKeyRetentionMs cannot exceed the verified 24 h');
}

/** Frozen form of a validated plan: what `freeze` stores. Pure. */
export function freezePlan(plan: OccurrencePlan, now: Date): { occurrence: FrozenOccurrence; deliveries: DeliveryRow[] } {
  validatePlan(plan);
  const nowIso = now.toISOString();
  const deliveries = plan.recipients.map(normalizeRecipient).sort().map((to): DeliveryRow => {
    const recipientKey = recipientKeyOf(to);
    const payload: DeliveryPayload = { from: plan.payload.from, to, subject: plan.payload.subject, html: plan.payload.html };
    const payloadJson = payloadJsonOf(payload);
    return {
      occurrenceId: plan.occurrenceId, recipientKey, idempotencyKey: idempotencyKeyFor(plan.occurrenceId, recipientKey),
      payload, payloadJson, payloadHash: sha256(payloadJson), status: 'pending', attempts: 0, fence: 0,
      leaseOwner: null, leaseExpiresAt: null, sendStartedAt: null, firstSendAt: null, ambiguous: false,
      providerMessageId: null, lastError: null, updatedAt: nowIso,
    };
  }).sort((a, b) => (a.recipientKey < b.recipientKey ? -1 : 1));
  for (const d of deliveries) {
    if (pgLength(d.payloadJson) > MAX_PAYLOAD_JSON_CHARS) planError(`the stored bytes must be at most ${MAX_PAYLOAD_JSON_CHARS} characters (0471's bound)`);
  }
  return {
    occurrence: {
      occurrenceId: plan.occurrenceId, window: { start: new Date(plan.window.start).toISOString(), end: new Date(plan.window.end).toISOString() },
      recipientKeys: deliveries.map((d) => d.recipientKey), payloadHash: occurrencePayloadHash(plan.payload), engineVersion: DIGEST_DELIVERY_ENGINE_VERSION,
    },
    deliveries,
  };
}

// ── Engine ──────────────────────────────────────────────────────────────────

export type EngineDeps = {
  store: DigestDeliveryStore;
  provider: DigestEmailProvider;
  /** Unique per engine instance or run; informational (the fence is what protects). */
  owner: string;
  config: EngineConfig;
  /** For the report and the freeze timestamp only. Leases and retention use the store's clock. */
  now: () => Date;
};

export type AttemptReport = {
  recipientKey: string;
  fence: number;
  result: ProviderSendResult['kind'] | 'not_sent';
  /**
   * Whether the outcome is durable. `receipt_write_unconfirmed`: the provider answered but the store
   * did not confirm the write (it may or may not have committed; the next run finds out).
   */
  recorded: 'ok' | 'fenced_out' | 'receipt_write_unconfirmed' | 'not_sent';
  /** The provider's message id, whenever it accepted, even if the receipt could not be recorded. */
  messageId?: string;
  detail?: string;
};

export type OccurrenceReport = {
  occurrenceId: string;
  /** This call stored the plan. False: a plan was already stored, and IT was used. */
  created: boolean;
  /** The caller's plan differs from the stored one; the stored one was used and the difference is reported, not merged. */
  planMismatch: null | { recipientsAdded: number; recipientsRemoved: number; payloadChanged: boolean; windowChanged: boolean };
  attempts: AttemptReport[];
  refused: { recipientKey: string; reason: ClaimRefusal }[];
  storageErrors: { stage: 'freeze' | 'load' | 'claim' | 'beginSend' | 'complete' | 'final_load'; recipientKey?: string }[];
  /** From a final read; null when that read failed. */
  statuses: Record<string, DeliveryStatus> | null;
  /** Every recipient confirmed accepted. */
  complete: boolean;
  /** Parked rows a person must look at. */
  needsAttention: { recipientKey: string; status: DeliveryStatus }[];
};

const ATTENTION: readonly DeliveryStatus[] = ['rejected', 'conflict', 'exhausted', 'needs_reconciliation'];

/** Freeze (or load) the occurrence, then deliver to every recipient still owed. */
export async function deliverDigestOccurrence(plan: OccurrencePlan, deps: EngineDeps): Promise<OccurrenceReport> {
  validateConfig(deps.config);
  const frozen = freezePlan(plan, deps.now());
  const report = emptyReport(plan.occurrenceId);
  let stored: StoredOccurrence & { created: boolean };
  try {
    stored = await deps.store.freeze(frozen.occurrence, frozen.deliveries);
  } catch {
    report.storageErrors.push({ stage: 'freeze' });
    return report;
  }
  report.created = stored.created;
  report.planMismatch = mismatch(frozen.occurrence, stored.occurrence);
  return run(stored, deps, report);
}

/** Continue an occurrence from saved state alone: no plan is recomputed. */
export async function resumeDigestOccurrence(occurrenceId: string, deps: EngineDeps): Promise<OccurrenceReport> {
  validateConfig(deps.config);
  const report = emptyReport(occurrenceId);
  let stored: StoredOccurrence | null;
  try {
    stored = await deps.store.load(occurrenceId);
  } catch {
    report.storageErrors.push({ stage: 'load' });
    return report;
  }
  if (!stored) { report.refused.push({ recipientKey: '*', reason: 'not_found' }); return report; }
  return run(stored, deps, report);
}

function emptyReport(occurrenceId: string): OccurrenceReport {
  return { occurrenceId, created: false, planMismatch: null, attempts: [], refused: [], storageErrors: [], statuses: null, complete: false, needsAttention: [] };
}

function mismatch(wanted: FrozenOccurrence, stored: FrozenOccurrence): OccurrenceReport['planMismatch'] {
  const have = new Set(stored.recipientKeys);
  const want = new Set(wanted.recipientKeys);
  const recipientsAdded = [...want].filter((k) => !have.has(k)).length;
  const recipientsRemoved = [...have].filter((k) => !want.has(k)).length;
  const payloadChanged = wanted.payloadHash !== stored.payloadHash;
  const windowChanged = wanted.window.start !== stored.window.start || wanted.window.end !== stored.window.end;
  return recipientsAdded || recipientsRemoved || payloadChanged || windowChanged
    ? { recipientsAdded, recipientsRemoved, payloadChanged, windowChanged } : null;
}

async function run(stored: StoredOccurrence, deps: EngineDeps, report: OccurrenceReport): Promise<OccurrenceReport> {
  const { store, config } = deps;
  const id = stored.occurrence.occurrenceId;
  for (const delivery of [...stored.deliveries].sort((a, b) => (a.recipientKey < b.recipientKey ? -1 : 1))) {
    if (isTerminal(delivery.status)) continue;
    const key = delivery.recipientKey;
    let claim: Awaited<ReturnType<DigestDeliveryStore['claim']>>;
    try {
      claim = await store.claim(id, key, deps.owner, config);
    } catch {
      report.storageErrors.push({ stage: 'claim', recipientKey: key });
      continue;
    }
    if (!claim.claimed) { report.refused.push({ recipientKey: key, reason: claim.reason }); continue; }
    const row = claim.row;
    // Send only what the store holds, and only if it is still what was frozen.
    if (sha256(row.payloadJson) !== row.payloadHash || payloadJsonOf(row.payload) !== row.payloadJson
      || row.idempotencyKey !== idempotencyKeyFor(id, key) || recipientKeyOf(row.payload.to) !== key) {
      // Not sent. Every later claim meets the same mismatch, so the row runs out of
      // attempts (exhausted: nothing reached the provider) unless a person repairs it.
      report.attempts.push({ recipientKey: key, fence: row.fence, result: 'not_sent', recorded: 'not_sent', detail: 'stored_payload_integrity_failed' });
      continue;
    }
    let marked: BeginSendAnswer;
    try {
      marked = await store.beginSend(id, key, row.fence, {
        minLeaseRemainingMs: config.sendTimeoutMs,
        providerKeyRetentionMs: config.providerKeyRetentionMs,
        retentionSafetyMarginMs: config.retentionSafetyMarginMs,
      });
    } catch {
      report.storageErrors.push({ stage: 'beginSend', recipientKey: key });
      continue;
    }
    if (!marked.ok) {
      report.attempts.push({ recipientKey: key, fence: row.fence, result: 'not_sent', recorded: marked.reason === 'fenced_out' ? 'fenced_out' : 'not_sent', detail: marked.reason });
      continue;
    }
    // The store's answer may have arrived late, and other queued work may run before the call. The time
    // is re-read inside sendWithDeadline, in the same synchronous step as the provider call: past the
    // deadline, the lease may be gone or the provider may forget the key, so the send does not happen.
    // The row keeps its mark and is treated as possibly sent (the safe side).
    const dispatchBy = Date.parse(marked.dispatchBy);
    const result = await sendWithDeadline(deps.provider, row, config.sendTimeoutMs, () => deps.now().getTime() < dispatchBy);
    if (result === NOT_DISPATCHED) {
      report.attempts.push({ recipientKey: key, fence: row.fence, result: 'not_sent', recorded: 'not_sent', detail: 'dispatch_deadline_passed' });
      continue;
    }
    let recorded: 'ok' | 'fenced_out';
    try {
      recorded = await store.complete(id, key, row.fence, result, config.maxAttempts);
    } catch {
      // The provider answered, but nothing durable says so. The row stays in flight
      // with its mark; after the lease it is retried under the same key and bytes.
      report.storageErrors.push({ stage: 'complete', recipientKey: key });
      report.attempts.push({ recipientKey: key, fence: row.fence, result: result.kind, recorded: 'receipt_write_unconfirmed', ...messageIdOf(result) });
      continue;
    }
    report.attempts.push({ recipientKey: key, fence: row.fence, result: result.kind, recorded, ...messageIdOf(result) });
  }
  try {
    const final = await store.load(id);
    if (final) {
      report.statuses = Object.fromEntries(final.deliveries.map((d) => [d.recipientKey, d.status]));
      report.complete = final.deliveries.length > 0 && final.deliveries.every((d) => d.status === 'accepted');
      report.needsAttention = final.deliveries.filter((d) => ATTENTION.includes(d.status)).map((d) => ({ recipientKey: d.recipientKey, status: d.status }));
    }
  } catch {
    report.storageErrors.push({ stage: 'final_load' });
  }
  return report;
}

const NOT_DISPATCHED = Symbol('not_dispatched');

/**
 * `admitted` and `provider.send` run in one synchronous step, with no await between them, so no
 * other queued work can spend the admission budget after the check. The deadline starts with the call.
 */
async function sendWithDeadline(provider: DigestEmailProvider, row: DeliveryRow, ms: number, admitted: () => boolean): Promise<ProviderSendResult | typeof NOT_DISPATCHED> {
  if (!admitted()) return NOT_DISPATCHED;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ProviderSendResult>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve({ kind: 'unknown', reason: 'timeout' }); }, ms);
  });
  // A provider that throws, even synchronously, settles nothing: the request may have left.
  let sent: Promise<ProviderSendResult>;
  try {
    sent = Promise.resolve(provider.send({ idempotencyKey: row.idempotencyKey, payload: { ...row.payload }, payloadJson: row.payloadJson, signal: controller.signal }));
  } catch {
    sent = Promise.resolve({ kind: 'unknown', reason: 'network' });
  }
  const attempt = sent.then(checkResult, (): ProviderSendResult => ({ kind: 'unknown', reason: 'network' }));
  try {
    return await Promise.race([attempt, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const messageIdOf = (r: ProviderSendResult) => (r.kind === 'accepted' ? { messageId: r.messageId } : {});

/** Only a success WITH a message id is an accepted receipt; anything malformed settles nothing. */
function checkResult(r: ProviderSendResult): ProviderSendResult {
  if (!r || typeof r !== 'object') return { kind: 'unknown', reason: 'unreadable_response' };
  switch (r.kind) {
    case 'accepted': return isStorableMessageId(r.messageId) ? r : { kind: 'unknown', reason: 'unreadable_response' };
    // A refusal is a 4xx: an adapter that calls a 5xx or a 2xx "rejected" has settled nothing.
    case 'rejected': return Number.isInteger(r.httpStatus) && r.httpStatus >= 400 && r.httpStatus < 500 && typeof r.retryable === 'boolean'
      ? { ...r, code: String(r.code ?? '') } : { kind: 'unknown', reason: 'unreadable_response' };
    case 'payload_conflict': case 'in_progress': case 'unknown': return r;
    default: return { kind: 'unknown', reason: 'unreadable_response' };
  }
}
