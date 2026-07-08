// Connections — the sync adapter registry (moat R9).
//
// Maps a provider id to its SyncAdapter. Adapters here are the *reference
// implementations of the contract*: they declare real capabilities and stay
// completely inert (no network calls, clean "not configured" results) until the
// owner-gated OAuth/provider keys exist — so the orchestration layer can be built
// and tested now, and each provider goes live the moment its key lands.

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

/** Every provider id that has a sync adapter (the rest are directory-only). */
export function syncableProviderIds(): string[] {
  return ADAPTERS.map((a) => a.providerId);
}

export { ADAPTERS };
