// Connections — the per-provider sync adapter contract (moat R9, Phase 4).
//
// The Connections hub (lib/connections/providers.ts) is a *directory*: it lists
// what a family can connect. R9 is the *orchestration contract* underneath it —
// the uniform shape every provider (Google Calendar, Gmail, Plaid, …) implements
// so Bubaly can pull their data into its own model and push changes back, without
// each integration reinventing sync. Live network calls need owner-gated OAuth
// keys; this file is the contract + the pure, testable logic that decides what a
// sync run should do. Adapters are registered in ./adapters.

import type { ConnectionCategory } from './providers';

/** Which way data flows for a given capability. */
export type SyncDirection = 'pull' | 'push' | 'two_way';

/** A single thing an adapter can sync, in Bubaly's vocabulary (not the vendor's). */
export type SyncResource = 'events' | 'messages' | 'transactions' | 'orders' | 'devices';

export interface SyncCapability {
  resource: SyncResource;
  direction: SyncDirection;
}

// ── Normalized shapes ───────────────────────────────────────────────────────
// Every adapter maps the vendor payload to these so the rest of the app never
// sees provider-specific fields. Ids are the *external* ids; the sync layer maps
// them to Bubaly rows.

export interface NormalizedEvent {
  externalId: string;
  title: string;
  startsAt: string;              // ISO
  endsAt?: string | null;
  location?: string | null;
  notes?: string | null;
  allDay?: boolean;
}

export interface NormalizedMessage {
  externalId: string;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: string;            // ISO
  category?: string | null;      // adapter's best guess (school, medical, …)
}

/** What the sync layer hands an adapter for a run. Tokens come from a secret
 *  store keyed by the connection, never from the DB row. */
export interface AdapterContext {
  familyId: string;
  externalAccountId: string;
  /** Resolved secret bundle; null when the provider key/OAuth isn't configured. */
  credentials: Record<string, string> | null;
  /** Incremental cursor — only fetch changes after this instant. */
  since?: string | null;
  now?: Date;
}

export interface PullResult<T> {
  items: T[];
  /** Opaque cursor to persist for the next incremental pull. */
  cursor?: string | null;
  errors: string[];
}

export interface PushResult {
  pushed: number;
  errors: string[];
}

/**
 * The contract every provider integration implements. Methods that a provider
 * doesn't support are simply omitted (guarded by `capabilities`). Implementations
 * must be side-effect-free until `credentials` are present.
 */
export interface SyncAdapter {
  readonly providerId: string;
  readonly category: ConnectionCategory;
  readonly capabilities: SyncCapability[];
  /** True only when the server has the keys/secret this provider needs. */
  isConfigured(env?: NodeJS.ProcessEnv): boolean;
  pullEvents?(ctx: AdapterContext): Promise<PullResult<NormalizedEvent>>;
  pushEvents?(ctx: AdapterContext, events: NormalizedEvent[]): Promise<PushResult>;
  pullMessages?(ctx: AdapterContext): Promise<PullResult<NormalizedMessage>>;
}

// ── Pure planning logic (testable, no I/O) ──────────────────────────────────

export type SyncBlockedReason = 'needs_setup' | 'not_connected' | 'unsupported';

export interface SyncPlan {
  providerId: string;
  runnable: boolean;
  blockedReason?: SyncBlockedReason;
  /** Resources this run would touch, with direction. */
  resources: SyncCapability[];
  /** True when we have a prior cursor and only fetch the delta. */
  incremental: boolean;
  since: string | null;
  /** User-facing one-liner for the hub. */
  summary: string;
}

/** A saved connection row (subset the planner needs). */
export interface PlannableConnection {
  status: string;                // connected | syncing | error | disconnected
  last_synced_at: string | null;
}

const has = (caps: SyncCapability[], r: SyncResource) => caps.some((c) => c.resource === r);

/**
 * Decide what a sync run should do — the deterministic core the sync worker and
 * the hub UI both call. Blocks cleanly (never throws) when the provider isn't
 * configured or the family hasn't connected it, and switches to incremental once
 * a prior sync cursor exists.
 */
export function planSync(
  adapter: SyncAdapter,
  connection: PlannableConnection | null,
  env?: NodeJS.ProcessEnv,
): SyncPlan {
  const base = { providerId: adapter.providerId, resources: adapter.capabilities };

  if (adapter.capabilities.length === 0) {
    return { ...base, runnable: false, blockedReason: 'unsupported', incremental: false, since: null,
      summary: 'This connection cannot sync yet.' };
  }
  if (!adapter.isConfigured(env)) {
    return { ...base, runnable: false, blockedReason: 'needs_setup', incremental: false, since: null,
      summary: `${adapter.providerId} needs to be set up before it can sync.` };
  }
  if (!connection || connection.status === 'disconnected') {
    return { ...base, runnable: false, blockedReason: 'not_connected', incremental: false, since: null,
      summary: 'Connect this account to start syncing.' };
  }

  const since = connection.last_synced_at ?? null;
  const incremental = since !== null;
  const verbs: string[] = [];
  if (has(adapter.capabilities, 'events')) verbs.push('calendar events');
  if (has(adapter.capabilities, 'messages')) verbs.push('email');
  if (has(adapter.capabilities, 'transactions')) verbs.push('transactions');
  const what = verbs.length ? verbs.join(' + ') : 'data';

  return {
    ...base,
    runnable: true,
    incremental,
    since,
    summary: incremental
      ? `Syncing ${what} changed since ${new Date(since!).toLocaleString()}.`
      : `First sync — importing your ${what}.`,
  };
}
