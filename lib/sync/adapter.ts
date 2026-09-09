// lib/sync/adapter.ts — the provider-agnostic two-way-sync CONTRACT (R9).
//
// The moat piece the strategy's Phase-4 (ecosystem orchestration) calls for:
// *"real two-way sync, not a directory."* Today `lib/sync/engine/google.ts` hard-
// wires Google's client into the pull/push/conflict/mapping loop. This contract
// abstracts everything provider-specific — OAuth, the calendar/task API calls, and
// the pure row mappers — behind ONE interface so a second provider (Microsoft,
// Apple/CalDAV…) plugs in without re-implementing the sync engine. The engine
// (`lib/sync/engine/generic.ts`) then drives ANY adapter through this surface.
//
// Pure types + a base error here; adapters live in lib/sync/providers/*, the
// registry in lib/sync/registry.ts. Network calls only fire once a provider's
// OAuth keys are configured (each adapter's `isConfigured()`), so this whole layer
// is safe to ship dark and lights up when the owner provisions keys (decision B3).

import type { SyncProviderEnum } from '@/lib/database.types';

/** OAuth token bundle every provider returns from code-exchange / refresh. */
export type OAuthTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // epoch ms
  scope?: string;
  tokenType?: string;
};

/** A provider calendar, normalized to what the engine needs to mirror it. */
export type NormalizedCalendar = {
  externalId: string;
  name: string;
  primary: boolean;
  timezone: string | null;
  color: string | null;
};

/** A provider task/reminder list, normalized. */
export type NormalizedTaskList = {
  externalId: string;
  name: string;
};

/** A provider event mapped to normalized row fields (matches sync_calendar_events). */
export type NormalizedEvent = {
  external_id: string;
  uid: string | null;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  recurrence_rule: string | null;
  status: string;
  etag: string | null;
  /** provider last-modified timestamp, for conflict tie-breaking */
  updated_at?: string | null;
  /** true when the provider reports this event deleted/cancelled */
  cancelled: boolean;
};

/** A provider task mapped to normalized reminder row fields (matches sync_reminders). */
export type NormalizedTask = {
  external_id: string;
  title: string;
  notes: string | null;
  due_at: string | null;
  is_completed: boolean;
  completed_at: string | null;
  updated_at?: string | null;
  deleted: boolean;
};

/** Result of an incremental event pull: the events + a cursor to persist. */
export type EventPullResult = {
  events: NormalizedEvent[];
  /** provider delta/sync cursor to store and pass back next run */
  nextCursor: string | null;
  /** true when the stored cursor expired and a full resync is required */
  expired: boolean;
};

/** Local row shapes the row→request mappers accept (subset the push path selects). */
export type LocalEventRow = {
  title: string; description?: string | null; location?: string | null;
  starts_at: string; ends_at?: string | null; all_day?: boolean;
  recurrence_rule?: string | null; timezone?: string | null;
};
export type LocalReminderRow = {
  title: string; notes?: string | null; due_at?: string | null; is_completed?: boolean;
};

/** A provider API error carrying the HTTP status so the engine can classify fatality. */
export class SyncApiError extends Error {
  constructor(public status: number, message: string, public body?: string) {
    super(message);
    this.name = 'SyncApiError';
  }
}

/**
 * The two-way-sync contract every provider implements. Grouped: identity, OAuth,
 * calendar API, task API, and the pure mappers/hashers. The engine calls ONLY
 * these methods — it never imports a provider module directly.
 */
export interface SyncProviderAdapter {
  // ── identity ──────────────────────────────────────────────────────────────
  /** The `sync_provider` enum value this adapter writes as (google | microsoft…). */
  readonly provider: SyncProviderEnum;
  /** Human label for the UI / logs. */
  readonly label: string;
  /** True only when this provider's OAuth client keys are configured server-side. */
  isConfigured(): boolean;

  // ── OAuth ─────────────────────────────────────────────────────────────────
  authUrl(redirectUri: string, state: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens>;
  refreshAccessToken(refreshToken: string): Promise<OAuthTokens>;
  revokeToken(token: string): Promise<void>;
  /** The connected account's identity (email/id) — becomes the account external_id. */
  getAccountIdentity(accessToken: string): Promise<string | null>;

  // ── calendar API ──────────────────────────────────────────────────────────
  listCalendars(accessToken: string): Promise<NormalizedCalendar[]>;
  pullEvents(accessToken: string, calendarExternalId: string, cursor: string | null): Promise<EventPullResult>;
  /** Complete bounded view with recurring occurrences expanded. Used by onboarding. */
  pullCalendarWindow?(accessToken: string, calendarExternalId: string, from: string, to: string): Promise<NormalizedEvent[]>;
  insertEvent(accessToken: string, calendarExternalId: string, body: Record<string, unknown>): Promise<{ id: string; etag: string | null }>;
  patchEvent(accessToken: string, calendarExternalId: string, eventExternalId: string, body: Record<string, unknown>): Promise<{ id: string; etag: string | null }>;
  deleteEvent(accessToken: string, calendarExternalId: string, eventExternalId: string): Promise<void>;

  // ── task / reminder API ───────────────────────────────────────────────────
  /** The default list the engine syncs reminders against (e.g. Google '@default'). */
  defaultTaskListId(accessToken: string): Promise<string | null>;
  listTasks(accessToken: string, listExternalId: string): Promise<NormalizedTask[]>;
  insertTask(accessToken: string, listExternalId: string, body: Record<string, unknown>): Promise<{ id: string }>;
  patchTask(accessToken: string, listExternalId: string, taskExternalId: string, body: Record<string, unknown>): Promise<void>;
  deleteTask(accessToken: string, listExternalId: string, taskExternalId: string): Promise<void>;

  // ── pure mappers + hashing (unit-testable; no network) ──────────────────────
  rowToEventBody(row: LocalEventRow): Record<string, unknown>;
  rowToTaskBody(row: LocalReminderRow): Record<string, unknown>;
  eventContentHash(row: LocalEventRow): string;
  reminderContentHash(row: LocalReminderRow): string;
}

/** The subset of contract methods that must exist for the engine to run a provider. */
export const REQUIRED_ADAPTER_METHODS = [
  'isConfigured', 'authUrl', 'exchangeCode', 'refreshAccessToken', 'revokeToken', 'getAccountIdentity',
  'listCalendars', 'pullEvents', 'insertEvent', 'patchEvent', 'deleteEvent',
  'defaultTaskListId', 'listTasks', 'insertTask', 'patchTask', 'deleteTask',
  'rowToEventBody', 'rowToTaskBody', 'eventContentHash', 'reminderContentHash',
] as const;
