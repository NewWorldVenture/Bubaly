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
//             be told apart: no mark means nothing reached the provider.
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
//                        │   └──claim── failed   (a definitive refusal; nothing was accepted)
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

/** The beginSend rule: fenced. `null` means the caller's claim is no longer current and it must not send. */
export function decideBeginSend(row: DeliveryRow, fence: number, now: Date): DeliveryRow | null {
  if (row.status !== 'in_flight' || row.fence !== fence) return null;
  const nowIso = now.toISOString();
  return { ...row, sendStartedAt: nowIso, firstSendAt: row.firstSendAt ?? nowIso, updatedAt: nowIso };
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

/** The complete rule: fenced. `null` means the caller's claim is no longer current and nothing may be written. */
export function decideCompletion(row: DeliveryRow, fence: number, result: ProviderSendResult, now: Date, maxAttempts: number): DeliveryRow | null {
  if (row.status !== 'in_flight' || row.fence !== fence) return null;
  const nowIso = now.toISOString();
  const next: DeliveryRow = { ...row, leaseOwner: null, leaseExpiresAt: null, sendStartedAt: null, updatedAt: nowIso };
  switch (result.kind) {
    case 'accepted':
      return { ...next, status: 'accepted', providerMessageId: result.messageId, lastError: null };
    case 'payload_conflict':
      return { ...next, status: 'conflict', lastError: 'provider_payload_conflict' };
    case 'rejected':
      next.lastError = clip(`provider_rejected:${result.httpStatus}:${result.code}`);
      // A refusal cannot undo an earlier attempt that may have been accepted.
      if (!result.retryable) { next.status = next.ambiguous ? 'needs_reconciliation' : 'rejected'; return next; }
      next.status = 'failed';
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
  /** Apply `decideBeginSend` atomically. */
  beginSend(occurrenceId: string, recipientKey: string, fence: number): Promise<'ok' | 'fenced_out'>;
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
  /** Whether the outcome is durable. `receipt_write_failed`: the provider answered but the store did not record it. */
  recorded: 'ok' | 'fenced_out' | 'receipt_write_failed' | 'not_sent';
  detail?: string;
};

export type OccurrenceReport = {
  occurrenceId: string;
  /** This call stored the plan. False: a plan was already stored, and IT was used. */
  created: boolean;
  /** The caller's plan differs from the stored one; the stored one was used and the difference is reported, not merged. */
  planMismatch: null | { recipientsAdded: number; recipientsRemoved: number; payloadChanged: boolean };
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
  return recipientsAdded || recipientsRemoved || payloadChanged ? { recipientsAdded, recipientsRemoved, payloadChanged } : null;
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
    let marked: 'ok' | 'fenced_out';
    try {
      marked = await store.beginSend(id, key, row.fence);
    } catch {
      report.storageErrors.push({ stage: 'beginSend', recipientKey: key });
      continue;
    }
    if (marked !== 'ok') {
      report.attempts.push({ recipientKey: key, fence: row.fence, result: 'not_sent', recorded: 'fenced_out' });
      continue;
    }
    const result = await sendWithDeadline(deps.provider, row, config.sendTimeoutMs);
    let recorded: 'ok' | 'fenced_out';
    try {
      recorded = await store.complete(id, key, row.fence, result, config.maxAttempts);
    } catch {
      // The provider answered, but nothing durable says so. The row stays in flight
      // with its mark; after the lease it is retried under the same key and bytes.
      report.storageErrors.push({ stage: 'complete', recipientKey: key });
      report.attempts.push({ recipientKey: key, fence: row.fence, result: result.kind, recorded: 'receipt_write_failed' });
      continue;
    }
    report.attempts.push({ recipientKey: key, fence: row.fence, result: result.kind, recorded });
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

async function sendWithDeadline(provider: DigestEmailProvider, row: DeliveryRow, ms: number): Promise<ProviderSendResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ProviderSendResult>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve({ kind: 'unknown', reason: 'timeout' }); }, ms);
  });
  // A provider that throws, even synchronously, settles nothing: the request may have left.
  const attempt = Promise.resolve()
    .then(() => provider.send({ idempotencyKey: row.idempotencyKey, payload: { ...row.payload }, payloadJson: row.payloadJson, signal: controller.signal }))
    .then(checkResult, (): ProviderSendResult => ({ kind: 'unknown', reason: 'network' }));
  try {
    return await Promise.race([attempt, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Only a success WITH a message id is an accepted receipt; anything malformed settles nothing. */
function checkResult(r: ProviderSendResult): ProviderSendResult {
  if (!r || typeof r !== 'object') return { kind: 'unknown', reason: 'unreadable_response' };
  switch (r.kind) {
    case 'accepted': return typeof r.messageId === 'string' && r.messageId.length > 0 ? r : { kind: 'unknown', reason: 'unreadable_response' };
    case 'rejected': return Number.isInteger(r.httpStatus) && typeof r.retryable === 'boolean' ? { ...r, code: String(r.code ?? '') } : { kind: 'unknown', reason: 'unreadable_response' };
    case 'payload_conflict': case 'in_progress': case 'unknown': return r;
    default: return { kind: 'unknown', reason: 'unreadable_response' };
  }
}
