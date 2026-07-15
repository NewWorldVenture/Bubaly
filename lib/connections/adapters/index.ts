// Connections — the sync adapter registry (moat R9).
//
// Maps a provider id to its SyncAdapter. Planned adapters may be registered for
// contract tests, but the planner and execution methods must remain fail-closed
// until their provider implementation is live.

import type { SyncAdapter } from '../adapter';
import { googleCalendarAdapter } from './google-calendar';
import { gmailAdapter } from './gmail';

const ADAPTERS: SyncAdapter[] = [
  googleCalendarAdapter,
  gmailAdapter,
];

const BY_ID: Record<string, SyncAdapter> = Object.fromEntries(ADAPTERS.map((a) => [a.providerId, a]));

/** The adapter for a provider id, or null if none is registered yet. */
export function adapterFor(providerId: string): SyncAdapter | null {
  return BY_ID[providerId] ?? null;
}

/** Every provider id whose registered adapter is ready for real sync. */
export function syncableProviderIds(): string[] {
  return ADAPTERS.filter((a) => a.isImplemented).map((a) => a.providerId);
}

export { ADAPTERS };
