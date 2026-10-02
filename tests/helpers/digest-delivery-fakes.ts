// Test doubles for lib/admin/digest-delivery.ts. Synthetic data only; nothing
// here talks to a database or a mail provider.
//
// MemoryDigestDeliveryStore applies the engine's own transition rules, each in
// one synchronous critical section, which is how it is atomic. It proves the
// RULES and the engine's use of them. It proves nothing about PostgreSQL:
// durability, isolation and the database clock are the adapter's to meet
// (docs/admin-digest-delivery-contract.md), and the same contract suite
// (tests/helpers/digest-delivery-store-contract.ts) must pass against it, with
// the database's clock made to follow the test's clock (for example: the SQL
// reads time only through one function the local test harness can pin).
import { createHash } from 'node:crypto';
import {
  decideBeginSend, decideClaim, decideCompletion, superAdminTableKey,
  type Admission, type BeginSendPolicy, type ClaimPolicy, type ClaimRefusal, type DeliveryRow, type DigestDeliveryStore, type DigestEmailProvider,
  type FrozenOccurrence, type ProviderSendResult, type StoredOccurrence,
} from '@/lib/admin/digest-delivery';

// ── A clock the test moves ─────────────────────────────────────────────────

export class FakeClock {
  private t: number;
  constructor(iso: string) { this.t = Date.parse(iso); }
  now = (): Date => new Date(this.t);
  set(iso: string) { this.t = Date.parse(iso); }
  advance(ms: number) { this.t += ms; }
}

export const HOUR = 60 * 60 * 1000;
export const MINUTE = 60 * 1000;

/** A promise that never settles: a process that stopped at this line. */
export const never = () => new Promise<never>(() => {});

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

// ── Store ──────────────────────────────────────────────────────────────────

type Method = 'freeze' | 'load' | 'claim' | 'beginSend' | 'complete';
/** Runs before a method's critical section ('before') or after it committed ('after'). Throw to fail; hang to crash. */
export type StoreHook = (method: Method, phase: 'before' | 'after', recipientKey: string | null) => void | Promise<void>;

type Snapshot = { occurrences: [string, FrozenOccurrence][]; rows: [string, DeliveryRow][] };

const rowKey = (occurrenceId: string, recipientKey: string) => `${occurrenceId}\u0000${recipientKey}`;
const copy = <T>(v: T): T => structuredClone(v);

export class MemoryDigestDeliveryStore implements DigestDeliveryStore {
  private occurrences = new Map<string, FrozenOccurrence>();
  private rows = new Map<string, DeliveryRow>();
  hooks: StoreHook[] = [];
  readonly calls: { method: Method; recipientKey: string | null }[] = [];

  /**
   * `superAdmins`: the store's super_admins table as it stands now (raw addresses). It is read inside
   * beginSend's critical section, as 0474 reads the table after the row lock. A throw is an unreadable
   * table: the call fails and writes nothing.
   */
  constructor(private readonly clock: () => Date, private readonly superAdmins: () => Iterable<string> = () => []) {}

  /** Saved state, as text: what a restarted process would find. */
  snapshot(): string {
    return JSON.stringify({ occurrences: [...this.occurrences], rows: [...this.rows] } satisfies Snapshot);
  }

  static restore(text: string, clock: () => Date, superAdmins: () => Iterable<string> = () => []): MemoryDigestDeliveryStore {
    const s = JSON.parse(text) as Snapshot;
    const store = new MemoryDigestDeliveryStore(clock, superAdmins);
    store.occurrences = new Map(s.occurrences);
    store.rows = new Map(s.rows);
    return store;
  }

  /** Direct view for assertions; never used by the engine. */
  row(occurrenceId: string, recipientKey: string): DeliveryRow | undefined {
    const r = this.rows.get(rowKey(occurrenceId, recipientKey));
    return r && copy(r);
  }

  /** Test-only corruption, to prove the engine checks what it is about to send. */
  tamper(occurrenceId: string, recipientKey: string, change: (r: DeliveryRow) => void) {
    const r = this.rows.get(rowKey(occurrenceId, recipientKey));
    if (r) change(r);
  }

  private async hook(method: Method, phase: 'before' | 'after', recipientKey: string | null) {
    if (phase === 'before') this.calls.push({ method, recipientKey });
    for (const h of this.hooks) await h(method, phase, recipientKey);
  }

  private stored(occurrenceId: string): StoredOccurrence | null {
    const occurrence = this.occurrences.get(occurrenceId);
    if (!occurrence) return null;
    const deliveries = occurrence.recipientKeys.map((k) => this.rows.get(rowKey(occurrenceId, k))!).filter(Boolean);
    return copy({ occurrence, deliveries });
  }

  async freeze(occurrence: FrozenOccurrence, deliveries: DeliveryRow[]) {
    await this.hook('freeze', 'before', null);
    // ── critical section ──
    const id = occurrence.occurrenceId;
    let created = false;
    if (!this.occurrences.has(id)) {
      const keys = new Set(occurrence.recipientKeys);
      if (deliveries.length !== keys.size || deliveries.some((d) => d.occurrenceId !== id || !keys.has(d.recipientKey))) {
        throw new Error('freeze: deliveries do not match the occurrence');
      }
      this.occurrences.set(id, copy(occurrence));
      for (const d of deliveries) this.rows.set(rowKey(id, d.recipientKey), copy(d));
      created = true;
    }
    const out = { ...this.stored(id)!, created };
    // ── end ──
    await this.hook('freeze', 'after', null);
    return out;
  }

  async load(occurrenceId: string) {
    await this.hook('load', 'before', null);
    const out = this.stored(occurrenceId);
    await this.hook('load', 'after', null);
    return out;
  }

  async claim(occurrenceId: string, recipientKey: string, owner: string, policy: ClaimPolicy) {
    await this.hook('claim', 'before', recipientKey);
    // ── critical section ──
    const k = rowKey(occurrenceId, recipientKey);
    const row = this.rows.get(k);
    let out: { claimed: true; row: DeliveryRow } | { claimed: false; reason: ClaimRefusal };
    if (!row) out = { claimed: false, reason: 'not_found' };
    else {
      const d = decideClaim(copy(row), this.clock(), owner, policy);
      if (d.next) this.rows.set(k, copy(d.next));
      out = d.claimed ? { claimed: true, row: copy(d.next) } : { claimed: false, reason: d.reason };
    }
    // ── end ──
    await this.hook('claim', 'after', recipientKey);
    return out;
  }

  async beginSend(occurrenceId: string, recipientKey: string, fence: number, policy: BeginSendPolicy, admission: Admission) {
    await this.hook('beginSend', 'before', recipientKey);
    // ── critical section ──
    const k = rowKey(occurrenceId, recipientKey);
    const row = this.rows.get(k);
    const fenced = !row || row.status !== 'in_flight' || row.fence !== fence;
    // Like 0474: a live claim's admission always reads the table, so an unreadable one always fails it.
    const listed = !fenced && [...this.superAdmins()].some((a) => superAdminTableKey(a) === recipientKey);
    const eligible = fenced || admission.allowlisted || listed;
    const d = row ? decideBeginSend(copy(row), fence, this.clock(), policy, eligible) : { ok: false as const, reason: 'fenced_out' as const, next: null };
    if (d.next) this.rows.set(k, copy(d.next));
    // ── end ──
    await this.hook('beginSend', 'after', recipientKey);
    return d.ok ? { ok: true as const, dispatchBy: d.dispatchBy } : { ok: false as const, reason: d.reason };
  }

  async complete(occurrenceId: string, recipientKey: string, fence: number, result: ProviderSendResult, maxAttempts: number) {
    await this.hook('complete', 'before', recipientKey);
    const k = rowKey(occurrenceId, recipientKey);
    const row = this.rows.get(k);
    const next = row ? decideCompletion(copy(row), fence, result, this.clock(), maxAttempts) : null;
    if (next) this.rows.set(k, next);
    await this.hook('complete', 'after', recipientKey);
    return next ? 'ok' as const : 'fenced_out' as const;
  }
}

// ── Provider: Resend's documented idempotency semantics, and nothing else ──
//
// https://resend.com/docs/dashboard/emails/idempotency-keys (re-checked 2026-09-30):
// - the same key with the same payload returns the ORIGINAL response, and
//   nothing new is sent;
// - the same key with a different payload is 409 invalid_idempotent_request;
// - the same key while the first request is still being processed is 409
//   concurrent_idempotent_requests;
// - keys are kept for 24 hours; after that the key is new again.
// What happens to a key on a refused request is undocumented; this fake keeps
// keys for ACCEPTED requests only.

export type Behaviour =
  | { do: 'accept' }
  | { do: 'reject'; status: number; code: string; retryable: boolean }
  /** Accepted and delivered, but the answer never reaches the sender (a timeout after acceptance). */
  | { do: 'accept_then_lose_answer'; reason?: 'timeout' | 'network' | 'server_error' }
  /** Lost before the provider saw it. */
  | { do: 'lose_before_arrival'; reason?: 'timeout' | 'network' }
  /** Arrives (the key is now in flight at the provider) and waits for `until` before being processed as `then`. */
  | { do: 'hold_at_provider'; until: Promise<void>; then: Behaviour }
  /** Waits for `until` before it reaches the provider at all: a slow network. */
  | { do: 'delay_before_arrival'; until: Promise<void>; then: Behaviour }
  /** A 2xx without a message id. */
  | { do: 'accept_without_id' }
  | { do: 'throw' };

export type Delivered = { to: string; key: string; payloadJson: string; messageId: string; at: string };

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

export class FakeResendProvider implements DigestEmailProvider {
  /** Messages that reached an inbox. */
  readonly inbox: Delivered[] = [];
  /** Every request that left the sender, whatever became of it. */
  readonly requests: { to: string; key: string; payloadJson: string }[] = [];
  private keys = new Map<string, { hash: string; messageId: string; storedAt: number }>();
  private inFlight = new Set<string>();
  /** Behaviour per request; the default is to accept. */
  script: (req: { to: string; key: string; n: number }) => Behaviour = () => ({ do: 'accept' });
  /** Runs when a request arrives, before it is processed: assertions about what was persisted first. */
  onArrive: ((req: { to: string; key: string; payloadJson: string }) => void) | null = null;

  constructor(private readonly clock: () => Date, private readonly retentionMs = 24 * HOUR) {}

  async send(req: { idempotencyKey: string; payload: { to: string }; payloadJson: string; signal: AbortSignal }): Promise<ProviderSendResult> {
    const to = req.payload.to;
    const n = this.requests.filter((r) => r.to === to).length + 1;
    this.requests.push({ to, key: req.idempotencyKey, payloadJson: req.payloadJson });
    return this.act(this.script({ to, key: req.idempotencyKey, n }), req.idempotencyKey, to, req.payloadJson);
  }

  private async act(b: Behaviour, key: string, to: string, payloadJson: string): Promise<ProviderSendResult> {
    switch (b.do) {
      case 'lose_before_arrival': return { kind: 'unknown', reason: b.reason ?? 'network' };
      case 'throw': throw new Error('synthetic transport failure');
      case 'delay_before_arrival': await b.until; return this.act(b.then, key, to, payloadJson);
      case 'hold_at_provider': {
        this.onArrive?.({ to, key, payloadJson });
        if (this.inFlight.has(key)) return { kind: 'in_progress' };
        this.inFlight.add(key);
        try { await b.until; } finally { this.inFlight.delete(key); }
        return this.process(b.then, key, to, payloadJson, true);
      }
      default:
        this.onArrive?.({ to, key, payloadJson });
        if (this.inFlight.has(key)) return { kind: 'in_progress' };
        return this.process(b, key, to, payloadJson, false);
    }
  }

  private process(b: Behaviour, key: string, to: string, payloadJson: string, arrived: boolean): ProviderSendResult {
    void arrived;
    const now = this.clock().getTime();
    const known = this.keys.get(key);
    if (known && now - known.storedAt >= this.retentionMs) this.keys.delete(key);
    const live = this.keys.get(key);
    if (live) return live.hash === hash(payloadJson) ? { kind: 'accepted', messageId: live.messageId } : { kind: 'payload_conflict' };
    switch (b.do) {
      case 'reject': return { kind: 'rejected', httpStatus: b.status, code: b.code, retryable: b.retryable };
      case 'accept_without_id': return { kind: 'accepted', messageId: '' };
      case 'accept': case 'accept_then_lose_answer': {
        const messageId = `msg-${this.inbox.length + 1}`;
        this.keys.set(key, { hash: hash(payloadJson), messageId, storedAt: now });
        this.inbox.push({ to, key, payloadJson, messageId, at: this.clock().toISOString() });
        return b.do === 'accept' ? { kind: 'accepted', messageId } : { kind: 'unknown', reason: b.reason ?? 'timeout' };
      }
      default: return this.process({ do: 'accept' }, key, to, payloadJson, arrived);
    }
  }

  /** Test-only: a key used earlier for other bytes (e.g. by the sender this engine replaces). */
  preuse(key: string, payloadJson: string) {
    this.keys.set(key, { hash: hash(payloadJson), messageId: 'msg-earlier', storedAt: this.clock().getTime() });
  }

  deliveredTo(to: string) { return this.inbox.filter((d) => d.to === to).length; }
}
